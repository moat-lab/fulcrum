import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { setupTestEnv, type TestEnv } from '../__tests__/utils/env'
import { sendNotification, testNotificationChannel, type NotificationPayload } from './notification-service'
import { updateNotificationSettings } from '../lib/settings'

// Mock the broadcast function since we don't want to actually send WebSocket messages in tests
mock.module('../websocket/terminal-ws', () => ({
  broadcast: () => {},
}))

// Track calls to sendNotificationViaMessaging for messaging-based notification tests
let messagingSendCalls: Array<{ channel: string; body: string }> = []
let messagingSendResult: { success: boolean; error?: string } = { success: true }
let mattermostNotifications: unknown[] = []

mock.module('./notification-messaging', () => ({
  sendNotificationViaMessaging: async (channel: string, body: string) => {
    messagingSendCalls.push({ channel, body })
    return messagingSendResult
  },
}))

mock.module('./mattermost/client', () => ({
  getActionsUrl: () => 'http://localhost:7777/api/mattermost/actions',
  fulcrumUrl: (path: string) => `http://localhost:7777${path}`,
  postNotification: async (attachment: unknown) => {
    mattermostNotifications.push(attachment)
    return { id: 'post-1' }
  },
}))

describe('Notification Service', () => {
  let testEnv: TestEnv

  beforeEach(async () => {
    testEnv = setupTestEnv()
    // Ensure notifications are enabled by default
    await updateNotificationSettings({ enabled: true })
    messagingSendCalls = []
    messagingSendResult = { success: true }
    mattermostNotifications = []
  })

  afterEach(() => {
    testEnv.cleanup()
  })

  describe('sendNotification', () => {
    test('returns empty array when notifications are disabled', async () => {
      await updateNotificationSettings({ enabled: false })

      const payload: NotificationPayload = {
        title: 'Test',
        message: 'Test message',
        type: 'task_status_change',
      }

      const results = await sendNotification(payload)
      expect(results).toEqual([])
    })

    test('sends notification when enabled', async () => {
      await updateNotificationSettings({
        enabled: true,
        sound: { enabled: false },
        slack: { enabled: false, webhookUrl: '' },
        discord: { enabled: false, webhookUrl: '' },
        pushover: { enabled: false, appToken: '', userKey: '' },
      })

      const payload: NotificationPayload = {
        title: 'Test',
        message: 'Test message',
        type: 'task_status_change',
      }

      // With all channels disabled, only UI broadcast happens (no results)
      const results = await sendNotification(payload)
      expect(results).toEqual([])
    })

    test('includes sound in results when sound is enabled', async () => {
      await updateNotificationSettings({
        enabled: true,
        sound: { enabled: true },
        slack: { enabled: false, webhookUrl: '' },
        discord: { enabled: false, webhookUrl: '' },
        pushover: { enabled: false, appToken: '', userKey: '' },
      })

      const payload: NotificationPayload = {
        title: 'Test',
        message: 'Test message',
        type: 'task_status_change',
      }

      const results = await sendNotification(payload)
      expect(results.some(r => r.channel === 'sound')).toBe(true)
    })

    test('handles different notification types', async () => {
      await updateNotificationSettings({ enabled: true })

      const types: NotificationPayload['type'][] = [
        'task_status_change',
        'pr_merged',
        'plan_complete',
        'deployment_success',
        'deployment_failed',
      ]

      for (const type of types) {
        const payload: NotificationPayload = {
          title: `Test ${type}`,
          message: 'Test message',
          type,
        }

        // Should not throw
        await sendNotification(payload)
      }
    })

    test('includes optional fields in payload', async () => {
      await updateNotificationSettings({ enabled: true })

      const payload: NotificationPayload = {
        title: 'Test',
        message: 'Test message',
        type: 'task_status_change',
        taskId: 'task-123',
        taskTitle: 'My Task',
        appId: 'app-456',
        appName: 'My App',
        url: 'https://example.com',
      }

      // Should not throw
      await sendNotification(payload)
    })
  })

  describe('testNotificationChannel', () => {
    describe('sound channel', () => {
      test('returns success for sound test', async () => {
        const result = await testNotificationChannel('sound')
        expect(result.channel).toBe('sound')
        expect(result.success).toBe(true)
      })
    })

    describe('slack channel', () => {
      test('returns error when webhook URL not configured', async () => {
        await updateNotificationSettings({
          slack: { enabled: true, webhookUrl: '' },
        })

        const result = await testNotificationChannel('slack')
        expect(result.channel).toBe('slack')
        expect(result.success).toBe(false)
        expect(result.error).toContain('Webhook URL not configured')
      })

      test('sends request to webhook URL', async () => {
        // Create a mock fetch that captures the request
        let capturedRequest: { url: string; body: string } | null = null
        const originalFetch = global.fetch
        global.fetch = async (url: string | URL | Request, init?: RequestInit) => {
          const urlStr = typeof url === 'string' ? url : url.toString()
          if (urlStr.includes('slack.com')) {
            capturedRequest = {
              url: urlStr,
              body: init?.body as string,
            }
            return new Response('ok', { status: 200 })
          }
          return originalFetch(url, init)
        }

        try {
          await updateNotificationSettings({
            slack: { enabled: true, webhookUrl: 'https://hooks.slack.com/services/test' },
          })

          const result = await testNotificationChannel('slack')
          expect(result.channel).toBe('slack')
          expect(result.success).toBe(true)
          expect(capturedRequest).not.toBeNull()
          expect(capturedRequest!.url).toBe('https://hooks.slack.com/services/test')
        } finally {
          global.fetch = originalFetch
        }
      })
    })

    describe('discord channel', () => {
      test('returns error when webhook URL not configured', async () => {
        await updateNotificationSettings({
          discord: { enabled: true, webhookUrl: '' },
        })

        const result = await testNotificationChannel('discord')
        expect(result.channel).toBe('discord')
        expect(result.success).toBe(false)
        expect(result.error).toContain('Webhook URL not configured')
      })

      test('sends request to webhook URL', async () => {
        let capturedRequest: { url: string; body: string } | null = null
        const originalFetch = global.fetch
        global.fetch = async (url: string | URL | Request, init?: RequestInit) => {
          const urlStr = typeof url === 'string' ? url : url.toString()
          if (urlStr.includes('discord.com')) {
            capturedRequest = {
              url: urlStr,
              body: init?.body as string,
            }
            return new Response('', { status: 204 })
          }
          return originalFetch(url, init)
        }

        try {
          await updateNotificationSettings({
            discord: { enabled: true, webhookUrl: 'https://discord.com/api/webhooks/test' },
          })

          const result = await testNotificationChannel('discord')
          expect(result.channel).toBe('discord')
          expect(result.success).toBe(true)
          expect(capturedRequest).not.toBeNull()
          expect(capturedRequest!.url).toBe('https://discord.com/api/webhooks/test')

          // Verify it sends an embed
          const body = JSON.parse(capturedRequest!.body)
          expect(body.embeds).toBeDefined()
          expect(body.embeds[0].title).toBe('Test Notification')
        } finally {
          global.fetch = originalFetch
        }
      })
    })

    describe('pushover channel', () => {
      test('returns error when app token not configured', async () => {
        await updateNotificationSettings({
          pushover: { enabled: true, appToken: '', userKey: 'user123' },
        })

        const result = await testNotificationChannel('pushover')
        expect(result.channel).toBe('pushover')
        expect(result.success).toBe(false)
        expect(result.error).toContain('not configured')
      })

      test('returns error when user key not configured', async () => {
        await updateNotificationSettings({
          pushover: { enabled: true, appToken: 'app123', userKey: '' },
        })

        const result = await testNotificationChannel('pushover')
        expect(result.channel).toBe('pushover')
        expect(result.success).toBe(false)
        expect(result.error).toContain('not configured')
      })

      test('sends request to Pushover API', async () => {
        let capturedRequest: { url: string; body: string } | null = null
        const originalFetch = global.fetch
        global.fetch = async (url: string | URL | Request, init?: RequestInit) => {
          const urlStr = typeof url === 'string' ? url : url.toString()
          if (urlStr.includes('pushover.net')) {
            capturedRequest = {
              url: urlStr,
              body: init?.body as string,
            }
            return new Response('{"status":1}', { status: 200 })
          }
          return originalFetch(url, init)
        }

        try {
          await updateNotificationSettings({
            pushover: { enabled: true, appToken: 'app-token', userKey: 'user-key' },
          })

          const result = await testNotificationChannel('pushover')
          expect(result.channel).toBe('pushover')
          expect(result.success).toBe(true)
          expect(capturedRequest).not.toBeNull()
          expect(capturedRequest!.url).toBe('https://api.pushover.net/1/messages.json')

          // Verify it sends correct payload
          const body = JSON.parse(capturedRequest!.body)
          expect(body.token).toBe('app-token')
          expect(body.user).toBe('user-key')
          expect(body.title).toBe('Test Notification')
        } finally {
          global.fetch = originalFetch
        }
      })
    })

    test('returns error for unknown channel', async () => {
      // @ts-expect-error - testing invalid channel
      const result = await testNotificationChannel('unknown')
      expect(result.success).toBe(false)
      expect(result.error).toContain('Unknown channel')
    })

    describe('whatsapp channel', () => {
      test('sends via messaging channel', async () => {
        messagingSendCalls = []
        messagingSendResult = { success: true }

        const result = await testNotificationChannel('whatsapp')
        expect(result.channel).toBe('whatsapp')
        expect(result.success).toBe(true)
        expect(messagingSendCalls).toHaveLength(1)
        expect(messagingSendCalls[0].channel).toBe('whatsapp')
        expect(messagingSendCalls[0].body).toContain('Test Notification')
      })

      test('returns error when messaging channel fails', async () => {
        messagingSendCalls = []
        messagingSendResult = { success: false, error: 'WhatsApp not connected' }

        const result = await testNotificationChannel('whatsapp')
        expect(result.channel).toBe('whatsapp')
        expect(result.success).toBe(false)
        expect(result.error).toContain('WhatsApp not connected')
      })
    })

    describe('telegram channel', () => {
      test('sends via messaging channel', async () => {
        messagingSendCalls = []
        messagingSendResult = { success: true }

        const result = await testNotificationChannel('telegram')
        expect(result.channel).toBe('telegram')
        expect(result.success).toBe(true)
        expect(messagingSendCalls).toHaveLength(1)
        expect(messagingSendCalls[0].channel).toBe('telegram')
      })
    })

    describe('slack with useMessagingChannel', () => {
      test('uses messaging channel when useMessagingChannel is true', async () => {
        messagingSendCalls = []
        messagingSendResult = { success: true }

        await updateNotificationSettings({
          slack: { enabled: true, webhookUrl: '', useMessagingChannel: true },
        })

        const result = await testNotificationChannel('slack')
        expect(result.channel).toBe('slack')
        expect(result.success).toBe(true)
        expect(messagingSendCalls).toHaveLength(1)
        expect(messagingSendCalls[0].channel).toBe('slack')
      })
    })

    describe('discord with useMessagingChannel', () => {
      test('uses messaging channel when useMessagingChannel is true', async () => {
        messagingSendCalls = []
        messagingSendResult = { success: true }

        await updateNotificationSettings({
          discord: { enabled: true, webhookUrl: '', useMessagingChannel: true },
        })

        const result = await testNotificationChannel('discord')
        expect(result.channel).toBe('discord')
        expect(result.success).toBe(true)
        expect(messagingSendCalls).toHaveLength(1)
        expect(messagingSendCalls[0].channel).toBe('discord')
      })
    })

    describe('gmail channel', () => {
      test('returns error when no account configured', async () => {
        const result = await testNotificationChannel('gmail')
        expect(result.channel).toBe('gmail')
        expect(result.success).toBe(false)
        expect(result.error).toContain('Google account not configured')
      })
    })
  })

  describe('sendNotification with messaging channels', () => {
    test('sends to whatsapp when enabled', async () => {
      messagingSendCalls = []
      messagingSendResult = { success: true }

      await updateNotificationSettings({
        enabled: true,
        sound: { enabled: false },
        slack: { enabled: false },
        discord: { enabled: false },
        pushover: { enabled: false },
        whatsapp: { enabled: true },
        telegram: { enabled: false },
      })

      const payload: NotificationPayload = {
        title: 'Deploy Done',
        message: 'App deployed successfully',
        type: 'deployment_success',
      }

      const results = await sendNotification(payload)
      expect(results.some(r => r.channel === 'whatsapp' && r.success)).toBe(true)
      expect(messagingSendCalls.some(c => c.channel === 'whatsapp')).toBe(true)
    })

    test('sends to telegram when enabled', async () => {
      messagingSendCalls = []
      messagingSendResult = { success: true }

      await updateNotificationSettings({
        enabled: true,
        sound: { enabled: false },
        slack: { enabled: false },
        discord: { enabled: false },
        pushover: { enabled: false },
        whatsapp: { enabled: false },
        telegram: { enabled: true },
      })

      const payload: NotificationPayload = {
        title: 'PR Merged',
        message: 'Pull request was merged',
        type: 'pr_merged',
      }

      const results = await sendNotification(payload)
      expect(results.some(r => r.channel === 'telegram' && r.success)).toBe(true)
      expect(messagingSendCalls.some(c => c.channel === 'telegram')).toBe(true)
    })

    test('gmail notification returns error when no account configured', async () => {
      await updateNotificationSettings({
        enabled: true,
        sound: { enabled: false },
        slack: { enabled: false },
        discord: { enabled: false },
        pushover: { enabled: false },
        whatsapp: { enabled: false },
        telegram: { enabled: false },
        gmail: { enabled: true },
      })

      const payload: NotificationPayload = {
        title: 'Test Gmail',
        message: 'Gmail notification test',
        type: 'task_status_change',
      }

      const results = await sendNotification(payload)
      expect(results.some(r => r.channel === 'gmail' && !r.success)).toBe(true)
    })

    test('sends Mattermost task notification card with action buttons when enabled', async () => {
      await updateNotificationSettings({
        enabled: true,
        sound: { enabled: false },
        slack: { enabled: false },
        discord: { enabled: false },
        pushover: { enabled: false },
        whatsapp: { enabled: false },
        telegram: { enabled: false },
        gmail: { enabled: false },
        mattermost: { enabled: true },
      })

      const payload: NotificationPayload = {
        title: 'Task status changed',
        message: 'Task moved from TO_DO to IN_PROGRESS by user',
        type: 'task_status_change',
        taskId: 'task-123',
        taskTitle: 'Mattermost task',
      }

      const results = await sendNotification(payload)
      const attachment = mattermostNotifications[0] as { fields?: Array<{ title: string; value: string }>; actions?: Array<{ id: string; integration: { context: Record<string, unknown> } }> }

      expect(results.some(r => r.channel === 'mattermost' && r.success)).toBe(true)
      expect(attachment.fields?.some(f => f.title === 'Task' && f.value === 'Mattermost task')).toBe(true)
      expect(attachment.actions?.some(a => a.id === 'viewTask' && a.integration.context.task_id === 'task-123')).toBe(true)
      expect(attachment.actions?.some(a => a.id === 'nextStatus' && a.integration.context.status === 'IN_REVIEW')).toBe(true)
    })

    test('sends Mattermost failed deployment card with logs retry and rollback actions', async () => {
      await updateNotificationSettings({
        enabled: true,
        sound: { enabled: false },
        mattermost: { enabled: true },
      })

      const payload: NotificationPayload = {
        title: 'Deployment failed',
        message: 'Build failed after 2m',
        type: 'deployment_failed',
        appId: 'app-123',
        appName: 'fulcrum-web',
      }

      await sendNotification(payload)
      const attachment = mattermostNotifications[0] as { color?: string; fields?: Array<{ title: string; value: string }>; actions?: Array<{ id: string }> }

      expect(attachment.color).toBe('#EF4444')
      expect(attachment.fields?.some(f => f.title === 'App' && f.value === 'fulcrum-web')).toBe(true)
      expect(attachment.actions?.map(a => a.id)).toEqual(['logs', 'retry', 'rollback'])
    })

    test('sends slack via messaging when useMessagingChannel is true', async () => {
      messagingSendCalls = []
      messagingSendResult = { success: true }

      await updateNotificationSettings({
        enabled: true,
        sound: { enabled: false },
        slack: { enabled: true, useMessagingChannel: true },
        discord: { enabled: false },
        pushover: { enabled: false },
        whatsapp: { enabled: false },
        telegram: { enabled: false },
      })

      const payload: NotificationPayload = {
        title: 'Test',
        message: 'Test message',
        type: 'task_status_change',
      }

      const results = await sendNotification(payload)
      expect(results.some(r => r.channel === 'slack' && r.success)).toBe(true)
      expect(messagingSendCalls.some(c => c.channel === 'slack')).toBe(true)
    })
  })
})
