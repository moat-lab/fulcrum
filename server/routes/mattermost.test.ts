// Mattermost route tests using standard test environment
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createTestApp } from '../__tests__/fixtures/app'
import { setupTestEnv, type TestEnv } from '../__tests__/utils/env'
import { apps, db, projects, repositories, tasks } from '../db'
import { setFnoxValue } from '../lib/settings/fnox'
import { createTestGitRepo } from '../__tests__/fixtures/git'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fulcrumUrl, getActionsUrl } from '../services/mattermost/client'

describe('Mattermost callback URLs', () => {
  let testEnv: TestEnv
  let originalFulcrumHost: string | undefined

  beforeEach(() => {
    testEnv = setupTestEnv()
    originalFulcrumHost = process.env.FULCRUM_HOST
    delete process.env.FULCRUM_HOST
  })

  afterEach(() => {
    if (originalFulcrumHost === undefined) {
      delete process.env.FULCRUM_HOST
    } else {
      process.env.FULCRUM_HOST = originalFulcrumHost
    }
    testEnv.cleanup()
  })

  test('uses localhost only while Mattermost is disabled', () => {
    expect(getActionsUrl()).toBe('http://localhost:7777/api/mattermost/actions')
  })

  test('fails closed instead of emitting localhost callback URLs when Mattermost is enabled without FULCRUM_HOST', () => {
    setFnoxValue('channels.mattermost.enabled', true)

    expect(() => getActionsUrl()).toThrow('Mattermost callback host not configured')
    expect(() => fulcrumUrl('/tasks')).toThrow('Mattermost callback host not configured')
  })

  test('uses FULCRUM_HOST for Mattermost callback URLs when configured', () => {
    setFnoxValue('channels.mattermost.enabled', true)
    process.env.FULCRUM_HOST = 'fulcrum.example.test'

    expect(getActionsUrl()).toBe('http://fulcrum.example.test:7777/api/mattermost/actions')
    expect(fulcrumUrl('/tasks')).toBe('http://fulcrum.example.test:7777/tasks')
  })
})

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
  let originalFulcrumHost: string | undefined

  beforeEach(() => {
    testEnv = setupTestEnv()
    originalFetch = global.fetch
    originalFulcrumHost = process.env.FULCRUM_HOST
    process.env.FULCRUM_HOST = 'fulcrum.example.test'
  })

  afterEach(() => {
    global.fetch = originalFetch
    if (originalFulcrumHost === undefined) {
      delete process.env.FULCRUM_HOST
    } else {
      process.env.FULCRUM_HOST = originalFulcrumHost
    }
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
      const res = await postForm(client, '/api/mattermost/commands', { token: 'wrong', text: '', user_id: 'owner' })
      const data = await res.json() as { text: string }
      expect(data.text).toBe('Invalid command token.')
    })

    test('rejects request from user outside allowedUserIds', async () => {
      setFnoxValue('channels.mattermost.enabled', true)
      setFnoxValue('channels.mattermost.commandToken', TOKEN)
      setFnoxValue('channels.mattermost.allowedUserIds', ['owner'])
      const client = createTestApp()
      const res = await postForm(client, '/api/mattermost/commands', { token: TOKEN, text: 'help', user_id: 'stranger' })
      const data = await res.json() as { text: string }
      expect(data.text).toBe('Mattermost user not allowed.')
    })
  })

  describe('POST /api/mattermost/commands — response_type', () => {
    beforeEach(() => {
      setFnoxValue('channels.mattermost.enabled', true)
      setFnoxValue('channels.mattermost.commandToken', TOKEN)
    })

    test('dashboard subcommand (empty text) returns in_channel with Fulcrum bot attribution', async () => {
      const client = createTestApp()
      const res = await postForm(client, '/api/mattermost/commands', { token: TOKEN, text: '', user_id: 'owner' })
      const data = await res.json() as { response_type: string; username?: string; icon_url?: string }
      expect(data.response_type).toBe('in_channel')
      expect(data.username).toBe('fulcrum')
      expect(data.icon_url).toEndWith('/icon-192.png')
    })

    test('tasks subcommand returns ephemeral', async () => {
      const client = createTestApp()
      const res = await postForm(client, '/api/mattermost/commands', { token: TOKEN, text: 'tasks', user_id: 'owner' })
      const data = await res.json() as { response_type: string }
      expect(data.response_type).toBe('ephemeral')
    })

    test('help subcommand returns ephemeral', async () => {
      const client = createTestApp()
      const res = await postForm(client, '/api/mattermost/commands', { token: TOKEN, text: 'help', user_id: 'owner' })
      const data = await res.json() as { response_type: string }
      expect(data.response_type).toBe('ephemeral')
    })

    test('deploy subcommand returns in_channel (deployments are channel-visible events)', async () => {
      const client = createTestApp()
      const res = await postForm(client, '/api/mattermost/commands', { token: TOKEN, text: 'deploy', user_id: 'owner' })
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
        user_id: 'owner',
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

    test('refuses when commandToken is empty', async () => {
      setFnoxValue('channels.mattermost.enabled', true)
      const { post } = createTestApp()
      const res = await post('/api/mattermost/actions', { token: 'anything', user_id: 'owner', context: { action: 'monitor' } })
      const data = await res.json() as { ephemeral_text?: string }
      expect(data.ephemeral_text).toContain('commandToken not configured')
    })

    test('rejects invalid token', async () => {
      setFnoxValue('channels.mattermost.enabled', true)
      setFnoxValue('channels.mattermost.commandToken', TOKEN)
      const { post } = createTestApp()
      const res = await post('/api/mattermost/actions', { token: 'wrong', user_id: 'owner', context: { action: 'monitor' } })
      const data = await res.json() as { ephemeral_text?: string }
      expect(data.ephemeral_text).toBe('Invalid command token.')
    })
  })

  describe('POST /api/mattermost/actions — enum validation', () => {
    beforeEach(() => {
      setFnoxValue('channels.mattermost.enabled', true)
      setFnoxValue('channels.mattermost.commandToken', TOKEN)
    })

    test('status_change rejects unknown status value', async () => {
      const { post } = createTestApp()
      const res = await post('/api/mattermost/actions', {
        token: TOKEN,
        user_id: 'owner',
        context: { action: 'status_change', task_id: 'fake-id', status: 'GARBAGE' },
      })
      const data = await res.json() as { ephemeral_text?: string }
      expect(data.ephemeral_text).toContain('Invalid status: GARBAGE')
    })

    test('change_priority rejects unknown priority value', async () => {
      const { post } = createTestApp()
      const res = await post('/api/mattermost/actions', {
        token: TOKEN,
        user_id: 'owner',
        context: { action: 'change_priority', task_id: 'fake-id' },
        selected_option: 'critical',
      })
      const data = await res.json() as { ephemeral_text?: string }
      expect(data.ephemeral_text).toContain('Invalid priority')
    })

    test('change_priority rejects missing selected_option', async () => {
      const { post } = createTestApp()
      const res = await post('/api/mattermost/actions', {
        token: TOKEN,
        user_id: 'owner',
        context: { action: 'change_priority', task_id: 'fake-id' },
      })
      const data = await res.json() as { ephemeral_text?: string }
      expect(data.ephemeral_text).toContain('Invalid priority')
    })

    test('rollback_app rejects missing deployment ID', async () => {
      const { post } = createTestApp()
      const res = await post('/api/mattermost/actions', {
        token: TOKEN,
        user_id: 'owner',
        context: { action: 'rollback_app', app_id: 'fake-id' },
      })
      const data = await res.json() as { ephemeral_text?: string }
      expect(data.ephemeral_text).toContain('No deployment selected')
    })
  })

  describe('POST /api/mattermost/actions — success paths', () => {
    beforeEach(() => {
      enableMattermost()
    })

    test('status_change updates task status and returns refreshed detail card', async () => {
      insertTask({ id: 'status-task', title: 'Status task', status: 'TO_DO' })
      const { post } = createTestApp()

      const res = await post('/api/mattermost/actions', {
        token: TOKEN,
        user_id: 'owner',
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
        token: TOKEN,
        user_id: 'owner',
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

      const listRes = await post('/api/mattermost/actions', { token: TOKEN, user_id: 'owner', context: { action: 'list_tasks', status: 'active' } })
      const detailRes = await post('/api/mattermost/actions', { token: TOKEN, user_id: 'owner', context: { action: 'task_detail', task_id: 'listed-task' } })
      const linkRes = await post('/api/mattermost/actions', { token: TOKEN, user_id: 'owner', context: { action: 'open_link', url: 'http://localhost:3000/tasks/listed-task' } })
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
      const res = await post('/api/mattermost/dialogs', { token: 'anything', user_id: 'owner', callback_id: 'create_task' })
      const data = await res.json() as { errors?: Record<string, string> }
      expect(data.errors?.['']).toContain('disabled')
    })

    test('rejects invalid token', async () => {
      setFnoxValue('channels.mattermost.enabled', true)
      setFnoxValue('channels.mattermost.commandToken', TOKEN)
      const { post } = createTestApp()
      const res = await post('/api/mattermost/dialogs', { token: 'wrong', user_id: 'owner', callback_id: 'create_task' })
      const data = await res.json() as { errors?: Record<string, string> }
      expect(data.errors?.['']).toBe('Invalid command token.')
    })
  })

  describe('POST /api/mattermost/dialogs — create task', () => {
    beforeEach(() => {
      enableMattermost()
      configureMattermostClient()
      setFnoxValue('agent.defaultAgent', 'opencode')
    })

    test('returns title validation errors without creating a task', async () => {
      const { post } = createTestApp()

      const res = await post('/api/mattermost/dialogs', {
        token: TOKEN,
        user_id: 'owner',
        callback_id: 'create_task',
        submission: { title: '' },
      })
      const data = await res.json() as { errors?: Record<string, string> }

      expect(data.errors?.title).toBe('Title is required')
      expect(db.select().from(tasks).all()).toHaveLength(0)
    })

    test('creates manual task through task-service-compatible fields and posts the task card', async () => {
      const fetchCalls = installMattermostFetchStub()
      const { post } = createTestApp()

      const res = await post('/api/mattermost/dialogs', {
        token: TOKEN,
        user_id: 'owner',
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

    test('creates worktree task through shared task creation path with generated worktree info', async () => {
      const repo = createTestGitRepo()
      const worktreesDir = mkdtempSync(join(tmpdir(), 'fulcrum-mattermost-worktrees-'))
      const now = new Date().toISOString()
      db.insert(repositories)
        .values({
          id: 'repo-1',
          path: repo.path,
          displayName: 'Test Repo',
          lastBaseBranch: repo.defaultBranch,
          createdAt: now,
          updatedAt: now,
        })
        .run()
      setFnoxValue('paths.worktrees', worktreesDir)
      installMattermostFetchStub()

      const { post } = createTestApp()
      try {
        const res = await post('/api/mattermost/dialogs', {
          token: TOKEN,
          user_id: 'owner',
          callback_id: 'create_task',
          channel_id: 'channel-1',
          submission: {
            title: 'Worktree Task',
            type: 'worktree',
            repository_id: 'repo-1',
            priority: 'high',
            due_date: '2026-05-04',
          },
        })

        const created = db.select().from(tasks).all()
        expect(res.status).toBe(200)
        expect(await res.json()).toBeNull()
        expect(created).toHaveLength(1)
        expect(created[0].title).toBe('Worktree Task')
        expect(created[0].type).toBe('worktree')
        expect(created[0].repoPath).toBe(repo.path)
        expect(created[0].repoName).toBe('Test Repo')
        expect(created[0].baseBranch).toBe(repo.defaultBranch)
        expect(created[0].branch).toContain('worktree-task-')
        expect(created[0].worktreePath).toContain('worktree-task-')
        expect(existsSync(created[0].worktreePath!)).toBe(true)
        expect(created[0].status).toBe('TO_DO')
        expect(created[0].startedAt).toBeNull()
      } finally {
        repo.cleanup()
        rmSync(worktreesDir, { recursive: true, force: true })
      }
    })

    test('returns an error for unknown dialog callbacks', async () => {
      const { post } = createTestApp()

      const res = await post('/api/mattermost/dialogs', { token: TOKEN, user_id: 'owner', callback_id: 'unknown_dialog' })
      const data = await res.json() as { errors?: Record<string, string> }

      expect(data.errors?.['']).toBe('Unknown dialog: unknown_dialog')
    })
  })
})
