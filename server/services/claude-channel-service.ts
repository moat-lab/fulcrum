export type ClaudeChannelMessage = {
  messageId: string
  content: string
  source: string
  createdAt: string
  meta: Record<string, unknown>
}

export type ClaudeChannelReply = {
  messageId: string
  text: string
  structuredData?: unknown
  createdAt: string
}

type PendingMessage = ClaudeChannelMessage & {
  consumedAt?: string
}

const DEFAULT_SOURCE = 'fulcrum'

export class ClaudeChannelService {
  private readonly pendingMessages = new Map<string, PendingMessage[]>()
  private readonly replies = new Map<string, ClaudeChannelReply[]>()

  enqueue(sessionId: string, input: { content: string; messageId?: string; source?: string; meta?: Record<string, unknown> }): ClaudeChannelMessage {
    const message: ClaudeChannelMessage = {
      messageId: input.messageId ?? crypto.randomUUID(),
      content: input.content,
      source: input.source ?? DEFAULT_SOURCE,
      createdAt: new Date().toISOString(),
      meta: input.meta ?? {},
    }

    const queue = this.pendingMessages.get(sessionId) ?? []
    queue.push(message)
    this.pendingMessages.set(sessionId, queue)
    return message
  }

  consume(sessionId: string): ClaudeChannelMessage[] {
    const queue = this.pendingMessages.get(sessionId) ?? []
    const now = new Date().toISOString()
    const readyMessages = queue.filter((message) => !message.consumedAt)
    for (const message of readyMessages) {
      message.consumedAt = now
    }
    return readyMessages
  }

  recordReply(sessionId: string, input: { messageId: string; text: string; structuredData?: unknown }): ClaudeChannelReply {
    const reply: ClaudeChannelReply = {
      messageId: input.messageId,
      text: input.text,
      ...(input.structuredData !== undefined ? { structuredData: input.structuredData } : {}),
      createdAt: new Date().toISOString(),
    }

    const replies = this.replies.get(sessionId) ?? []
    replies.push(reply)
    this.replies.set(sessionId, replies)
    return reply
  }

  listReplies(sessionId: string): ClaudeChannelReply[] {
    return this.replies.get(sessionId) ?? []
  }
}

export const claudeChannelService = new ClaudeChannelService()
