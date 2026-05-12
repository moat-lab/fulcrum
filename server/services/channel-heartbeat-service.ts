/**
 * Agent channel exchange heartbeat service (issue #180 / parent #153).
 *
 * Owns the fulcrum-server side of the dual heartbeat against the
 * `agent-channel-exchange` HTTP server:
 *
 * - `probeExchangeVersion` / `testExchangeConnection` — GET /version to surface
 *   schema_version skew in the Settings UI before any register attempt.
 * - `registerChannel` — POST /v1/register with a full wire envelope
 *   (`body.kind = "register.request"`), parse the envelope response, and
 *   persist the assigned `channel_id` onto the `terminals` row.
 * - `startChannelHeartbeat` — every 30s POST /v1/envelope with a
 *   `heartbeat.ping` envelope and the `X-Agent-Channel-Sender` header
 *   set to the channel_id; 3 consecutive misses trigger reRegister to
 *   match the exchange-side 90s deregister window.
 * - `restoreChannelsFromDatabase` — server startup reconcile so dtach-persisted
 *   claude sessions keep their mailbox without manual intervention.
 *
 * Wire shapes are validated end-to-end by the exchange runtime
 * (typebox JSON Schema in `@agent-channel/protocol`). This file matches that
 * contract exactly: any divergence is rejected by the exchange and surfaced
 * in fulcrum logs / Settings UI rather than silently dropped.
 */

import { eq, isNotNull } from 'drizzle-orm'
import { db, terminals } from '../db'
import { log } from '../lib/logger'
import { getFnoxValue } from '../lib/settings/fnox'

export const HEARTBEAT_INTERVAL_MS = 30_000
export const HEARTBEAT_MAX_MISSES = 3

/**
 * Exchange wire schema we speak. The exchange enforces strict equality
 * on this value (see `agent-channel-exchange/packages/exchange/src/router.ts`),
 * so any drift here surfaces as `schema_version_incompatible` on the wire.
 */
export const EXCHANGE_SCHEMA_VERSION = '0.1.0'
const EXCHANGE_SYSTEM_CHANNEL = 'exchange/system'
const SENDER_HEADER = 'x-agent-channel-sender'

const FULCRUM_CAPABILITIES = ['channel.send', 'channel.receive', 'discovery.list'] as const

interface ExchangeConfig {
  enabled: boolean
  url: string
  token: string
  mailbox: string
  mcpGitRef: string
}

function readExchangeConfig(): ExchangeConfig {
  return {
    enabled: (getFnoxValue('channels.exchange.enabled') as boolean | null) ?? false,
    url: (getFnoxValue('channels.exchange.url') as string | null) ?? '',
    token: (getFnoxValue('channels.exchange.token') as string | null) ?? '',
    mailbox: (getFnoxValue('channels.exchange.mailbox') as string | null) ?? '',
    mcpGitRef: (getFnoxValue('channels.exchange.mcpGitRef') as string | null) ?? '',
  }
}

export interface RegisterArgs {
  /** Logical fulcrum task id (used to compose `<mailbox>/task-<id>` per #153 §Channel-id 形态). */
  taskId: string
  /** Terminal row id; the row is updated with the assigned `channel_id` + ISO timestamp. */
  terminalId: string
  /** Optional override of the configured exchange URL (used by tests). */
  exchangeUrl?: string
  /** Optional override of the configured mailbox namespace. */
  mailboxNamespace?: string
}

export interface RegisterResult {
  channelId: string
  registeredAt: string
  heartbeat: { intervalSeconds: number; timeoutSeconds: number }
}

interface VersionResponse {
  schemaVersion: string
}

type FetchLike = typeof fetch

let _fetch: FetchLike = globalThis.fetch.bind(globalThis)

/** Test seam — replace the underlying fetch used for exchange HTTP. */
export function _setFetchForTests(f: FetchLike | null): void {
  _fetch = f ?? globalThis.fetch.bind(globalThis)
}

function isSchemaCompatible(serverVersion: string): boolean {
  // The exchange protocol is pre-1.0; until 1.0 lands, breaking changes can
  // ride any minor bump. Require exact major.minor match (current = "0.1").
  return serverVersion === EXCHANGE_SCHEMA_VERSION
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

export async function probeExchangeVersion(url: string): Promise<VersionResponse> {
  const baseUrl = buildBaseUrl(url)
  const res = await _fetch(`${baseUrl}/version`, { method: 'GET' })
  if (!res.ok) {
    throw new Error(`exchange /version returned ${res.status}`)
  }
  const data = (await res.json()) as { schema_version?: unknown }
  if (typeof data.schema_version !== 'string') {
    throw new Error('exchange /version response missing schema_version')
  }
  if (!isSchemaCompatible(data.schema_version)) {
    throw new Error(
      `exchange schema_version ${data.schema_version} incompatible with fulcrum ${EXCHANGE_SCHEMA_VERSION}`,
    )
  }
  return { schemaVersion: data.schema_version }
}

export interface TestConnectionResult {
  ok: boolean
  schemaVersion?: string
  error?: string
}

export async function testExchangeConnection(args?: { url?: string }): Promise<TestConnectionResult> {
  const cfg = readExchangeConfig()
  const url = args?.url ?? cfg.url
  if (!url) return { ok: false, error: 'exchange URL not configured' }
  try {
    const v = await probeExchangeVersion(url)
    return { ok: true, schemaVersion: v.schemaVersion }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

interface RegisterResponsePayload {
  channel_id: string
  registered_at: string
  heartbeat: { interval_seconds: number; timeout_seconds: number }
  delivery_endpoint: string
  schema_version: string
}

interface RegisterResponseEnvelope {
  msg_id: string
  from: string
  to: string
  ts: string
  schema_version: string
  body: { kind: string; payload: RegisterResponsePayload }
}

export async function registerChannel(args: RegisterArgs): Promise<RegisterResult> {
  const cfg = readExchangeConfig()
  const url = args.exchangeUrl ?? cfg.url
  const mailbox = args.mailboxNamespace ?? cfg.mailbox

  if (!url) throw new Error('exchange URL not configured')
  if (!mailbox) throw new Error('exchange mailbox not configured')

  // Compat-window probe per #153 — surface incompatibility before any register.
  await probeExchangeVersion(url)

  const desiredChannelId = `${mailbox}/task-${args.taskId}`
  const ts = nowIso()
  const envelope = {
    msg_id: newMsgId(),
    from: desiredChannelId,
    to: EXCHANGE_SYSTEM_CHANNEL,
    ts,
    schema_version: EXCHANGE_SCHEMA_VERSION,
    body: {
      kind: 'register.request',
      payload: {
        schema_version: EXCHANGE_SCHEMA_VERSION,
        desired_channel_id: desiredChannelId,
        capabilities: FULCRUM_CAPABILITIES,
        identity: {
          agent_kind: 'fulcrum-client',
          instance_label: mailbox,
        },
      },
    },
  }
  const res = await _fetch(`${buildBaseUrl(url)}/v1/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`exchange /v1/register returned ${res.status}${text ? ` ${text}` : ''}`)
  }
  const data = (await res.json()) as Partial<RegisterResponseEnvelope>
  if (!data?.body || data.body.kind !== 'register.response' || !data.body.payload) {
    throw new Error('exchange /v1/register response shape invalid')
  }
  const payload = data.body.payload
  if (typeof payload.channel_id !== 'string' || typeof payload.registered_at !== 'string') {
    throw new Error('exchange /v1/register response missing channel_id or registered_at')
  }

  db.update(terminals)
    .set({
      channelId: payload.channel_id,
      channelRegisteredAt: payload.registered_at,
      updatedAt: payload.registered_at,
    })
    .where(eq(terminals.id, args.terminalId))
    .run()

  return {
    channelId: payload.channel_id,
    registeredAt: payload.registered_at,
    heartbeat: {
      intervalSeconds: payload.heartbeat?.interval_seconds ?? HEARTBEAT_INTERVAL_MS / 1000,
      timeoutSeconds:
        payload.heartbeat?.timeout_seconds ?? (HEARTBEAT_INTERVAL_MS * HEARTBEAT_MAX_MISSES) / 1000,
    },
  }
}

interface TrackedChannel {
  terminalId: string
  channelId: string
  consecutiveMisses: number
  sequence: number
}

const tracked = new Map<string, TrackedChannel>()
let heartbeatTimer: ReturnType<typeof setInterval> | null = null

async function sendHeartbeatPing(
  url: string,
  channelId: string,
  sequence: number,
): Promise<boolean> {
  try {
    const envelope = {
      msg_id: newMsgId(),
      from: channelId,
      to: EXCHANGE_SYSTEM_CHANNEL,
      ts: nowIso(),
      schema_version: EXCHANGE_SCHEMA_VERSION,
      body: {
        kind: 'heartbeat.ping',
        payload: { channel_id: channelId, sequence },
      },
    }
    const res = await _fetch(`${buildBaseUrl(url)}/v1/envelope`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [SENDER_HEADER]: channelId,
      },
      body: JSON.stringify(envelope),
    })
    return res.ok
  } catch {
    return false
  }
}

export async function reRegister(terminalId: string): Promise<RegisterResult | null> {
  const row = db
    .select({ id: terminals.id, name: terminals.name })
    .from(terminals)
    .where(eq(terminals.id, terminalId))
    .all()[0]
  if (!row) return null
  // Compose taskId from the terminal name (`task-<id>` convention) so the
  // reRegister envelope's `desired_channel_id` keeps the same shape as the
  // original register.
  const taskId = row.name?.startsWith('task-') ? row.name.slice('task-'.length) : row.id
  try {
    return await registerChannel({ taskId, terminalId })
  } catch (err) {
    log.server.warn('channel re-register failed', {
      terminalId,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

async function heartbeatTick(): Promise<void> {
  const cfg = readExchangeConfig()
  if (!cfg.enabled || !cfg.url) return
  for (const entry of tracked.values()) {
    entry.sequence += 1
    const ok = await sendHeartbeatPing(cfg.url, entry.channelId, entry.sequence)
    if (ok) {
      entry.consecutiveMisses = 0
    } else {
      entry.consecutiveMisses += 1
      if (entry.consecutiveMisses >= HEARTBEAT_MAX_MISSES) {
        log.server.info('channel heartbeat missed 3x, re-registering', {
          terminalId: entry.terminalId,
          previousChannelId: entry.channelId,
        })
        const result = await reRegister(entry.terminalId)
        if (result) {
          entry.channelId = result.channelId
          entry.consecutiveMisses = 0
          entry.sequence = 0
        }
      }
    }
  }
}

export function trackChannel(terminalId: string, channelId: string): void {
  tracked.set(terminalId, { terminalId, channelId, consecutiveMisses: 0, sequence: 0 })
}

export function untrackChannel(terminalId: string): void {
  tracked.delete(terminalId)
}

export function startChannelHeartbeat(): void {
  if (heartbeatTimer) return
  // Always run the timer — per-tick `heartbeatTick` short-circuits when
  // `channels.exchange.enabled` is false or no channels are tracked. This
  // lets the user enable the exchange at runtime via Settings without
  // having to restart the server to wake up the heartbeat loop.
  heartbeatTimer = setInterval(() => {
    heartbeatTick().catch((err) => {
      log.server.error('channel heartbeat tick error', {
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }, HEARTBEAT_INTERVAL_MS)
}

export function stopChannelHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

/**
 * Server-restart reconcile per #153 §Server 重启恢复. Walks every terminal row
 * with a non-null `channelId` and re-registers it best-effort. Failures are
 * logged but do not block server startup — the next heartbeat tick will retry.
 */
export async function restoreChannelsFromDatabase(): Promise<void> {
  const cfg = readExchangeConfig()
  if (!cfg.enabled || !cfg.url) return

  const rows = db
    .select({ id: terminals.id, channelId: terminals.channelId })
    .from(terminals)
    .where(isNotNull(terminals.channelId))
    .all()

  if (rows.length === 0) return
  log.server.info('Reconciling channel mailboxes from database', { count: rows.length })

  for (const row of rows) {
    if (!row.channelId) continue
    const result = await reRegister(row.id)
    if (result) {
      trackChannel(row.id, result.channelId)
    }
  }
}

/** Snapshot of internal state for tests / debug. */
export function _getTrackedSnapshot(): TrackedChannel[] {
  return Array.from(tracked.values()).map((t) => ({ ...t }))
}

/** Reset internal state (used by tests). */
export function _resetForTests(): void {
  tracked.clear()
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}
