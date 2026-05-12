/**
 * PM Agent Mode chat hook + mailbox status poller (issue #181 / parent #153
 * §Chat 启动 UX hook).
 *
 * Two concerns live here because they share the same fnox config and lifecycle:
 *
 * - `readPmModeHook()` — pure config read returning the `PmModeChatHook` shape
 *   exposed by `GET /api/channels/pm/mode`. Chat surface (or any future PM
 *   launcher embed) reads this once at session start to decide whether to
 *   attach `@agent-channel/mcp` as a Claude MCP child (`clientForm = "claude-mcp"`)
 *   or assume an external HTTP PM is independently online (`clientForm = "external-http"`).
 *
 * - `startPmMailboxPoller` — periodic `POST /v1/discovery/list` against the
 *   exchange with `filter.agent_kind = ["pm-agent"]`. The cached snapshot
 *   feeds `GET /api/channels/pm/mailboxes` for the Settings UI online-status
 *   display. Per #153 §822-824 fulcrum never spawns a PM process; this poller
 *   only observes the exchange registry.
 *
 * Both code paths short-circuit when `channels.pm.enabled` is false so the
 * poller is safe to leave running unconditionally (matches the heartbeat
 * service convention from #180).
 */

import { log } from '../lib/logger'
import { getFnoxValue } from '../lib/settings/fnox'
import { EXCHANGE_SCHEMA_VERSION } from './channel-heartbeat-service'

export type PmClientForm = 'claude-mcp' | 'external-http'

export interface PmModeChatHook {
  enabled: boolean
  clientForm: PmClientForm
  mailbox: string
  systemPromptRef: string
  exchange: {
    url: string
    mailboxNamespace: string
  }
}

export interface PmMailboxDescriptor {
  channelId: string
  agentKind: string
  instanceLabel?: string
  registeredAt: string
}

export interface PmMailboxesSnapshot {
  generatedAt: string | null
  channels: PmMailboxDescriptor[]
  lastError: string | null
}

const DEFAULT_CLIENT_FORM: PmClientForm = 'claude-mcp'
const POLL_INTERVAL_MS = 30_000
const EXCHANGE_SYSTEM_CHANNEL = 'exchange/system'
const SENDER_HEADER = 'x-agent-channel-sender'

function isPmClientForm(value: unknown): value is PmClientForm {
  return value === 'claude-mcp' || value === 'external-http'
}

function readPmConfig() {
  const rawClientForm = getFnoxValue('channels.pm.clientForm')
  return {
    enabled: (getFnoxValue('channels.pm.enabled') as boolean | null) ?? false,
    clientForm: isPmClientForm(rawClientForm) ? rawClientForm : DEFAULT_CLIENT_FORM,
    mailbox: (getFnoxValue('channels.pm.mailbox') as string | null) ?? '',
    systemPromptRef: (getFnoxValue('channels.pm.systemPromptRef') as string | null) ?? '',
  }
}

function readExchangeConfig() {
  return {
    url: (getFnoxValue('channels.exchange.url') as string | null) ?? '',
    mailbox: (getFnoxValue('channels.exchange.mailbox') as string | null) ?? '',
  }
}

/**
 * Pure read of the PM mode hook shape from fnox. Tokens are never returned —
 * the exchange bearer token lives only in `channels.exchange.token` and is
 * read by the PM launcher (Claude MCP form: by MCP child via env; HTTP form:
 * by the external PM process). See #153 §824.
 */
export function readPmModeHook(): PmModeChatHook {
  const pm = readPmConfig()
  const exchange = readExchangeConfig()
  return {
    enabled: pm.enabled,
    clientForm: pm.clientForm,
    mailbox: pm.mailbox,
    systemPromptRef: pm.systemPromptRef,
    exchange: {
      url: exchange.url,
      mailboxNamespace: exchange.mailbox,
    },
  }
}

// --- Mailbox poller ---

type FetchLike = typeof fetch

let _fetch: FetchLike = globalThis.fetch.bind(globalThis)
let pollerTimer: ReturnType<typeof setInterval> | null = null
let snapshot: PmMailboxesSnapshot = { generatedAt: null, channels: [], lastError: null }

/** Test seam — replace the underlying fetch used for discovery polling. */
export function _setFetchForTests(f: FetchLike | null): void {
  _fetch = f ?? globalThis.fetch.bind(globalThis)
}

export function _resetForTests(): void {
  snapshot = { generatedAt: null, channels: [], lastError: null }
  if (pollerTimer) {
    clearInterval(pollerTimer)
    pollerTimer = null
  }
}

export function getPmMailboxesSnapshot(): PmMailboxesSnapshot {
  return { ...snapshot, channels: snapshot.channels.slice() }
}

function buildBaseUrl(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url
}

function newMsgId(): string {
  return crypto.randomUUID()
}

function nowIso(): string {
  return new Date().toISOString()
}

interface DiscoveryChannelDescriptor {
  channel_id?: string
  agent_kind?: string
  instance_label?: string
  registered_at?: string
}

interface DiscoveryListResponseEnvelope {
  body?: {
    kind?: string
    payload?: {
      channels?: DiscoveryChannelDescriptor[]
      generated_at?: string
    }
  }
}

async function ensurePollerRegistered(url: string, sender: string): Promise<void> {
  const envelope = {
    msg_id: newMsgId(),
    from: sender,
    to: EXCHANGE_SYSTEM_CHANNEL,
    ts: nowIso(),
    schema_version: EXCHANGE_SCHEMA_VERSION,
    body: {
      kind: 'register.request',
      payload: {
        schema_version: EXCHANGE_SCHEMA_VERSION,
        desired_channel_id: sender,
        capabilities: ['discovery.list'],
        identity: {
          agent_kind: 'fulcrum-client',
          instance_label: 'pm-mode-poller',
        },
      },
    },
  }
  await _fetch(`${buildBaseUrl(url)}/v1/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
  })
  // 409 (already registered) is fine and expected on subsequent ticks; we
  // do not check status because the next discovery POST is the real probe.
}

/**
 * Single discovery sweep. Polls the exchange for currently-registered PM
 * mailboxes. The poller registers a lightweight fulcrum-client mailbox
 * `${exchange.mailbox}/pm-mode-poller` on first use because the exchange
 * requires a registered sender for `POST /v1/discovery/list`; this mailbox
 * is observe-only (`capabilities: ["discovery.list"]`) and does not change
 * the boundary in #153 §824 — fulcrum still does not spawn or hold the PM
 * agent process.
 */
export async function pollPmMailboxes(): Promise<PmMailboxesSnapshot> {
  const pm = readPmConfig()
  const exchange = readExchangeConfig()

  if (!pm.enabled) {
    snapshot = { generatedAt: null, channels: [], lastError: null }
    return getPmMailboxesSnapshot()
  }
  if (!exchange.url) {
    snapshot = { generatedAt: null, channels: [], lastError: 'exchange URL not configured' }
    return getPmMailboxesSnapshot()
  }
  if (!exchange.mailbox) {
    snapshot = {
      generatedAt: null,
      channels: [],
      lastError: 'exchange mailbox not configured (fulcrum-client identity required for discovery sender)',
    }
    return getPmMailboxesSnapshot()
  }

  const sender = `${exchange.mailbox}/pm-mode-poller`
  await ensurePollerRegistered(exchange.url, sender).catch(() => {
    /* register is best-effort; if already registered exchange returns 409 */
  })
  const envelope = {
    msg_id: newMsgId(),
    from: sender,
    to: EXCHANGE_SYSTEM_CHANNEL,
    ts: nowIso(),
    schema_version: EXCHANGE_SCHEMA_VERSION,
    body: {
      kind: 'discovery.list_request',
      payload: {
        filter: { agent_kind: ['pm-agent'] },
      },
    },
  }

  try {
    const res = await _fetch(`${buildBaseUrl(exchange.url)}/v1/discovery/list`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [SENDER_HEADER]: sender,
      },
      body: JSON.stringify(envelope),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      snapshot = {
        generatedAt: null,
        channels: [],
        lastError: `discovery returned ${res.status}${text ? ` ${text}` : ''}`,
      }
      return getPmMailboxesSnapshot()
    }
    const data = (await res.json()) as Partial<DiscoveryListResponseEnvelope>
    if (data?.body?.kind !== 'discovery.list_response' || !data.body.payload) {
      snapshot = {
        generatedAt: null,
        channels: [],
        lastError: 'discovery response shape invalid',
      }
      return getPmMailboxesSnapshot()
    }
    const payload = data.body.payload
    const channels: PmMailboxDescriptor[] = (payload.channels ?? [])
      .filter((c): c is Required<Pick<DiscoveryChannelDescriptor, 'channel_id' | 'agent_kind' | 'registered_at'>> & DiscoveryChannelDescriptor =>
        typeof c.channel_id === 'string' &&
        typeof c.agent_kind === 'string' &&
        typeof c.registered_at === 'string',
      )
      .map((c) => ({
        channelId: c.channel_id,
        agentKind: c.agent_kind,
        instanceLabel: c.instance_label,
        registeredAt: c.registered_at,
      }))
    snapshot = {
      generatedAt: payload.generated_at ?? nowIso(),
      channels,
      lastError: null,
    }
    return getPmMailboxesSnapshot()
  } catch (err) {
    snapshot = {
      generatedAt: null,
      channels: [],
      lastError: err instanceof Error ? err.message : String(err),
    }
    return getPmMailboxesSnapshot()
  }
}

export function startPmMailboxPoller(): void {
  if (pollerTimer) return
  // Like the heartbeat service, always run the timer — `pollPmMailboxes`
  // short-circuits when disabled so the user can toggle PM mode in Settings
  // without a server restart.
  pollerTimer = setInterval(() => {
    pollPmMailboxes().catch((err) => {
      log.server.error('pm mailbox poll tick error', {
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }, POLL_INTERVAL_MS)
}

export function stopPmMailboxPoller(): void {
  if (pollerTimer) {
    clearInterval(pollerTimer)
    pollerTimer = null
  }
}
