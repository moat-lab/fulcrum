import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type Notification } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { FulcrumClient } from '../client'

const ReplyArgumentsSchema = z.object({
  message_id: z.string().min(1),
  text: z.string(),
  structured_data: z.unknown().optional(),
})

type ClaudeChannelNotification = Notification & {
  method: 'notifications/claude/channel'
  params: {
    content: string
    meta: {
      source: string
      session_id: string
      message_id: string
      ts: string
    } & Record<string, unknown>
  }
}

function toClaudeChannelNotification(sessionId: string, message: Awaited<ReturnType<FulcrumClient['consumeClaudeChannelMessages']>>['messages'][number]): ClaudeChannelNotification {
  return {
    method: 'notifications/claude/channel',
    params: {
      content: message.content,
      meta: {
        ...message.meta,
        source: message.source,
        session_id: sessionId,
        message_id: message.messageId,
        ts: message.createdAt,
      },
    },
  }
}

export async function runClaudeChannelMcpServer(input: { sessionId: string; url?: string; port?: string; pollMs?: number }) {
  const client = new FulcrumClient(input.url, input.port)
  const pollMs = input.pollMs ?? 1000

  const server = new Server(
    { name: 'fulcrum-channel', version: '5.7.1' },
    {
      capabilities: {
        tools: {},
        experimental: { 'claude/channel': {} },
      },
      instructions:
        'Fulcrum messages arrive as <channel source="fulcrum">. Use the reply tool with the received message_id when you need to send a structured response back to Fulcrum.',
    }
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'reply',
        description: 'Send a reply from this Claude Code session back to Fulcrum.',
        inputSchema: {
          type: 'object',
          properties: {
            message_id: { type: 'string' },
            text: { type: 'string' },
            structured_data: {},
          },
          required: ['message_id', 'text'],
        },
      },
    ],
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== 'reply') {
      return { content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }], isError: true }
    }

    const parsed = ReplyArgumentsSchema.safeParse(request.params.arguments ?? {})
    if (!parsed.success) {
      return { content: [{ type: 'text', text: 'Invalid reply arguments' }], isError: true }
    }

    await client.sendClaudeChannelReply(input.sessionId, {
      messageId: parsed.data.message_id,
      text: parsed.data.text,
      ...(parsed.data.structured_data !== undefined ? { structuredData: parsed.data.structured_data } : {}),
    })

    return { content: [{ type: 'text', text: 'sent' }] }
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)

  const interval = setInterval(async () => {
    try {
      const { messages } = await client.consumeClaudeChannelMessages(input.sessionId)
      await Promise.all(
        messages.map((message) => server.notification(toClaudeChannelNotification(input.sessionId, message)))
      )
    } catch (error) {
      server.onerror?.(error instanceof Error ? error : new Error(String(error)))
    }
  }, pollMs)

  process.on('SIGINT', () => {
    clearInterval(interval)
    void server.close().finally(() => process.exit(0))
  })
}
