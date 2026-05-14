import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { setupTestEnv, type TestEnv } from '../../__tests__/utils/env'
import { db, messagingConnections } from '../../db'
import { setFnoxValue } from '../../lib/settings/fnox'
import { MattermostChannel } from './mattermost-channel'
import type { ChannelEvents } from './types'

interface CapturedLog {
  ts: string
  lvl: string
  src: string
  msg: string
  ctx?: Record<string, unknown>
}

function captureStdoutLogs(): { logs: CapturedLog[]; restore: () => void } {
  const original = console.log
  const logs: CapturedLog[] = []
  console.log = (line: string) => {
    try {
      const entry = JSON.parse(line)
      if (entry && typeof entry === 'object' && 'msg' in entry) {
        logs.push(entry as CapturedLog)
      }
    } catch {
      // ignore non-JSON lines
    }
  }
  return {
    logs,
    restore: () => {
      console.log = original
    },
  }
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  url: string
  sent: string[] = []
  private listeners: Record<string, Array<(ev: unknown) => void>> = {}

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, fn: (ev: unknown) => void): void {
    this.listeners[type] ||= []
    this.listeners[type].push(fn)
  }

  send(payload: string): void {
    this.sent.push(payload)
  }

  close(): void {
    this.fire('close', {})
  }

  fire(type: string, ev: unknown): void {
    for (const fn of this.listeners[type] ?? []) fn(ev)
  }
}

describe('MattermostChannel — connect log anchor (issue #208)', () => {
  let testEnv: TestEnv
  let originalFetch: typeof fetch
  let originalWebSocket: typeof WebSocket

  beforeEach(() => {
    testEnv = setupTestEnv()
    originalFetch = globalThis.fetch
    originalWebSocket = globalThis.WebSocket
    FakeWebSocket.instances = []

    db.insert(messagingConnections).values({
      id: 'test-mm-1',
      channelType: 'mattermost',
      enabled: true,
      status: 'disconnected',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).run()

    setFnoxValue('channels.mattermost.serverUrl', 'https://mattermost.example.test')
    setFnoxValue('channels.mattermost.botToken', 'fake-bot-token')

    globalThis.fetch = (async (url: string) => {
      if (typeof url === 'string' && url.endsWith('/api/v4/users/me')) {
        return new Response(JSON.stringify({ id: 'bot-user-1', username: 'fulcrumtest' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch

    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    globalThis.WebSocket = originalWebSocket
    testEnv.cleanup()
  })

  test('logs "Connected to Mattermost as <username>" once WS open fires', async () => {
    const capture = captureStdoutLogs()
    try {
      const events: ChannelEvents = {
        onMessage: async () => {},
        onConnectionChange: () => {},
        onDisplayNameChange: () => {},
      }
      const channel = new MattermostChannel('test-mm-1')
      await channel.initialize(events)

      expect(FakeWebSocket.instances.length).toBe(1)
      const ws = FakeWebSocket.instances[0]
      ws.fire('open', {})

      const hit = capture.logs.find(
        (l) => l.src === 'Messaging' && l.msg.startsWith('Connected to Mattermost as '),
      )
      expect(hit).toBeDefined()
      expect(hit?.msg).toBe('Connected to Mattermost as fulcrumtest')
      expect(hit?.lvl).toBe('info')
      expect(hit?.ctx?.connectionId).toBe('test-mm-1')
      expect(hit?.ctx?.botUserId).toBe('bot-user-1')

      // auth challenge sent before the connected log fires
      const challenge = ws.sent.find((s) => s.includes('authentication_challenge'))
      expect(challenge).toBeDefined()

      await channel.shutdown()
    } finally {
      capture.restore()
    }
  })

  test('does not log connected anchor when credentials are missing', async () => {
    const capture = captureStdoutLogs()
    try {
      setFnoxValue('channels.mattermost.serverUrl', '')
      setFnoxValue('channels.mattermost.botToken', '')

      const events: ChannelEvents = {
        onMessage: async () => {},
        onConnectionChange: () => {},
        onDisplayNameChange: () => {},
      }
      const channel = new MattermostChannel('test-mm-1')
      await channel.initialize(events)

      expect(FakeWebSocket.instances.length).toBe(0)
      const hit = capture.logs.find((l) => l.msg.startsWith('Connected to Mattermost as '))
      expect(hit).toBeUndefined()

      await channel.shutdown()
    } finally {
      capture.restore()
    }
  })
})
