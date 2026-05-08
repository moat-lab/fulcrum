import { describe, expect, test } from 'bun:test'
import { createTestApp } from '../__tests__/fixtures/app'

describe('Claude channel routes', () => {
  test('queues channel messages for one-time consumption', async () => {
    const { post } = createTestApp()

    const sendRes = await post('/api/claude-channels/sessions/session-1/messages', {
      content: 'Run the release checklist',
      messageId: 'msg-1',
      meta: { taskId: 'task-1' },
    })
    const sendBody = await sendRes.json()

    expect(sendRes.status).toBe(200)
    expect(sendBody.message).toMatchObject({
      messageId: 'msg-1',
      content: 'Run the release checklist',
      source: 'fulcrum',
      meta: { taskId: 'task-1' },
    })

    const firstConsumeRes = await post('/api/claude-channels/sessions/session-1/consume')
    const firstConsumeBody = await firstConsumeRes.json()
    expect(firstConsumeBody.messages).toHaveLength(1)
    expect(firstConsumeBody.messages[0].messageId).toBe('msg-1')

    const secondConsumeRes = await post('/api/claude-channels/sessions/session-1/consume')
    const secondConsumeBody = await secondConsumeRes.json()
    expect(secondConsumeBody.messages).toEqual([])
  })

  test('stores structured replies per session', async () => {
    const { post, get } = createTestApp()

    const replyRes = await post('/api/claude-channels/sessions/session-2/replies', {
      messageId: 'msg-2',
      text: 'done',
      structuredData: { status: 'ok' },
    })
    const replyBody = await replyRes.json()

    expect(replyRes.status).toBe(200)
    expect(replyBody.reply).toMatchObject({
      messageId: 'msg-2',
      text: 'done',
      structuredData: { status: 'ok' },
    })

    const listRes = await get('/api/claude-channels/sessions/session-2/replies')
    const listBody = await listRes.json()
    expect(listBody.replies).toHaveLength(1)
    expect(listBody.replies[0].messageId).toBe('msg-2')
  })

  test('rejects empty inbound channel messages', async () => {
    const { post } = createTestApp()

    const res = await post('/api/claude-channels/sessions/session-3/messages', { content: '' })

    expect(res.status).toBe(400)
  })
})
