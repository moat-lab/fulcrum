// Mattermost route tests using standard test environment
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createTestApp } from '../__tests__/fixtures/app'
import { setupTestEnv, type TestEnv } from '../__tests__/utils/env'
import { setFnoxValue } from '../lib/settings/fnox'
import { getSettings } from '../lib/settings'
import { db, tasks, tags, taskTags } from '../db'
import { eq } from 'drizzle-orm'

const TOKEN = 'test-secret-token-123'

function urlencodedBody(params: Record<string, string>): string {
  return new URLSearchParams(params).toString()
}

function postForm(client: ReturnType<typeof createTestApp>, path: string, params: Record<string, string>) {
  return client.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: urlencodedBody(params),
  })
}

describe('Mattermost Routes', () => {
  let testEnv: TestEnv

  beforeEach(() => {
    testEnv = setupTestEnv()
  })

  afterEach(() => {
    testEnv.cleanup()
  })

  describe('POST /api/mattermost/commands — gating', () => {
    test('returns disabled message when channels.mattermost.enabled is false (default)', async () => {
      const client = createTestApp()
      const res = await postForm(client, '/api/mattermost/commands', { token: '', text: '' })
      const data = await res.json() as { response_type: string; text: string }
      expect(data.response_type).toBe('ephemeral')
      expect(data.text).toContain('disabled')
    })

    test('refuses when commandToken is empty (fail-closed instead of fail-open)', async () => {
      setFnoxValue('channels.mattermost.enabled', true)
      const client = createTestApp()
      const res = await postForm(client, '/api/mattermost/commands', { token: 'anything', text: '' })
      const data = await res.json() as { response_type: string; text: string }
      expect(data.text).toContain('commandToken not configured')
    })

    test('rejects request with invalid token', async () => {
      setFnoxValue('channels.mattermost.enabled', true)
      setFnoxValue('channels.mattermost.commandToken', TOKEN)
      const client = createTestApp()
      const res = await postForm(client, '/api/mattermost/commands', { token: 'wrong', text: '' })
      const data = await res.json() as { text: string }
      expect(data.text).toBe('Invalid command token.')
    })
  })

  describe('POST /api/mattermost/commands — response_type', () => {
    beforeEach(() => {
      setFnoxValue('channels.mattermost.enabled', true)
      setFnoxValue('channels.mattermost.commandToken', TOKEN)
    })

    test('dashboard subcommand (empty text) returns in_channel', async () => {
      const client = createTestApp()
      const res = await postForm(client, '/api/mattermost/commands', { token: TOKEN, text: '' })
      const data = await res.json() as { response_type: string }
      expect(data.response_type).toBe('in_channel')
    })

    test('tasks subcommand returns ephemeral', async () => {
      const client = createTestApp()
      const res = await postForm(client, '/api/mattermost/commands', { token: TOKEN, text: 'tasks' })
      const data = await res.json() as { response_type: string }
      expect(data.response_type).toBe('ephemeral')
    })

    test('help subcommand returns ephemeral', async () => {
      const client = createTestApp()
      const res = await postForm(client, '/api/mattermost/commands', { token: TOKEN, text: 'help' })
      const data = await res.json() as { response_type: string }
      expect(data.response_type).toBe('ephemeral')
    })

    test('deploy subcommand returns in_channel (deployments are channel-visible events)', async () => {
      const client = createTestApp()
      const res = await postForm(client, '/api/mattermost/commands', { token: TOKEN, text: 'deploy' })
      const data = await res.json() as { response_type: string }
      expect(data.response_type).toBe('in_channel')
    })
  })

  describe('POST /api/mattermost/commands — dispatchCommand default', () => {
    beforeEach(() => {
      setFnoxValue('channels.mattermost.enabled', true)
      setFnoxValue('channels.mattermost.commandToken', TOKEN)
    })

    test('unknown subcommand returns help, not greedy task-id match', async () => {
      const client = createTestApp()
      const res = await postForm(client, '/api/mattermost/commands', {
        token: TOKEN,
        text: 'randomgarbagesubcommand',
      })
      const data = await res.json() as {
        props?: { attachments?: Array<{ pretext?: string }> }
      }
      const pretext = data.props?.attachments?.[0]?.pretext ?? ''
      expect(pretext).toContain('Fulcrum Commands')
    })
  })

  describe('POST /api/mattermost/actions — gating', () => {
    test('returns disabled when channels.mattermost.enabled is false', async () => {
      const { post } = createTestApp()
      const res = await post('/api/mattermost/actions', { context: { action: 'monitor' } })
      const data = await res.json() as { ephemeral_text?: string }
      expect(data.ephemeral_text).toContain('disabled')
    })
  })

  describe('POST /api/mattermost/actions — enum validation', () => {
    beforeEach(() => {
      setFnoxValue('channels.mattermost.enabled', true)
    })

    test('status_change rejects unknown status value', async () => {
      const { post } = createTestApp()
      const res = await post('/api/mattermost/actions', {
        context: { action: 'status_change', task_id: 'fake-id', status: 'GARBAGE' },
      })
      const data = await res.json() as { ephemeral_text?: string }
      expect(data.ephemeral_text).toContain('Invalid status: GARBAGE')
    })

    test('change_priority rejects unknown priority value', async () => {
      const { post } = createTestApp()
      const res = await post('/api/mattermost/actions', {
        context: { action: 'change_priority', task_id: 'fake-id' },
        selected_option: 'critical',
      })
      const data = await res.json() as { ephemeral_text?: string }
      expect(data.ephemeral_text).toContain('Invalid priority')
    })

    test('change_priority rejects missing selected_option', async () => {
      const { post } = createTestApp()
      const res = await post('/api/mattermost/actions', {
        context: { action: 'change_priority', task_id: 'fake-id' },
      })
      const data = await res.json() as { ephemeral_text?: string }
      expect(data.ephemeral_text).toContain('Invalid priority')
    })

    test('rollback_app rejects missing deployment ID', async () => {
      const { post } = createTestApp()
      const res = await post('/api/mattermost/actions', {
        context: { action: 'rollback_app', app_id: 'fake-id' },
      })
      const data = await res.json() as { ephemeral_text?: string }
      expect(data.ephemeral_text).toContain('No deployment selected')
    })
  })

  describe('POST /api/mattermost/dialogs — gating', () => {
    test('returns disabled when channels.mattermost.enabled is false', async () => {
      const { post } = createTestApp()
      const res = await post('/api/mattermost/dialogs', { callback_id: 'create_task' })
      const data = await res.json() as { errors?: Record<string, string> }
      expect(data.errors?.['']).toContain('disabled')
    })
  })

  describe('POST /api/mattermost/dialogs — submissions', () => {
    beforeEach(() => {
      setFnoxValue('channels.mattermost.enabled', true)
      setFnoxValue('channels.mattermost.serverUrl', 'https://mattermost.example.test')
      setFnoxValue('channels.mattermost.botToken', 'bot-token')
      setFnoxValue('channels.mattermost.channelId', 'default-channel')
      globalThis.fetch = async () => new Response(JSON.stringify({ id: 'post-id' }), { status: 200 })
    })

    test('create_task creates a task with optional tags and posts a card', async () => {
      const { post } = createTestApp()
      const res = await post('/api/mattermost/dialogs', {
        callback_id: 'create_task',
        channel_id: 'mattermost-channel',
        submission: {
          title: 'Ship Mattermost dialogs',
          description: 'Create task from dialog',
          priority: 'high',
          type: 'manual',
          due_date: '2026-05-10',
          tags: 'mattermost, dialogs, mattermost',
        },
      })

      expect(await res.json()).toBeNull()
      const createdTask = db.select().from(tasks).where(eq(tasks.title, 'Ship Mattermost dialogs')).get()
      expect(createdTask?.priority).toBe('high')
      expect(createdTask?.type).toBeNull()
      expect(createdTask?.dueDate).toBe('2026-05-10')
      const createdTags = db.select().from(tags).all().map(tag => tag.name).sort()
      expect(createdTags).toEqual(['dialogs', 'mattermost'])
      const joins = db.select().from(taskTags).all()
      expect(joins).toHaveLength(2)
    })

    test('create_task rejects invalid date text', async () => {
      const { post } = createTestApp()
      const res = await post('/api/mattermost/dialogs', {
        callback_id: 'create_task',
        submission: { title: 'Bad date task', due_date: 'tomorrow' },
      })

      const data = await res.json() as { errors?: Record<string, string> }
      expect(data.errors?.due_date).toContain('YYYY-MM-DD')
      expect(db.select().from(tasks).where(eq(tasks.title, 'Bad date task')).get()).toBeUndefined()
    })

    test('configure_settings stores non-secret fields and keeps blank secrets unchanged', async () => {
      setFnoxValue('channels.mattermost.botToken', 'existing-bot-token')
      setFnoxValue('channels.mattermost.commandToken', 'existing-command-token')
      const { post } = createTestApp()
      const res = await post('/api/mattermost/dialogs', {
        callback_id: 'configure_settings',
        submission: {
          server_url: 'https://mattermost.internal',
          bot_token: '',
          team_id: 'team-id',
          channel_id: 'channel-id',
          command_token: '',
        },
      })

      expect(await res.json()).toBeNull()
      expect(getSettings().channels.mattermost.enabled).toBe(true)
      expect(getSettings().channels.mattermost.serverUrl).toBe('https://mattermost.internal')
      expect(getSettings().channels.mattermost.teamId).toBe('team-id')
      expect(getSettings().channels.mattermost.channelId).toBe('channel-id')
      expect(getSettings().channels.mattermost.botToken).toBe('existing-bot-token')
      expect(getSettings().channels.mattermost.commandToken).toBe('existing-command-token')
    })
  })
})
