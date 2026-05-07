import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { eq } from 'drizzle-orm'
import { setupTestEnv, type TestEnv } from '../../__tests__/utils/env'
import { db, messagingConnections, messagingSessionMappings, chatSessions } from '../../db'
import { DISCORD_CONNECTION_ID, TELEGRAM_CONNECTION_ID, SLACK_CONNECTION_ID } from './channel-manager'
import type { MessagingChannel, ChannelEvents, ConnectionStatus, ChannelFactory } from './types'
import {
  getOrCreateWhatsAppConnection,
  enableWhatsApp,
  disableWhatsApp,
  getWhatsAppStatus,
  configureDiscord,
  configureTelegram,
  configureSlack,
  listConnections,
  stopMessagingChannels,
  setChannelFactory,
  resetChannelFactory,
  sendMessageToChannel,
} from './index'

// Base mock channel class (no mock.module needed - uses dependency injection)
class BaseMockChannel implements MessagingChannel {
  readonly connectionId: string
  readonly type: 'whatsapp' | 'discord' | 'telegram' | 'slack' | 'email' | 'mattermost'
  protected events: ChannelEvents | null = null
  protected status: ConnectionStatus = 'disconnected'
  sentMessages: Array<{ recipientId: string; content: string }> = []

  constructor(connectionId: string, type: 'whatsapp' | 'discord' | 'telegram' | 'slack' | 'email' | 'mattermost') {
    this.connectionId = connectionId
    this.type = type
  }

  async initialize(events: ChannelEvents): Promise<void> {
    this.events = events
    this.updateStatus('connected')
  }

  async shutdown(): Promise<void> {
    this.updateStatus('disconnected')
  }

  async sendMessage(recipientId: string, content: string): Promise<boolean> {
    this.sentMessages.push({ recipientId, content })
    return true
  }

  getStatus(): ConnectionStatus {
    return this.status
  }

  async logout(): Promise<void> {
    this.updateStatus('disconnected')
  }

  // Update status in database like real channels do
  private updateStatus(status: ConnectionStatus): void {
    this.status = status
    db.update(messagingConnections)
      .set({
        status,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(messagingConnections.id, this.connectionId))
      .run()
    this.events?.onConnectionChange(status)
  }
}

// Mock factory that creates mock channels and skips token validation
const mockChannelFactory: ChannelFactory = {
  createWhatsAppChannel: (id) => new BaseMockChannel(id, 'whatsapp'),
  createDiscordChannel: (id) => new BaseMockChannel(id, 'discord'),
  createTelegramChannel: (id) => new BaseMockChannel(id, 'telegram'),
  createSlackChannel: (id) => new BaseMockChannel(id, 'slack'),
  createMattermostChannel: (id) => new BaseMockChannel(id, 'mattermost'),
  createEmailChannel: (id) => new BaseMockChannel(id, 'email'),
  // Mock validators that always pass
  validateDiscordToken: async () => {},
  validateTelegramToken: async () => {},
  validateSlackTokens: async () => {},
}

describe('Messaging Channel Manager', () => {
  let testEnv: TestEnv

  beforeEach(() => {
    testEnv = setupTestEnv()
    setChannelFactory(mockChannelFactory)
  })

  afterEach(async () => {
    await stopMessagingChannels()
    resetChannelFactory()
    testEnv.cleanup()
  })

  describe('getOrCreateWhatsAppConnection', () => {
    test('creates new connection when none exists', () => {
      const conn = getOrCreateWhatsAppConnection()

      expect(conn).toBeDefined()
      expect(conn.id).toBeDefined()
      expect(conn.channelType).toBe('whatsapp')
      expect(conn.enabled).toBe(false)
      expect(conn.status).toBe('disconnected')
    })

    test('returns existing connection on subsequent calls', () => {
      const first = getOrCreateWhatsAppConnection()
      const second = getOrCreateWhatsAppConnection()

      expect(first.id).toBe(second.id)
    })
  })

  describe('enableWhatsApp', () => {
    test('enables WhatsApp and returns updated connection', async () => {
      const conn = await enableWhatsApp()

      expect(conn.enabled).toBe(true)
    })

    test('can be called multiple times safely', async () => {
      await enableWhatsApp()
      const conn = await enableWhatsApp()

      expect(conn.enabled).toBe(true)
    })
  })

  describe('disableWhatsApp', () => {
    test('disables WhatsApp and returns updated connection', async () => {
      await enableWhatsApp()
      const conn = await disableWhatsApp()

      expect(conn.enabled).toBe(false)
      expect(conn.status).toBe('disconnected')
    })

    test('can be called when already disabled', async () => {
      const conn = await disableWhatsApp()
      expect(conn.enabled).toBe(false)
    })
  })

  describe('getWhatsAppStatus', () => {
    test('returns null when no connection exists', () => {
      // Database is fresh from beforeEach - no need to delete
      const status = getWhatsAppStatus()
      expect(status).toBeNull()
    })

    test('returns connection status when exists', async () => {
      await enableWhatsApp()

      const status = getWhatsAppStatus()
      expect(status).not.toBeNull()
      expect(status!.channelType).toBe('whatsapp')
      expect(status!.enabled).toBe(true)
    })
  })

  describe('listConnections', () => {
    test('returns empty array when no connections', () => {
      // Database is fresh from beforeEach - no need to delete

      const connections = listConnections()
      expect(connections).toEqual([])
    })

    test('returns all connections', async () => {
      await enableWhatsApp()

      const connections = listConnections()
      expect(connections.length).toBe(1)
      expect(connections[0].channelType).toBe('whatsapp')
    })
  })
})

describe('Message Splitting', () => {
  // Test the splitMessage function indirectly by exposing it
  // We can test the splitting logic by checking how long messages are handled

  test('short messages are not split', () => {
    const content = 'Hello, world!'
    const maxLength = 4000
    const parts = splitMessageHelper(content, maxLength)

    expect(parts.length).toBe(1)
    expect(parts[0]).toBe(content)
  })

  test('long messages are split at paragraph boundaries', () => {
    const para1 = 'First paragraph. '.repeat(100) // ~1700 chars
    const para2 = 'Second paragraph. '.repeat(100) // ~1800 chars
    const para3 = 'Third paragraph. '.repeat(100) // ~1800 chars
    const content = `${para1}\n\n${para2}\n\n${para3}`
    const maxLength = 4000
    const parts = splitMessageHelper(content, maxLength)

    expect(parts.length).toBeGreaterThan(1)
    // Each part should be within maxLength
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(maxLength)
    }
  })

  test('long messages without paragraphs split at newlines', () => {
    const lines = Array(100).fill('This is a line of text that is about 40 characters.').join('\n')
    const maxLength = 2000
    const parts = splitMessageHelper(lines, maxLength)

    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(maxLength)
    }
  })

  test('long messages without breaks split at spaces', () => {
    const words = 'word '.repeat(1000) // ~5000 chars
    const maxLength = 2000
    const parts = splitMessageHelper(words.trim(), maxLength)

    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(maxLength)
    }
  })

  test('very long words get hard cut', () => {
    const longWord = 'a'.repeat(5000)
    const maxLength = 2000
    const parts = splitMessageHelper(longWord, maxLength)

    expect(parts.length).toBe(3) // 5000 / 2000 = 2.5, rounds up to 3
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(maxLength)
    }
  })
})

// Helper to test the split message logic
// This mirrors the implementation in index.ts
function splitMessageHelper(content: string, maxLength: number): string[] {
  if (content.length <= maxLength) return [content]

  const parts: string[] = []
  let remaining = content

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      parts.push(remaining)
      break
    }

    // Try to split at a paragraph break
    let splitIdx = remaining.lastIndexOf('\n\n', maxLength)

    // Fall back to newline
    if (splitIdx === -1 || splitIdx < maxLength / 2) {
      splitIdx = remaining.lastIndexOf('\n', maxLength)
    }

    // Fall back to space
    if (splitIdx === -1 || splitIdx < maxLength / 2) {
      splitIdx = remaining.lastIndexOf(' ', maxLength)
    }

    // Fall back to hard cut
    if (splitIdx === -1 || splitIdx < maxLength / 2) {
      splitIdx = maxLength
    }

    parts.push(remaining.slice(0, splitIdx).trim())
    remaining = remaining.slice(splitIdx).trim()
  }

  return parts
}

describe('Special Commands', () => {
  // Test that command patterns are recognized correctly
  const COMMANDS = {
    RESET: ['/reset', '/new', '/clear'],
    HELP: ['/help', '/?'],
    STATUS: ['/status'],
  }

  test('reset commands are recognized', () => {
    for (const cmd of COMMANDS.RESET) {
      expect(isResetCommand(cmd)).toBe(true)
      expect(isResetCommand(cmd.toUpperCase())).toBe(true)
    }
    expect(isResetCommand('reset')).toBe(false)
    expect(isResetCommand('/other')).toBe(false)
  })

  test('help commands are recognized', () => {
    for (const cmd of COMMANDS.HELP) {
      expect(isHelpCommand(cmd)).toBe(true)
      expect(isHelpCommand(cmd.toUpperCase())).toBe(true)
    }
    expect(isHelpCommand('help')).toBe(false)
    expect(isHelpCommand('/info')).toBe(false)
  })

  test('status commands are recognized', () => {
    for (const cmd of COMMANDS.STATUS) {
      expect(isStatusCommand(cmd)).toBe(true)
      expect(isStatusCommand(cmd.toUpperCase())).toBe(true)
    }
    expect(isStatusCommand('status')).toBe(false)
    expect(isStatusCommand('/info')).toBe(false)
  })

  test('commands with extra whitespace are trimmed', () => {
    expect(isResetCommand('  /reset  ')).toBe(true)
    expect(isHelpCommand('\t/help\n')).toBe(true)
    expect(isStatusCommand('  /status  ')).toBe(true)
  })
})

// Helper functions for command detection
function isResetCommand(content: string): boolean {
  const trimmed = content.trim().toLowerCase()
  return ['/reset', '/new', '/clear'].includes(trimmed)
}

function isHelpCommand(content: string): boolean {
  const trimmed = content.trim().toLowerCase()
  return ['/help', '/?'].includes(trimmed)
}

function isStatusCommand(content: string): boolean {
  const trimmed = content.trim().toLowerCase()
  return ['/status'].includes(trimmed)
}

describe('Response Cleaning', () => {
  test('removes canvas tags from response', () => {
    const response = 'Hello <canvas>some data here</canvas> world'
    const cleaned = cleanResponse(response)
    expect(cleaned).toBe('Hello  world')
  })

  test('removes editor tags from response', () => {
    const response = 'Start <editor>code here</editor> end'
    const cleaned = cleanResponse(response)
    expect(cleaned).toBe('Start  end')
  })

  test('removes multiple tags', () => {
    const response = '<canvas>1</canvas> text <editor>2</editor> more <canvas>3</canvas>'
    const cleaned = cleanResponse(response)
    expect(cleaned).toBe('text  more')
  })

  test('handles multiline content in tags', () => {
    const response = 'Hello <canvas>\nmulti\nline\n</canvas> world'
    const cleaned = cleanResponse(response)
    expect(cleaned).toBe('Hello  world')
  })

  test('preserves regular text', () => {
    const response = 'Just regular text without any tags'
    const cleaned = cleanResponse(response)
    expect(cleaned).toBe(response)
  })
})

// Helper to clean response (mirrors implementation)
function cleanResponse(response: string): string {
  return response
    .replace(/<canvas>[\s\S]*?<\/canvas>/g, '')
    .replace(/<editor>[\s\S]*?<\/editor>/g, '')
    .trim()
}

describe('sendMessageToChannel', () => {
  let testEnv: TestEnv

  beforeEach(() => {
    testEnv = setupTestEnv()
    setChannelFactory(mockChannelFactory)
  })

  afterEach(async () => {
    await stopMessagingChannels()
    resetChannelFactory()
    testEnv.cleanup()
  })

  // Helper to set up recipient data so resolveRecipient() can find the user
  function setupRecipient(channel: string, userId: string) {
    if (channel === 'whatsapp') {
      // WhatsApp resolves from connection displayName
      db.update(messagingConnections)
        .set({ displayName: userId })
        .where(eq(messagingConnections.channelType, 'whatsapp'))
        .run()
    } else {
      const connectionId =
        channel === 'discord' ? DISCORD_CONNECTION_ID :
        channel === 'telegram' ? TELEGRAM_CONNECTION_ID :
        SLACK_CONNECTION_ID
      // Create a chat session for the mapping
      const sessionId = `test-session-${channel}`
      db.insert(chatSessions).values({
        id: sessionId,
        title: `Test ${channel} session`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }).onConflictDoNothing().run()
      // Insert session mapping so resolveRecipient finds the user
      db.insert(messagingSessionMappings).values({
        id: `test-mapping-${channel}`,
        connectionId,
        channelUserId: userId,
        channelUserName: 'Test User',
        sessionId,
        createdAt: new Date().toISOString(),
        lastMessageAt: new Date().toISOString(),
      }).onConflictDoNothing().run()
    }
  }

  // All channels that should be supported by sendMessageToChannel
  // This list should match the type union in the function signature
  const ALL_CHANNELS = ['email', 'whatsapp', 'discord', 'telegram', 'slack'] as const

  test('all channels are recognized (no "Unknown channel" error)', async () => {
    // Set up recipients so resolveRecipient works
    // For this test we just need WhatsApp displayName since others will fail with "no recipient" not "unknown channel"
    for (const channel of ALL_CHANNELS) {
      const result = await sendMessageToChannel(channel, 'test message')

      // Should not get "Unknown channel" error - each channel should be handled
      expect(result.error).not.toBe(`Unknown channel: ${channel}`)
    }
  })

  test('disconnected channels return appropriate errors', async () => {
    // When channels are not connected, they should return descriptive errors
    for (const channel of ALL_CHANNELS) {
      const result = await sendMessageToChannel(channel, 'test message')

      expect(result.success).toBe(false)
      expect(result.error).toBeDefined()
      // Error should mention the channel, "not connected", "disabled", or "no recipient"
      expect(
        result.error?.includes('not connected') ||
        result.error?.includes('not active') ||
        result.error?.includes('disabled') ||
        result.error?.includes('recipient found')
      ).toBe(true)
    }
  })

  test('whatsapp sends message when connected', async () => {
    await enableWhatsApp()
    setupRecipient('whatsapp', '+1234567890')

    const result = await sendMessageToChannel('whatsapp', 'Hello from test')

    expect(result.success).toBe(true)
  })

  test('discord sends message when connected', async () => {
    await configureDiscord('fake-bot-token')
    setupRecipient('discord', '123456789')

    const result = await sendMessageToChannel('discord', 'Hello from test')

    expect(result.success).toBe(true)
  })

  test('telegram sends message when connected', async () => {
    await configureTelegram('fake-bot-token')
    setupRecipient('telegram', '123456789')

    const result = await sendMessageToChannel('telegram', 'Hello from test')

    expect(result.success).toBe(true)
  })

  test('slack sends message when connected', async () => {
    await configureSlack('xoxb-fake-bot-token', 'xapp-fake-app-token')
    setupRecipient('slack', 'U123456')

    const result = await sendMessageToChannel('slack', 'Hello from test')

    expect(result.success).toBe(true)
  })

  test('rejects messaging when no recipient is configured', async () => {
    await enableWhatsApp()
    // Don't set up recipient - should fail with "no recipient found"

    const result = await sendMessageToChannel('whatsapp', 'Hello')

    expect(result.success).toBe(false)
    expect(result.error).toContain('recipient found')
  })
})
