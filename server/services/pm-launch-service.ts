/**
 * PM Agent Mode launch-config preparation (issue #194 / parent #192).
 *
 * Owns the fulcrum-server side of telling Alice **how to start her own PM
 * claude session** without fulcrum ever spawning, registering, or tracking
 * that process. The deliverable is a 0600 `--mcp-config` JSON file plus the
 * suggested `claude --mcp-config <path>` command line; Alice runs the command
 * from her own shell (so the resulting PM process is parented to her shell,
 * not to the fulcrum server).
 *
 * # Why this is a separate file from `pm-mode-service.ts`
 *
 * Acceptance #7 of issue #194 greps `pm-mode-service.ts` for any literal
 * `agent_kind: 'pm-agent'` register-path call. The discovery poller in
 * `pm-mode-service.ts` deliberately registers itself with the weak
 * `fulcrum-client` identity; we keep `pm-agent` literals out of that file so
 * the boundary stays mechanically auditable. The MCP child env emitted by
 * this file (`AGENT_CHANNEL_AGENT_KIND=pm-agent`) is only consumed by the
 * MCP child Alice's claude spawns — fulcrum never sends that envelope.
 *
 * # Why this is also separate from `channel-launch-service.ts`
 *
 * `channel-launch-service.ts` stamps `terminals.channel_id` and assumes the
 * caller (a fulcrum UI task) is about to spawn a claude under fulcrum's
 * dtach. The PM path explicitly inverts both: there is no fulcrum task row,
 * no terminal row, no dtach session — fulcrum just writes the config file and
 * Alice runs `claude` in her own terminal. Sharing code with the task-launch
 * service would entangle the two lifecycles and risk re-introducing the
 * "fulcrum holds the PM" antipattern.
 */

import { writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { getFnoxValue } from '../lib/settings/fnox'
import { getFulcrumDir } from '../lib/settings/paths'
import { resolveMcpCommand, MCP_SERVER_NAME, type McpCommandSpec } from './channel-launch-service'

const CAPABILITIES = 'channel.send,channel.receive,discovery.list' as const
/** Single string the env-builder uses; matches `AgentKind` in protocol/schema. */
const PM_AGENT_KIND = 'pm-agent' as const
/** Filename inside `${FULCRUM_DIR}/runtime/mcp-configs/` for the PM config. */
const PM_MCP_CONFIG_FILENAME = 'pm.json' as const

interface ExchangeConfig {
  enabled: boolean
  url: string
  token: string
  mcpGitRef: string
}

interface PmConfig {
  enabled: boolean
  clientForm: string
  mailbox: string
}

function readExchangeConfig(): ExchangeConfig {
  return {
    enabled: (getFnoxValue('channels.exchange.enabled') as boolean | null) ?? false,
    url: (getFnoxValue('channels.exchange.url') as string | null) ?? '',
    token: (getFnoxValue('channels.exchange.token') as string | null) ?? '',
    mcpGitRef: (getFnoxValue('channels.exchange.mcpGitRef') as string | null) ?? '',
  }
}

function readPmConfig(): PmConfig {
  return {
    enabled: (getFnoxValue('channels.pm.enabled') as boolean | null) ?? false,
    clientForm: (getFnoxValue('channels.pm.clientForm') as string | null) ?? 'claude-mcp',
    mailbox: (getFnoxValue('channels.pm.mailbox') as string | null) ?? '',
  }
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url
}

export interface PmMcpConfigArgs {
  exchangeUrl: string
  bearerToken: string
  /** Same value used for both `desired_channel_id` and `instance_label`. */
  pmMailbox: string
  mcp: McpCommandSpec
}

/**
 * Build the `mcpServers` JSON object passed to `claude --mcp-config`. The env
 * keys mirror `agent-channel-exchange/packages/mcp/src/config.ts`. The key
 * difference vs `channel-launch-service.buildMcpConfigJson` is
 * `AGENT_CHANNEL_AGENT_KIND=pm-agent`, which is what the exchange uses to
 * surface this mailbox in `discovery.list_request{filter.agent_kind:["pm-agent"]}`
 * — i.e. how the fulcrum-side mailbox poller sees the PM as "online".
 */
export function buildPmMcpConfigJson(args: PmMcpConfigArgs): string {
  const env: Record<string, string> = {
    AGENT_CHANNEL_EXCHANGE_URL: args.exchangeUrl,
    AGENT_CHANNEL_AGENT_KIND: PM_AGENT_KIND,
    AGENT_CHANNEL_INSTANCE_LABEL: args.pmMailbox,
    AGENT_CHANNEL_DESIRED_ID: args.pmMailbox,
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

export interface PmLaunchSpec {
  /** Absolute path to the 0600 `--mcp-config` JSON file Alice should pass. */
  mcpConfigPath: string
  /** Channel id that the MCP child will request from the exchange. */
  pmMailbox: string
  /** Ready-to-copy `claude --mcp-config <path>` shell invocation. */
  command: string
}

/**
 * Idempotent: re-calling overwrites the JSON file in place. Safe to call
 * every time Alice opens the Settings → PM Agent Mode panel; no exchange
 * register POST and no DB write happen here.
 *
 * Throws on any missing config so the UI can surface "fix Settings first"
 * rather than letting Alice run a half-broken claude command.
 */
export function preparePmLaunch(): PmLaunchSpec {
  const exchange = readExchangeConfig()
  const pm = readPmConfig()

  if (!exchange.enabled) throw new Error('channels.exchange.enabled is false')
  if (!exchange.url) throw new Error('channels.exchange.url is empty')
  if (!pm.enabled) throw new Error('channels.pm.enabled is false')
  if (pm.clientForm !== 'claude-mcp') {
    throw new Error(
      `channels.pm.clientForm=${pm.clientForm} is not 'claude-mcp'; the launch helper only emits the Claude-MCP form`,
    )
  }
  if (!pm.mailbox) {
    throw new Error('channels.pm.mailbox is empty; set it to the PM channel id (e.g. pm-mouriya/main)')
  }

  const exchangeUrl = stripTrailingSlash(exchange.url)
  const mcp = resolveMcpCommand(exchange.mcpGitRef)
  const json = buildPmMcpConfigJson({
    exchangeUrl,
    bearerToken: exchange.token,
    pmMailbox: pm.mailbox,
    mcp,
  })

  const dir = join(getFulcrumDir(), 'runtime', 'mcp-configs')
  mkdirSync(dir, { recursive: true })
  const mcpConfigPath = join(dir, PM_MCP_CONFIG_FILENAME)
  writeFileSync(mcpConfigPath, json, { encoding: 'utf8', mode: 0o600 })
  // writeFileSync `mode` only respected on create; chmod after to fix any
  // existing 0644 file from a prior overwrite.
  chmodSync(mcpConfigPath, 0o600)

  return {
    mcpConfigPath,
    pmMailbox: pm.mailbox,
    command: `claude --mcp-config ${mcpConfigPath}`,
  }
}
