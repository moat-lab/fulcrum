/**
 * Agent command builder abstraction
 *
 * Builds CLI commands for different AI coding agents (Claude Code, OpenCode).
 * Each agent has its own CLI interface with different flags and options.
 */

import type { AgentType } from '@/types'
import { escapeForShell, escapeForShellIfNeeded } from './shell-escape'

/**
 * Agent channel exchange launcher spec (issue #180 / parent #153, #186 wave-2 D1).
 *
 * Frontend passes this only when the exchange-backed Agent Channel is enabled
 * and the fulcrum-client mailbox has been registered for this terminal. The
 * exchange `token` is intentionally absent — MCP child reads it from a fnox
 * key on its own side so it does not appear in dtach stdin.
 */
export interface ChannelLaunchSpec {
  /** Exchange-assigned mailbox id for the fulcrum-client mailbox driving this terminal. */
  channelId: string
  /** Exchange base URL (e.g. `https://agent-channel.example.com`). */
  exchangeUrl: string
  /**
   * Whitespace-separated command that fork-execs `@agent-channel/mcp` as a
   * stdio MCP child (typically `bun x @agent-channel/mcp`). The first token
   * becomes the `mcpServers.agent-channel.command` and the rest become its
   * `args` in the inline `--mcp-config` JSON injected on the claude CLI.
   */
  mcpInvocation: string
}

/**
 * MCP server name under which the `agent-channel` stdio child is registered
 * inside the `--mcp-config` JSON and referenced by `claude --channels server:`.
 */
const AGENT_CHANNEL_MCP_SERVER_NAME = 'agent-channel'

interface AgentChannelMcpServerStanza {
  command: string
  args: string[]
  env: Record<string, string>
}

function buildAgentChannelMcpConfig(channel: ChannelLaunchSpec): string {
  const tokens = channel.mcpInvocation.trim().split(/\s+/).filter(Boolean)
  const command = tokens[0] ?? ''
  const args = tokens.slice(1)
  // MCP child env per `@agent-channel/mcp` config contract (loadMcpChildConfig).
  // `:mcp` suffix per #153 §Channel-id 形态 marks the MCP child mailbox; the
  // parent fulcrum-client mailbox keeps the base channel_id so the two are
  // reconcilable in `discovery.list` via `parent_channel_id`.
  const stanza: AgentChannelMcpServerStanza = {
    command,
    args,
    env: {
      AGENT_CHANNEL_EXCHANGE_URL: channel.exchangeUrl,
      AGENT_CHANNEL_AGENT_KIND: 'mcp-child',
      AGENT_CHANNEL_INSTANCE_LABEL: channel.channelId,
      AGENT_CHANNEL_DESIRED_ID: `${channel.channelId}:mcp`,
      AGENT_CHANNEL_PARENT_ID: channel.channelId,
      AGENT_CHANNEL_CAPABILITIES: 'channel.send,channel.receive,discovery.list',
    },
  }
  return JSON.stringify({
    mcpServers: { [AGENT_CHANNEL_MCP_SERVER_NAME]: stanza },
  })
}

export interface AgentCommandOptions {
  /** The task prompt/description */
  prompt: string
  /** System prompt to inject (Fulcrum context) */
  systemPrompt: string
  /** AI mode: default (full autonomy) or plan (restricted) */
  mode: 'default' | 'plan'
  /** Additional CLI options from agentOptions */
  additionalOptions: Record<string, string>
  /** OpenCode model in format provider/model (e.g., 'anthropic/claude-opus-4-5') */
  opencodeModel?: string | null
  /** OpenCode agent name for default mode (e.g., 'build', 'Sisyphus') */
  opencodeDefaultAgent?: string
  /** OpenCode agent name for plan mode (e.g., 'plan', 'Planner-Sisyphus') */
  opencodePlanAgent?: string
  /**
   * Agent channel exchange launch spec. When present, `claudeBuilder`
   * prefixes a `--channels server:"<mcpInvocation>"` flag so the spawned
   * `claude` process fork-execs the `@agent-channel/mcp` child (issue #180).
   * Absent (or other agent types) leaves the command unchanged.
   */
  channel?: ChannelLaunchSpec
}

export interface AgentCommandBuilder {
  /** Build the CLI command to start this agent */
  buildCommand(options: AgentCommandOptions): string
  /** Patterns to detect "command not found" in terminal output */
  notFoundPatterns: RegExp[]
  /** Process name pattern for monitoring */
  processPattern: RegExp
}

/**
 * Claude Code command builder
 * https://docs.anthropic.com/en/docs/claude-code/cli
 */
const claudeBuilder: AgentCommandBuilder = {
  buildCommand({ prompt, systemPrompt, mode, additionalOptions, channel }) {
    const escapedPrompt = escapeForShell(prompt)
    const escapedSystemPrompt = escapeForShell(systemPrompt)

    // Build additional CLI options
    let extraFlags = ''
    if (additionalOptions && Object.keys(additionalOptions).length > 0) {
      extraFlags = Object.entries(additionalOptions)
        .map(([key, value]) => ` --${key} ${value}`)
        .join('')
    }

    // Agent channel exchange (#180 + #186 D1 fix): inject `--mcp-config <json>`
    // so claude fork-execs `@agent-channel/mcp` as a stdio MCP child with the
    // exchange URL, agent_kind, instance_label, desired_id, and parent_id env
    // it needs to self-register. Then narrow visibility with `--channels
    // server:agent-channel` and gate the toolset to the three exchange tools.
    // `--strict-mcp-config` keeps any user-level `~/.claude/mcp.json` from
    // leaking into the task agent's MCP graph. Absent `channel` leaves the
    // command byte-identical to the legacy path (`--mcp-config` is NOT
    // emitted, so non-channel tasks see zero behavior change).
    let channelFlag = ''
    if (channel) {
      const mcpConfigJson = buildAgentChannelMcpConfig(channel)
      const escapedMcpConfig = escapeForShell(mcpConfigJson)
      channelFlag =
        ` --mcp-config ${escapedMcpConfig}` +
        ` --strict-mcp-config` +
        ` --channels server:${AGENT_CHANNEL_MCP_SERVER_NAME}` +
        ` --allowedTools mcp__${AGENT_CHANNEL_MCP_SERVER_NAME}__channel_send,mcp__${AGENT_CHANNEL_MCP_SERVER_NAME}__channel_receive,mcp__${AGENT_CHANNEL_MCP_SERVER_NAME}__discovery_list`
    }

    if (mode === 'plan') {
      return `claude ${escapedPrompt} --append-system-prompt ${escapedSystemPrompt} --allow-dangerously-skip-permissions --permission-mode plan${channelFlag}${extraFlags}`
    }
    return `claude ${escapedPrompt} --append-system-prompt ${escapedSystemPrompt} --dangerously-skip-permissions${channelFlag}${extraFlags}`
  },
  notFoundPatterns: [
    /claude: command not found/,
    /claude: not found/,
    /'claude' is not recognized/,
    /command not found: claude/,
  ],
  processPattern: /\bclaude\b/i,
}

/**
 * OpenCode command builder
 * https://opencode.ai/docs/cli/
 *
 * OpenCode TUI mode:
 * - `opencode` starts the interactive TUI
 * - `--agent build` (default) or `--agent plan` for mode selection
 * - `--prompt` to pre-fill the initial prompt
 * - System prompts prepended to user prompt (no --system-prompt flag available)
 */
const opencodeBuilder: AgentCommandBuilder = {
  buildCommand({ prompt, systemPrompt, mode, additionalOptions, opencodeModel, opencodeDefaultAgent, opencodePlanAgent }) {
    // OpenCode uses --agent flag to select the agent
    // Default to 'build'/'plan' if custom agent names are not configured
    const agentName = mode === 'plan' 
      ? (opencodePlanAgent || 'plan') 
      : (opencodeDefaultAgent || 'build')

    // Build additional CLI options
    let extraFlags = ''
    if (additionalOptions && Object.keys(additionalOptions).length > 0) {
      extraFlags = Object.entries(additionalOptions)
        .map(([key, value]) => ` --${key} ${value}`)
        .join('')
    }

    // Add --model flag if a specific model is configured
    // This ensures OpenCode uses the user's preferred model even with --prompt
    if (opencodeModel) {
      extraFlags += ` --model ${escapeForShell(opencodeModel)}`
    }

    // OpenCode doesn't have a direct --system-prompt flag like Claude.
    // For now, we prepend the system prompt to the user prompt.
    const fullPrompt = `${systemPrompt}\n\n${prompt}`
    const escapedFullPrompt = escapeForShell(fullPrompt)

    // Start interactive TUI with pre-filled prompt
    return `opencode --agent ${escapeForShellIfNeeded(agentName)} --prompt ${escapedFullPrompt}${extraFlags}`
  },
  notFoundPatterns: [
    /opencode: command not found/,
    /opencode: not found/,
    /'opencode' is not recognized/,
    /command not found: opencode/,
  ],
  processPattern: /\bopencode\b/i,
}

/**
 * Map of agent types to their command builders
 */
export const AGENT_BUILDERS: Record<AgentType, AgentCommandBuilder> = {
  claude: claudeBuilder,
  opencode: opencodeBuilder,
}

/**
 * Get the command builder for a specific agent type
 */
export function getAgentBuilder(agent: AgentType): AgentCommandBuilder {
  return AGENT_BUILDERS[agent]
}

/**
 * Build a command to start an agent
 */
export function buildAgentCommand(agent: AgentType, options: AgentCommandOptions): string {
  return AGENT_BUILDERS[agent].buildCommand(options)
}

/**
 * Check if terminal output matches "command not found" for any known agent
 */
export function matchesAgentNotFound(text: string, agent?: AgentType): AgentType | null {
  if (agent) {
    // Check specific agent
    const builder = AGENT_BUILDERS[agent]
    if (builder.notFoundPatterns.some((pattern) => pattern.test(text))) {
      return agent
    }
    return null
  }

  // Check all agents
  for (const [agentType, builder] of Object.entries(AGENT_BUILDERS)) {
    if (builder.notFoundPatterns.some((pattern) => pattern.test(text))) {
      return agentType as AgentType
    }
  }
  return null
}

/**
 * Get combined process pattern for detecting any agent
 */
export function getCombinedProcessPattern(): RegExp {
  const patterns = Object.values(AGENT_BUILDERS).map((b) => b.processPattern.source)
  return new RegExp(patterns.join('|'), 'i')
}
