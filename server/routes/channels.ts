/**
 * Agent channel exchange routes (issue #180 / parent #153).
 *
 * Owns the fulcrum-side proxy to the agent-channel exchange:
 *   POST /api/channels/register         — server-side register-and-track for a terminal
 *   POST /api/channels/test-connection  — Settings UI button; hits exchange `/version`
 *
 * The exchange token never crosses the frontend boundary — frontend sends only
 * `{ taskId, terminalId }` and the server reads `channels.exchange.*` fnox keys.
 */

import { Hono } from 'hono'
import { z } from 'zod'
import {
  registerChannel,
  trackChannel,
  testExchangeConnection,
} from '../services/channel-heartbeat-service'
import { getFnoxValue } from '../lib/settings/fnox'

const channelRoutes = new Hono()

const RegisterSchema = z.object({
  taskId: z.string().min(1),
  terminalId: z.string().min(1),
})

const TestConnectionSchema = z
  .object({
    url: z.string().min(1).optional(),
  })
  .optional()

channelRoutes.post('/register', async (c) => {
  const parsed = RegisterSchema.safeParse(await c.req.json())
  if (!parsed.success) {
    return c.json({ error: 'Invalid request body', details: parsed.error.flatten() }, 400)
  }

  const enabled = (getFnoxValue('channels.exchange.enabled') as boolean | null) ?? false
  if (!enabled) {
    return c.json({ error: 'channels.exchange.enabled is false' }, 409)
  }

  try {
    const result = await registerChannel(parsed.data)
    trackChannel(parsed.data.terminalId, result.channelId)
    return c.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: 'register failed', message }, 502)
  }
})

channelRoutes.post('/test-connection', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as unknown
  const parsed = TestConnectionSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ ok: false, error: 'Invalid request body' }, 400)
  }
  const result = await testExchangeConnection(parsed.data)
  // Surface result with a stable shape; UI maps `ok` to the badge state.
  return c.json(result, result.ok ? 200 : 502)
})

export default channelRoutes
