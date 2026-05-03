// Mattermost route tests using standard test environment
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createTestApp } from '../__tests__/fixtures/app'
import { setupTestEnv, type TestEnv } from '../__tests__/utils/env'
import { apps, db, projects, tasks } from '../db'
import { setFnoxValue } from '../lib/settings/fnox'

const TOKEN = 'test-secret-token-123'
const NOW = '2026-05-04T12:00:00.000Z'

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

function enableMattermost() {
  setFnoxValue('channels.mattermost.enabled', true)
  setFnoxValue('channels.mattermost.commandToken', TOKEN)
}

function configureMattermostClient() {
  setFnoxValue('channels.mattermost.serverUrl', 'https://mattermost.example.test')
  setFnoxValue('channels.mattermost.botToken', 'bot-token')
  setFnoxValue('channels.mattermost.channelId', 'fallback-channel')
}

function installMattermostFetchStub() {
  const calls: Array<{ url: string; body?: unknown }> = []
  global.fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const urlString = typeof url === 'string' ? url : url.toString()
    calls.push({
      url: urlString,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    })
    return Response.json({ id: 'mattermost-post' })
  }
  return calls
}

function insertTask(overrides: Partial<typeof tasks.$inferInsert> & { id: string; title: string }) {
  db.insert(tasks).values({
    status: 'TO_DO',
    position: 1,
    agent: 'claude',
    priority: 'medium',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }).run()
}

function insertApp(overrides: Partial<typeof apps.$inferInsert> & { id: string; name: string }) {
  db.insert(apps).values({
    repositoryId: 'repo-1',
    branch: 'main',
    composeFile: 'compose.yml',
    status: 'stopped',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }).run()
}

describe('Mattermost Routes', () => {
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

  describe('POST /api/mattermost/commands — subcommand dispatch', () => {
    beforeEach(() => {
      enableMattermost()
    })

    test('task subcommand returns detail card for an ID prefix', async () => {
      insertTask({ id: 'task-prefix-123', title: 'Prefix task', status: 'IN_PROGRESS' })
      const client = createTestApp()

      const res = await postForm(client, '/api/mattermost/commands', { token: TOKEN, text: 'task task-prefix' })
      const data = await res.json() as { props?: { attachments?: Array<{ pretext?: string }> } }

      expect(data.props?.attachments?.[0]?.pretext).toContain('Prefix task')
    })

    test('tasks subcommand routes filters through priority and project parsing', async () => {
      db.insert(projects).values({ id: 'proj-1', name: 'Mattermost', status: 'active', createdAt: NOW, updatedAt: NOW }).run()
      insertTask({ id: 'matched-task', title: 'Matched task', priority: 'high', projectId: 'proj-1' })
      insertTask({ id: 'wrong-priority', title: 'Wrong priority', priority: 'low', projectId: 'proj-1' })
      const client = createTestApp()

      const res = await postForm(client, '/api/mattermost/commands', { token: TOKEN, text: 'tasks high @Mattermost' })
      const data = await res.json() as { props?: { attachments?: Array<{ text?: string }> } }

      expect(data.props?.attachments?.[0]?.text).toContain('Matched task')
      expect(data.props?.attachments?.[0]?.text).not.toContain('Wrong priority')
    })

    test('deploy subcommand returns app detail by app name and not-found card for missing app', async () => {
      insertApp({ id: 'app-1', name: 'Fulcrum' })
      const client = createTestApp()

      const found = await postForm(client, '/api/mattermost/commands', { token: TOKEN, text: 'deploy Fulcrum' })
      const missing = await postForm(client, '/api/mattermost/commands', { token: TOKEN, text: 'deploy Missing' })
      const foundData = await found.json() as { props?: { attachments?: Array<{ pretext?: string }> } }
      const missingData = await missing.json() as { props?: { attachments?: Array<{ text?: string }> } }

      expect(foundData.props?.attachments?.[0]?.pretext).toBe('#### 🚀 Fulcrum')
      expect(missingData.props?.attachments?.[0]?.text).toContain('App "Missing" not found')
    })

    test('new subcommand opens create task dialog with title prefill', async () => {
      configureMattermostClient()
      const fetchCalls = installMattermostFetchStub()
      const client = createTestApp()

      const res = await postForm(client, '/api/mattermost/commands', {
        token: TOKEN,
        text: 'new Ship Mattermost tests',
        trigger_id: 'trigger-1',
      })
      const data = await res.json() as { props?: { attachments?: Array<{ text?: string }> } }

      expect(data.props?.attachments?.[0]?.text).toContain('Opening create task dialog')
      expect(fetchCalls[0].url).toContain('/api/v4/actions/dialogs/open')
      expect(fetchCalls[0].body).toMatchObject({
        trigger_id: 'trigger-1',
        dialog: { callback_id: 'create_task' },
      })
      const dialogBody = fetchCalls[0].body as { dialog: { elements: Array<{ name: string; default?: string }> } }
      expect(dialogBody.dialog.elements.find(element => element.name === 'title')?.default).toBe('Ship Mattermost tests')
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

  describe('POST /api/mattermost/actions — success paths', () => {
    beforeEach(() => {
      setFnoxValue('channels.mattermost.enabled', true)
    })

    test('status_change updates task status and returns refreshed detail card', async () => {
      insertTask({ id: 'status-task', title: 'Status task', status: 'TO_DO' })
      const { post } = createTestApp()

      const res = await post('/api/mattermost/actions', {
        context: { action: 'status_change', task_id: 'status-task', status: 'IN_PROGRESS' },
      })
      const data = await res.json() as { update?: { props?: { attachments?: Array<{ fields?: Array<{ title: string; value: string }> }> } } }
      const updated = db.select().from(tasks).all().find(task => task.id === 'status-task')

      expect(data.update?.props?.attachments?.[0]?.fields?.find(field => field.title === 'Status')?.value).toContain('IN_PROGRESS')
      expect(updated?.status).toBe('IN_PROGRESS')
    })

    test('change_priority updates priority and preserves priority select default option', async () => {
      insertTask({ id: 'priority-task', title: 'Priority task', priority: 'medium' })
      const { post } = createTestApp()

      const res = await post('/api/mattermost/actions', {
        context: { action: 'change_priority', task_id: 'priority-task' },
        selected_option: 'high',
      })
      const data = await res.json() as { update?: { props?: { attachments?: Array<{ actions?: Array<{ id: string; default_option?: { value: string } }> }> } } }
      const updated = db.select().from(tasks).all().find(task => task.id === 'priority-task')

      expect(updated?.priority).toBe('high')
      expect(data.update?.props?.attachments?.[0]?.actions?.find(action => action.id === 'change_priority')?.default_option?.value).toBe('high')
    })

    test('list and link actions return expected Mattermost payloads', async () => {
      insertTask({ id: 'listed-task', title: 'Listed task' })
      const { post } = createTestApp()

      const listRes = await post('/api/mattermost/actions', { context: { action: 'list_tasks', status: 'active' } })
      const detailRes = await post('/api/mattermost/actions', { context: { action: 'task_detail', task_id: 'listed-task' } })
      const linkRes = await post('/api/mattermost/actions', { context: { action: 'open_link', url: 'http://localhost:3000/tasks/listed-task' } })
      const listData = await listRes.json() as { update?: { props?: { attachments?: Array<{ text?: string }> } } }
      const detailData = await detailRes.json() as { update?: { props?: { attachments?: Array<{ pretext?: string }> } } }
      const linkData = await linkRes.json() as { ephemeral_text?: string }

      expect(listData.update?.props?.attachments?.[0]?.text).toContain('Listed task')
      expect(detailData.update?.props?.attachments?.[0]?.pretext).toContain('Listed task')
      expect(linkData.ephemeral_text).toBe('http://localhost:3000/tasks/listed-task')
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

  describe('POST /api/mattermost/dialogs — create task', () => {
    beforeEach(() => {
      setFnoxValue('channels.mattermost.enabled', true)
      configureMattermostClient()
      setFnoxValue('agent.defaultAgent', 'opencode')
    })

    test('returns title validation errors without creating a task', async () => {
      const { post } = createTestApp()

      const res = await post('/api/mattermost/dialogs', {
        callback_id: 'create_task',
        submission: { title: '' },
      })
      const data = await res.json() as { errors?: Record<string, string> }

      expect(data.errors?.title).toBe('Title is required')
      expect(db.select().from(tasks).all()).toHaveLength(0)
    })

    test('creates task through task-service-compatible fields and posts the task card', async () => {
      const fetchCalls = installMattermostFetchStub()
      const { post } = createTestApp()

      const res = await post('/api/mattermost/dialogs', {
        callback_id: 'create_task',
        channel_id: 'mattermost-channel',
        submission: {
          title: 'Dialog task',
          description: 'Created from Mattermost',
          priority: 'high',
          type: 'manual',
          project_id: '',
          repository_id: '',
          due_date: '2026-05-10',
        },
      })
      const data = await res.json()
      const created = db.select().from(tasks).all()[0]

      expect(data).toBeNull()
      expect(created).toMatchObject({
        title: 'Dialog task',
        description: 'Created from Mattermost',
        priority: 'high',
        type: null,
        dueDate: '2026-05-10',
        agent: 'opencode',
      })
      expect(fetchCalls[0].body).toMatchObject({
        channel_id: 'mattermost-channel',
        props: { attachments: [{ pretext: expect.stringContaining('Dialog task') }] },
      })
    })

    test('returns an error for unknown dialog callbacks', async () => {
      const { post } = createTestApp()

      const res = await post('/api/mattermost/dialogs', { callback_id: 'unknown_dialog' })
      const data = await res.json() as { errors?: Record<string, string> }

      expect(data.errors?.['']).toBe('Unknown dialog: unknown_dialog')
    })
  })
})
