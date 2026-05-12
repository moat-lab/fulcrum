/**
 * Agent channel exchange heartbeat service (issue #180 / parent #153).
 *
 * Drives the fulcrum-server-owned half of the dual heartbeat:
 *
 * - 30s ping interval (`body.kind = "heartbeat.ping"`) per registered
 *   fulcrum-client mailbox bound to a terminal.
 * - 3 consecutive misses (≈90s) → reRegister via exchange `POST /v1/register`,
 *   matching the exchange-side 3-miss deregister window.
 * - `restoreChannelsFromDatabase()` reconciles `terminals.channel_id` non-null
 *   rows on server startup so dtach-persisted claude sessions keep their
 *   mailbox without manual intervention.
 *
 * Out of scope for fulcrum: MCP-child-owned mailbox heartbeat (lives inside
 * `@agent-channel/mcp`; claude death → MCP-child death → exchange-side
 * deregister handles that path).
 */

import { eq, isNotNull } from 'drizzle-orm'
import { db, terminals } from '../db'
import { log } from '../lib/logger'
import { getFnoxValue } from '../lib/settings/fnox'

export const HEARTBEAT_INTERVAL_MS = 30_000
export const HEARTBEAT_MAX_MISSES = 3

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
  /** Terminal row id; the row is updated with the assigned `channelId` + ISO timestamp. */
  terminalId: string
  /** Optional override of the configured exchange URL (used by tests). */
  exchangeUrl?: string
  /** Optional override of the configured exchange token. */
  exchangeToken?: string
  /** Optional override of the configured mailbox namespace. */
  mailboxNamespace?: string
}

export interface RegisterResult {
  channelId: string
  registeredAt: string
  heartbeat: { intervalSeconds: number; timeoutSeconds: number }
}

interface VersionResponse {
  /** Exchange wire schema major version. fulcrum surfaces incompatibility to the UI rather than continuing silently (#153). */
  schemaVersion: string
}

type FetchLike = typeof fetch

let _fetch: FetchLike = globalThis.fetch.bind(globalThis)

/** Test seam — replace the underlying fetch used for exchange HTTP. */
export function _setFetchForTests(f: FetchLike | null): void {
  _fetch = f ?? globalThis.fetch.bind(globalThis)
}

const SUPPORTED_SCHEMA_MAJOR = '1'

function isSchemaCompatible(serverVersion: string): boolean {
  const major = serverVersion.split('.')[0]
  return major === SUPPORTED_SCHEMA_MAJOR
}

async function exchangeFetch(
  url: string,
  path: string,
  token: string,
  body: unknown,
): Promise<Response> {
  const baseUrl = url.endsWith('/') ? url.slice(0, -1) : url
  return _fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  })
}

export async function probeExchangeVersion(url: string, token: string): Promise<VersionResponse> {
  const baseUrl = url.endsWith('/') ? url.slice(0, -1) : url
  const res = await _fetch(`${baseUrl}/version`, {
    method: 'GET',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) {
    throw new Error(`exchange /version returned ${res.status}`)
  }
  const data = (await res.json()) as Partial<VersionResponse>
  if (typeof data.schemaVersion !== 'string') {
    throw new Error('exchange /version response missing schemaVersion')
  }
  if (!isSchemaCompatible(data.schemaVersion)) {
    throw new Error(`exchange schema_version ${data.schemaVersion} incompatible with fulcrum ${SUPPORTED_SCHEMA_MAJOR}.x`)
  }
  return { schemaVersion: data.schemaVersion }
}

export interface TestConnectionResult {
  ok: boolean
  schemaVersion?: string
  error?: string
}

export async function testExchangeConnection(args?: { url?: string; token?: string }): Promise<TestConnectionResult> {
  const cfg = readExchangeConfig()
  const url = args?.url ?? cfg.url
  const token = args?.token ?? cfg.token
  if (!url) return { ok: false, error: 'exchange URL not configured' }
  try {
    const v = await probeExchangeVersion(url, token)
    return { ok: true, schemaVersion: v.schemaVersion }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

interface ExchangeRegisterResponse {
  channelId: string
  registeredAt: string
  heartbeat?: { intervalSeconds?: number; timeoutSeconds?: number }
}

export async function registerChannel(args: RegisterArgs): Promise<RegisterResult> {
  const cfg = readExchangeConfig()
  const url = args.exchangeUrl ?? cfg.url
  const token = args.exchangeToken ?? cfg.token
  const mailbox = args.mailboxNamespace ?? cfg.mailbox

  if (!url) throw new Error('exchange URL not configured')
  if (!mailbox) throw new Error('exchange mailbox not configured')

  // Compat-window probe per #153 — surface incompatibility before we ever
  // issue a register, instead of letting the client silently drift.
  await probeExchangeVersion(url, token)

  const desiredChannelId = `${mailbox}/task-${args.taskId}`
  const res = await exchangeFetch(url, '/v1/register', token, {
    desired_channel_id: desiredChannelId,
    capabilities: ['channel.send', 'channel.list_channels'],
    identity: { agent_kind: 'fulcrum-client', instance_label: mailbox },
  })
  if (!res.ok) {
    throw new Error(`exchange /v1/register returned ${res.status}`)
  }
  const data = (await res.json()) as ExchangeRegisterResponse
  if (!data.channelId) throw new Error('exchange /v1/register response missing channelId')

  const registeredAt = data.registeredAt ?? new Date().toISOString()
  db.update(terminals)
    .set({ channelId: data.channelId, channelRegisteredAt: registeredAt, updatedAt: registeredAt })
    .where(eq(terminals.id, args.terminalId))
    .run()

  return {
    channelId: data.channelId,
    registeredAt,
    heartbeat: {
      intervalSeconds: data.heartbeat?.intervalSeconds ?? HEARTBEAT_INTERVAL_MS / 1000,
      timeoutSeconds: data.heartbeat?.timeoutSeconds ?? (HEARTBEAT_INTERVAL_MS * HEARTBEAT_MAX_MISSES) / 1000,
    },
  }
}

interface TrackedChannel {
  terminalId: string
  channelId: string
  consecutiveMisses: number
}

const tracked = new Map<string, TrackedChannel>()
let heartbeatTimer: ReturnType<typeof setInterval> | null = null

async function sendHeartbeatPing(url: string, token: string, channelId: string): Promise<boolean> {
  try {
    const res = await exchangeFetch(url, '/v1/envelope', token, {
      from: channelId,
      to: 'exchange',
      ts: new Date().toISOString(),
      schema_version: `${SUPPORTED_SCHEMA_MAJOR}.0`,
      body: { kind: 'heartbeat.ping' },
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
  // original register. If the terminal isn't task-bound we fall back to its
  // raw id; exchange will append `#2`/`#3` when colliding.
  const taskId = row.name?.startsWith('task-') ? row.name.slice('task-'.length) : row.id
  try {
    return await registerChannel({ taskId, terminalId })
  } catch (err) {
    log.server.warn('channel re-register failed', { terminalId, error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

async function heartbeatTick(): Promise<void> {
  const cfg = readExchangeConfig()
  if (!cfg.enabled || !cfg.url) return
  for (const entry of tracked.values()) {
    const ok = await sendHeartbeatPing(cfg.url, cfg.token, entry.channelId)
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
        }
      }
    }
  }
}

export function trackChannel(terminalId: string, channelId: string): void {
  tracked.set(terminalId, { terminalId, channelId, consecutiveMisses: 0 })
}

export function untrackChannel(terminalId: string): void {
  tracked.delete(terminalId)
}

export function startChannelHeartbeat(): void {
  if (heartbeatTimer) return
  const cfg = readExchangeConfig()
  if (!cfg.enabled) return
  heartbeatTimer = setInterval(() => {
    heartbeatTick().catch((err) => {
      log.server.error('channel heartbeat tick error', { error: err instanceof Error ? err.message : String(err) })
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
