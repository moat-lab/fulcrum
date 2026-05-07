import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { setupTestEnv, withEnv, type TestEnv } from '../../__tests__/utils/env'
import { clearFnoxCache, setFnoxValue } from '../../lib/settings/fnox'
import {
  fulcrumUrl,
  getActionsUrl,
  getCallbackUrl,
  getDialogsUrl,
  openDialog,
  postDirectMessage,
  postMessage,
  postNotification,
  updatePost,
  type MattermostAttachment,
} from './client'

type FetchCall = {
  url: string
  init?: RequestInit
  body?: unknown
}

const MATTERMOST_URL = 'https://mattermost.example.test'
const BOT_TOKEN = 'bot-token-123'

function configureMattermost() {
  setFnoxValue('channels.mattermost.serverUrl', MATTERMOST_URL)
  setFnoxValue('channels.mattermost.botToken', BOT_TOKEN)
  setFnoxValue('channels.mattermost.channelId', 'default-channel')
}

function installMattermostFetchStub(handler?: (call: FetchCall) => Response): FetchCall[] {
  const calls: FetchCall[] = []
  global.fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const urlString = typeof url === 'string' ? url : url.toString()
    const call: FetchCall = {
      url: urlString,
      init,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    }
    calls.push(call)

    if (handler) return handler(call)

    if (urlString.endsWith('/api/v4/users/me')) {
      return Response.json({ id: 'bot-user' })
    }
    if (urlString.endsWith('/api/v4/channels/direct')) {
      return Response.json({ id: 'dm-channel' })
    }
    if (urlString.endsWith('/api/v4/posts')) {
      return Response.json({ id: `post-${calls.filter(c => c.url.endsWith('/api/v4/posts')).length}` })
    }
    return Response.json({ ok: true })
  }
  return calls
}

describe.serial('Mattermost client', () => {
  let testEnv: TestEnv
  let originalFetch: typeof global.fetch

  beforeEach(() => {
    testEnv = setupTestEnv()
    originalFetch = global.fetch
  })

  afterEach(() => {
    global.fetch = originalFetch
    testEnv.cleanup()
  })

  test('posts and updates messages with Mattermost API auth headers', async () => {
    configureMattermost()
    const calls = installMattermostFetchStub()

    const post = { channel_id: 'channel-1', message: 'hello' }
    const result = await postMessage(post)
    await updatePost('post-1', { id: 'post-1', message: 'edited' })

    expect(result).toEqual({ id: 'post-1' })
    expect(calls[0]).toMatchObject({
      url: `${MATTERMOST_URL}/api/v4/posts`,
      body: post,
    })
    expect(calls[0].init?.method).toBe('POST')
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${BOT_TOKEN}`)
    expect(calls[1]).toMatchObject({
      url: `${MATTERMOST_URL}/api/v4/posts/post-1`,
      body: { id: 'post-1', message: 'edited' },
    })
    expect(calls[1].init?.method).toBe('PUT')
  })

  test('opens dialogs with a Mattermost callback path', async () => {
    configureMattermost()
    const calls = installMattermostFetchStub()

    clearFnoxCache()
    setFnoxValue('server.port', 4321)
    setFnoxValue('editor.host', 'fulcrum-dialog.example.test')
    configureMattermost()
    await openDialog('trigger-1', {
      callback_id: 'create_task',
      title: 'Create Task',
      elements: [],
    })

    expect(calls[0]).toMatchObject({
      url: `${MATTERMOST_URL}/api/v4/actions/dialogs/open`,
      body: {
        trigger_id: 'trigger-1',
        url: 'http://fulcrum-dialog.example.test:4321/api/mattermost/dialogs',
        dialog: { callback_id: 'create_task', title: 'Create Task', elements: [] },
      },
    })
  })

  test('posts notifications with the configured attachment payload', async () => {
    configureMattermost()
    installMattermostFetchStub()
    const attachment: MattermostAttachment = { fallback: 'Notice', text: 'Body' }

    const notification = await postNotification(attachment)

    expect(notification).toEqual({ id: 'post-1' })
  })

  test('builds callback URLs from configured editor host fallback', async () => {
    clearFnoxCache()
    setFnoxValue('server.port', 7777)
    setFnoxValue('editor.host', 'editor.example.test')

    expect(getActionsUrl()).toBe('http://editor.example.test:7777/api/mattermost/actions')
    expect(getDialogsUrl()).toBe('http://editor.example.test:7777/api/mattermost/dialogs')
    expect(getCallbackUrl('/custom')).toBe('http://editor.example.test:7777/api/mattermost/custom')
    expect(fulcrumUrl('/tasks/abc')).toBe('http://editor.example.test:7777/tasks/abc')
  })

  test('builds Mattermost callback URLs from FULCRUM_HOST override', async () => {
    await withEnv({ FULCRUM_HOST: 'fulcrum.example.test', FULCRUM_EDITOR_HOST: undefined }, () => {
      clearFnoxCache()
      setFnoxValue('server.port', 7777)
      setFnoxValue('editor.host', 'editor.example.test')
      expect(getActionsUrl()).toBe('http://fulcrum.example.test:7777/api/mattermost/actions')
    })
  })

  test('reuses cached bot user id when posting direct messages', async () => {
    configureMattermost()
    const calls = installMattermostFetchStub()
    const attachment: MattermostAttachment = { fallback: 'DM' }

    await postDirectMessage('target-user', attachment)
    await postDirectMessage('target-user', attachment)

    expect(calls.filter(call => call.url.endsWith('/api/v4/users/me'))).toHaveLength(1)
    expect(calls.filter(call => call.url.endsWith('/api/v4/channels/direct')).map(call => call.body)).toEqual([
      ['target-user', 'bot-user'],
      ['target-user', 'bot-user'],
    ])
    expect(calls.filter(call => call.url.endsWith('/api/v4/posts')).map(call => call.body)).toEqual([
      { channel_id: 'dm-channel', props: { attachments: [attachment] } },
      { channel_id: 'dm-channel', props: { attachments: [attachment] } },
    ])
  })

  test('throws for missing config and non-OK Mattermost responses', async () => {
    await expect(postMessage({ channel_id: 'channel-1' })).rejects.toThrow('Mattermost not configured')

    configureMattermost()
    installMattermostFetchStub(() => new Response('bad token', { status: 401 }))

    await expect(postMessage({ channel_id: 'channel-1' })).rejects.toThrow('Mattermost API error: 401 bad token')
  })
})
