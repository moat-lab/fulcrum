import { defineCommand } from 'citty'
import { globalArgs, toFlags } from './shared'

/**
 * Handle the 'fulcrum mcp' command.
 * Starts the MCP server over stdio for integration with Claude Desktop and other MCP clients.
 */
async function handleMcpCommand(flags: Record<string, string>) {
  if (flags.channelSession) {
    const { runClaudeChannelMcpServer } = await import('../mcp/claude-channel')
    await runClaudeChannelMcpServer({
      sessionId: flags.channelSession,
      url: flags.url,
      port: flags.port,
      pollMs: flags.pollMs ? Number(flags.pollMs) : undefined,
    })
    return
  }

  const { runMcpServer } = await import('../mcp/index')
  await runMcpServer(flags.url, flags.port)
}

// ============================================================================
// Command Definition
// ============================================================================

export const mcpCommand = defineCommand({
  meta: { name: 'mcp', description: 'Start MCP server (stdio)' },
  args: {
    ...globalArgs,
    channelSession: {
      type: 'string' as const,
      description: 'Start Claude Code Channels bridge for this Fulcrum session ID',
    },
    pollMs: {
      type: 'string' as const,
      description: 'Claude channel polling interval in milliseconds (default: 1000)',
    },
  },
  async run({ args }) {
    await handleMcpCommand(toFlags(args))
  },
})
