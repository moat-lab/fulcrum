// Mattermost route tests using standard test environment
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createTestApp } from '../__tests__/fixtures/app'
import { setupTestEnv, type TestEnv } from '../__tests__/utils/env'
import { setFnoxValue } from '../lib/settings/fnox'
import { db, repositories, tasks } from '../db'
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
  let originalFulcrumHost: string | undefined

  beforeEach(() => {
    testEnv = setupTestEnv()
    originalFulcrumHost = process.env.FULCRUM_HOST
    process.env.FULCRUM_HOST = 'fulcrum.example.test'
  })

  afterEach(() => {
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

    test('dashboard subcommand (empty text) returns in_channel', async () => {
      const client = createTestApp()
      const res = await postForm(client, '/api/mattermost/commands', { token: TOKEN, text: '', user_id: 'owner' })
      const data = await res.json() as { response_type: string }
      expect(data.response_type).toBe('in_channel')
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

  describe('POST /api/mattermost/dialogs — create_task worktree', () => {
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

      setFnoxValue('channels.mattermost.enabled', true)
      setFnoxValue('channels.mattermost.channelId', 'default-channel')
      setFnoxValue('channels.mattermost.serverUrl', 'https://mattermost.test')
      setFnoxValue('channels.mattermost.botToken', 'test-bot-token')
      setFnoxValue('channels.mattermost.commandToken', TOKEN)
      setFnoxValue('paths.worktrees', worktreesDir)

      const client = createTestApp()
      const originalFetch = globalThis.fetch
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url === 'https://mattermost.test/api/v4/posts' && init?.method === 'POST') {
          return new Response(JSON.stringify({ id: 'post-1' }), { status: 201, headers: { 'Content-Type': 'application/json' } })
        }
        return originalFetch(input, init)
      }) as typeof fetch
      try {
        const res = await client.post('/api/mattermost/dialogs', {
          token: TOKEN,
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
        globalThis.fetch = originalFetch
        repo.cleanup()
        rmSync(worktreesDir, { recursive: true, force: true })
      }
    })

    test('refuses when commandToken is empty', async () => {
      setFnoxValue('channels.mattermost.enabled', true)
      const { post } = createTestApp()
      const res = await post('/api/mattermost/dialogs', { token: 'anything', user_id: 'owner', callback_id: 'create_task' })
      const data = await res.json() as { errors?: Record<string, string> }
      expect(data.errors?.['']).toContain('commandToken not configured')
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

})
