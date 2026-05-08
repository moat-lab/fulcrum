import { Hono } from 'hono'
import { z } from 'zod'
import { claudeChannelService } from '../services/claude-channel-service'

const claudeChannelRoutes = new Hono()

const SendMessageSchema = z.object({
  content: z.string().min(1),
  messageId: z.string().min(1).optional(),
  source: z.string().min(1).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
})

const ReplySchema = z.object({
  messageId: z.string().min(1),
  text: z.string(),
  structuredData: z.unknown().optional(),
})

claudeChannelRoutes.post('/sessions/:sessionId/messages', async (c) => {
  const parsed = SendMessageSchema.safeParse(await c.req.json())
  if (!parsed.success) {
    return c.json({ error: 'Invalid request body' }, 400)
  }

  const message = claudeChannelService.enqueue(c.req.param('sessionId'), parsed.data)
  return c.json({ message })
})

claudeChannelRoutes.post('/sessions/:sessionId/consume', async (c) => {
  const messages = claudeChannelService.consume(c.req.param('sessionId'))
  return c.json({ messages })
})

claudeChannelRoutes.post('/sessions/:sessionId/replies', async (c) => {
  const parsed = ReplySchema.safeParse(await c.req.json())
  if (!parsed.success) {
    return c.json({ error: 'Invalid request body' }, 400)
  }

  const reply = claudeChannelService.recordReply(c.req.param('sessionId'), parsed.data)
  return c.json({ reply })
})

claudeChannelRoutes.get('/sessions/:sessionId/replies', async (c) => {
  const replies = claudeChannelService.listReplies(c.req.param('sessionId'))
  return c.json({ replies })
})

export default claudeChannelRoutes
