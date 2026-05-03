// Mattermost route tests using standard test environment
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createTestApp } from '../__tests__/fixtures/app'
import { setupTestEnv, type TestEnv } from '../__tests__/utils/env'
import { setFnoxValue } from '../lib/settings/fnox'
import { db, tasks, taskLinks, taskRelationships } from '../db'

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

  describe('POST /api/mattermost/commands — slash cards', () => {
    beforeEach(() => {
      setFnoxValue('channels.mattermost.enabled', true)
      setFnoxValue('channels.mattermost.commandToken', TOKEN)
    })

    test('jobs subcommand returns the scheduled jobs card', async () => {
      const client = createTestApp()
      const res = await postForm(client, '/api/mattermost/commands', { token: TOKEN, text: 'jobs' })
      const data = await res.json() as { props?: { attachments?: Array<{ pretext?: string }> } }
      expect(data.props?.attachments?.[0]?.pretext).toContain('Scheduled Jobs')
    })

    test('tasks list paginates results beyond the first 10 tasks', async () => {
      const client = createTestApp()
      const now = new Date().toISOString()
      for (let i = 0; i < 11; i++) {
        db.insert(tasks).values({
          id: `task-${i}`,
          title: `Task ${i}`,
          status: 'TO_DO',
          position: i,
          agent: 'claude',
          priority: 'medium',
          createdAt: now,
          updatedAt: now,
        }).run()
      }

      const res = await postForm(client, '/api/mattermost/commands', { token: TOKEN, text: 'tasks' })
      const data = await res.json() as {
        props?: { attachments?: Array<{ pretext?: string; actions?: Array<{ name: string }> }> }
      }
      const attachment = data.props?.attachments?.[0]
      expect(attachment?.pretext).toContain('Page 1/2')
      expect(attachment?.actions?.some(action => action.name === 'Next →')).toBe(true)
    })

    test('task detail includes PR, links, and dependency fields', async () => {
      const client = createTestApp()
      const now = new Date().toISOString()
      db.insert(tasks).values([
        {
          id: 'main-task',
          title: 'Main task',
          status: 'TO_DO',
          position: 1,
          agent: 'claude',
          priority: 'medium',
          prUrl: 'https://github.com/Mouriya-Emma/fulcrum/pull/123',
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'dep-task',
          title: 'Dependency task',
          status: 'TO_DO',
          position: 2,
          agent: 'claude',
          priority: 'medium',
          createdAt: now,
          updatedAt: now,
        },
      ]).run()
      db.insert(taskLinks).values({
        id: 'link-1',
        taskId: 'main-task',
        url: 'https://example.com/spec',
        label: 'Spec',
        type: 'docs',
        createdAt: now,
      }).run()
      db.insert(taskRelationships).values({
        id: 'rel-1',
        taskId: 'main-task',
        relatedTaskId: 'dep-task',
        type: 'depends_on',
        source: 'manual',
        createdAt: now,
      }).run()

      const res = await postForm(client, '/api/mattermost/commands', { token: TOKEN, text: 'task main-task' })
      const data = await res.json() as {
        props?: { attachments?: Array<{ fields?: Array<{ title: string; value: string }> }> }
      }
      const fields = data.props?.attachments?.[0]?.fields ?? []
      expect(fields.some(field => field.title === 'PR' && field.value.includes('/pull/123'))).toBe(true)
      expect(fields.some(field => field.title === 'Links' && field.value.includes('Spec'))).toBe(true)
      expect(fields.some(field => field.title === 'Depends On' && field.value.includes('Dependency task'))).toBe(true)
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
