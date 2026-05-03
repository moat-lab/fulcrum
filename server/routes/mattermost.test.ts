// Mattermost route tests using standard test environment
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createTestApp } from '../__tests__/fixtures/app'
import { setupTestEnv, type TestEnv } from '../__tests__/utils/env'
import { setFnoxValue } from '../lib/settings/fnox'
import { db, tasks } from '../db'

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

  describe('POST /api/mattermost/commands — card links', () => {
    beforeEach(() => {
      setFnoxValue('channels.mattermost.enabled', true)
      setFnoxValue('channels.mattermost.commandToken', TOKEN)
    })

    test('dashboard card renders an inline Fulcrum Markdown link instead of an open button', async () => {
      const client = createTestApp()
      const res = await postForm(client, '/api/mattermost/commands', { token: TOKEN, text: '' })
      const data = await res.json() as {
        props?: { attachments?: Array<{ text?: string; actions?: Array<{ id?: string; name?: string }> }> }
      }
      const attachment = data.props?.attachments?.[0]
      expect(attachment?.text).toContain('[Open in Fulcrum ↗](')
      expect(attachment?.actions?.some(action => action.id === 'open' || action.name === 'Open ↗')).toBe(false)
    })

    test('task detail card keeps task actions and renders the Fulcrum link in text', async () => {
      const now = new Date().toISOString()
      db.insert(tasks).values({
        id: 'mattermost-link-task',
        title: 'Inline link task',
        description: 'Task description',
        status: 'TO_DO',
        position: 1,
        createdAt: now,
        updatedAt: now,
      }).run()

      const client = createTestApp()
      const res = await postForm(client, '/api/mattermost/commands', { token: TOKEN, text: 'task mattermost-link-task' })
      const data = await res.json() as {
        props?: { attachments?: Array<{ text?: string; actions?: Array<{ id?: string; name?: string }> }> }
      }
      const attachment = data.props?.attachments?.[0]
      expect(attachment?.text).toContain('Task description')
      expect(attachment?.text).toContain('[Open in Fulcrum ↗](')
      expect(attachment?.actions?.some(action => action.id === 'open' || action.name === 'Open ↗')).toBe(false)
      expect(attachment?.actions?.some(action => action.id === 'start')).toBe(true)
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
})
