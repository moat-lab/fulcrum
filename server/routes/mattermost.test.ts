// Mattermost route tests using standard test environment
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createTestApp } from '../__tests__/fixtures/app'
import { setupTestEnv, type TestEnv } from '../__tests__/utils/env'
import { setFnoxValue } from '../lib/settings/fnox'
import { db, tasks } from '../db'
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
    test('change_priority accepts Mattermost selected_option objects', async () => {
      const now = new Date().toISOString()
      db.insert(tasks).values({
        id: 'priority-test-1',
        title: 'Priority Test',
        status: 'TO_DO',
        position: 0,
        priority: 'medium',
        createdAt: now,
        updatedAt: now,
      }).run()

      const { post } = createTestApp()
      const res = await post('/api/mattermost/actions', {
        context: { action: 'change_priority', task_id: 'priority-test-1' },
        selected_option: { value: 'high' },
      })
      const data = await res.json() as { update?: unknown }
      const task = db.select().from(tasks).where(eq(tasks.id, 'priority-test-1')).get()
      expect(data.update).toBeDefined()
      expect(task?.priority).toBe('high')
    })

    test('cancel status_change requires confirmation before updating task', async () => {
      const now = new Date().toISOString()
      db.insert(tasks).values({
        id: 'cancel-test-1',
        title: 'Cancel Test',
        status: 'IN_PROGRESS',
        position: 0,
        createdAt: now,
        updatedAt: now,
      }).run()

      const { post } = createTestApp()
      const res = await post('/api/mattermost/actions', {
        context: { action: 'status_change', task_id: 'cancel-test-1', status: 'CANCELED' },
      })
      const data = await res.json() as { update?: { props?: { attachments?: Array<{ text?: string }> } } }
      const task = db.select().from(tasks).where(eq(tasks.id, 'cancel-test-1')).get()
      expect(data.update?.props?.attachments?.[0]?.text).toContain('Confirm canceling')
      expect(task?.status).toBe('IN_PROGRESS')
    })

    test('kill_agent validates task existence after confirmation', async () => {
      const { post } = createTestApp()
      const res = await post('/api/mattermost/actions', {
        context: { action: 'kill_agent', task_id: 'missing-task', confirm: true },
      })
      const data = await res.json() as { ephemeral_text?: string }
      expect(data.ephemeral_text).toContain('Task not found')
    })

    test('open_create_task_dialog rejects callbacks without trigger_id', async () => {
      const { post } = createTestApp()
      const res = await post('/api/mattermost/actions', {
        context: { action: 'open_create_task_dialog' },
      })
      const data = await res.json() as { ephemeral_text?: string }
      expect(data.ephemeral_text).toContain('missing Mattermost trigger_id')
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
})
