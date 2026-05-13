/**
 * Agent-channel exchange task-launch preparation (issue #193 / parent #192).
 *
 * Owns the fulcrum-server side of wiring a `claude --mcp-config <path>` flag
 * for a UI-started task so the spawned `claude` process fork-execs the
 * `@agent-channel/mcp` stdio child for this terminal's mailbox.
 *
 * # Why this exists separately from `channel-heartbeat-service.ts`
 *
 * Wave-1 (#180/#181) shipped `POST /api/channels/register` + `--channels
 * server:"<cmd>"` injection. The `--channels` flag does not exist in `claude
 * --help` (spike evidence under `.coder-loop/runtime/evidence/issue-193/`),
 * and the wave-1 register-then-MCP-child-register path double-registers the
 * same `desired_channel_id` against the exchange.
 *
 * This module rewrites that: fulcrum-server does NOT issue `POST /v1/register`
 * for task-terminal launches. Instead it:
 *
 *  1. composes `desired_channel_id = ${mailbox}/task-${taskId}` from fnox,
 *  2. writes that value to `terminals.channel_id` optimistically so
 *     `acceptance #5` (envelope `from` = `terminals.channel_id`) holds,
 *  3. writes a `--mcp-config` JSON file at
 *     `${FULCRUM_DIR}/runtime/mcp-configs/${terminalId}.json` (0600)
 *     embedding the env contract documented in
 *     `agent-channel-exchange/packages/mcp/src/config.ts`,
 *  4. returns `{ channelId, mcpConfigPath }` for the frontend to feed into
 *     `buildAgentCommand({channel: ...})`.
 *
 * The MCP child performs the actual exchange register at boot using the env
 * vars; the exchange grants the desired id when free (acceptance #5 design
 * assumption).
 *
 * # Why a temp file instead of inline JSON
 *
 * `claude --mcp-config` accepts both file paths and JSON literals, but the
 * literal form would put the exchange bearer token on the command line where
 * `ps auxe` could read it. A 0600 file under FULCRUM_DIR keeps the token
 * readable only by the fulcrum user and never reaches the dtach-attached
 * terminal stdin.
 *
 * # mcpGitRef interpretation (this iteration)
 *
 * The Settings UI exposes `channels.exchange.mcpGitRef` (originally intended
 * as a `bunx --bun github:...#<ref> agent-channel-mcp` reference). Because
 * `@agent-channel/mcp` is an unpublished workspace package and bunx-from-git
 * is unreliable offline, this iteration accepts EITHER:
 *
 *  - an absolute path (starts with `/`) — used as the `bin.ts` location,
 *    invoked via `bun run <path>`;
 *  - any other non-empty value — treated as a forward-compat git ref hint and
 *    rejected here with a clear error pointing the user at the absolute-path
 *    contract until git-ref-mode lands.
 *
 * Empty `mcpGitRef` is a hard error: the launch cannot proceed without a
 * concrete MCP child to spawn.
 */

import { writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { eq } from 'drizzle-orm'
import { db, terminals } from '../db'
import { getFnoxValue } from '../lib/settings/fnox'
import { getFulcrumDir } from '../lib/settings/paths'

const CAPABILITIES = 'channel.send,channel.receive,discovery.list' as const
/** Single MCP server name registered into claude's `mcpServers` map. */
export const MCP_SERVER_NAME = 'agent-channel' as const

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

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url
}

export interface McpCommandSpec {
  command: string
  args: string[]
}

/**
 * Resolve how to invoke `@agent-channel/mcp` from a fnox `mcpGitRef` value.
 *
 * See module-level doc for the local-path / git-ref interpretation. Throws
 * with a precise message that the caller surfaces to the UI/logs.
 */
export function resolveMcpCommand(mcpGitRef: string): McpCommandSpec {
  if (!mcpGitRef) {
    throw new Error(
      'channels.exchange.mcpGitRef is empty; set it to the absolute path of @agent-channel/mcp bin.ts',
    )
  }
  if (!isAbsolute(mcpGitRef)) {
    throw new Error(
      `channels.exchange.mcpGitRef=${mcpGitRef} must be an absolute filesystem path to bin.ts; git-ref-mode is not yet implemented`,
    )
  }
  return { command: 'bun', args: ['run', mcpGitRef] }
}

export interface McpConfigArgs {
  exchangeUrl: string
  bearerToken: string
  desiredChannelId: string
  instanceLabel: string
  mcp: McpCommandSpec
}

/**
 * Build the `mcpServers` JSON object that `claude --mcp-config` consumes.
 * The env keys mirror `agent-channel-exchange/packages/mcp/src/config.ts`:
 *
 *  - `AGENT_CHANNEL_EXCHANGE_URL` — required base URL of the exchange
 *  - `AGENT_CHANNEL_AGENT_KIND` — `fulcrum-client` (must match exchange protocol AGENT_KINDS)
 *  - `AGENT_CHANNEL_INSTANCE_LABEL` — required, used by the exchange for `identity.instance_label`
 *  - `AGENT_CHANNEL_DESIRED_ID` — sets `desired_channel_id` on register so the
 *    MCP child gets back exactly `terminals.channel_id`
 *  - `AGENT_CHANNEL_CAPABILITIES` — `channel.send,channel.receive,discovery.list`
 *  - `AGENT_CHANNEL_TOKEN` — only emitted when the configured bearer is non-empty
 */
export function buildMcpConfigJson(args: McpConfigArgs): string {
  const env: Record<string, string> = {
    AGENT_CHANNEL_EXCHANGE_URL: args.exchangeUrl,
    AGENT_CHANNEL_AGENT_KIND: 'fulcrum-client',
    AGENT_CHANNEL_INSTANCE_LABEL: args.instanceLabel,
    AGENT_CHANNEL_DESIRED_ID: args.desiredChannelId,
    AGENT_CHANNEL_CAPABILITIES: CAPABILITIES,
  }
  if (args.bearerToken) env.AGENT_CHANNEL_TOKEN = args.bearerToken
  return JSON.stringify({
    mcpServers: {
      [MCP_SERVER_NAME]: {
        command: args.mcp.command,
        args: args.mcp.args,
        env,
      },
    },
  })
}

export interface PrepareTaskLaunchArgs {
  /** Logical fulcrum task id; the channel id is `${mailbox}/task-${taskId}`. */
  taskId: string
  /** Terminal row id; its `channelId` column is set to the desired channel id. */
  terminalId: string
}

export interface TaskLaunchSpec {
  /** Equals the `terminals.channel_id` value just written. */
  channelId: string
  /** Absolute path to the JSON file the frontend passes to `claude --mcp-config`. */
  mcpConfigPath: string
}

/**
 * Idempotent: re-calling for the same `terminalId` overwrites the JSON file
 * and the `terminals.channel_id` value. Safe for retries and dtach reattach.
 */
export function prepareTaskLaunch(args: PrepareTaskLaunchArgs): TaskLaunchSpec {
  const cfg = readExchangeConfig()
  if (!cfg.enabled) throw new Error('channels.exchange.enabled is false')
  if (!cfg.url) throw new Error('channels.exchange.url is empty')
  if (!cfg.mailbox) throw new Error('channels.exchange.mailbox is empty')

  const exchangeUrl = stripTrailingSlash(cfg.url)
  const desiredChannelId = `${cfg.mailbox}/task-${args.taskId}`
  const mcp = resolveMcpCommand(cfg.mcpGitRef)

  const json = buildMcpConfigJson({
    exchangeUrl,
    bearerToken: cfg.token,
    desiredChannelId,
    instanceLabel: desiredChannelId,
    mcp,
  })

  const dir = join(getFulcrumDir(), 'runtime', 'mcp-configs')
  mkdirSync(dir, { recursive: true })
  const mcpConfigPath = join(dir, `${args.terminalId}.json`)
  writeFileSync(mcpConfigPath, json, { encoding: 'utf8', mode: 0o600 })
  // writeFileSync `mode` is only respected on create; chmod after to handle
  // the idempotent-overwrite case where the file already existed at 0644.
  chmodSync(mcpConfigPath, 0o600)

  const nowIso = new Date().toISOString()
  db.update(terminals)
    .set({
      channelId: desiredChannelId,
      channelRegisteredAt: nowIso,
      updatedAt: nowIso,
    })
    .where(eq(terminals.id, args.terminalId))
    .run()

  return { channelId: desiredChannelId, mcpConfigPath }
}
