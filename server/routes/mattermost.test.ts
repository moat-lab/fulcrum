// Mattermost route tests using standard test environment
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { createTestApp } from '../__tests__/fixtures/app'
import { setupTestEnv, type TestEnv } from '../__tests__/utils/env'
import { setFnoxValue } from '../lib/settings/fnox'
import { eq } from 'drizzle-orm'
import { db, tasks, terminals } from '../db'

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

  describe('POST /api/mattermost/actions — diff preview', () => {
    beforeEach(() => {
      setFnoxValue('channels.mattermost.enabled', true)
      setFnoxValue('editor.host', 'http://localhost:18888')
    })

    test('task_detail shows start and restart agent operation-chain actions', async () => {
      const now = new Date().toISOString()
      db.insert(tasks).values({
        id: 'task-agent-chain',
        title: 'Run agent chain',
        status: 'TO_DO',
        position: 1,
        priority: 'medium',
        worktreePath: '/tmp/fulcrum-mm-agent-chain',
        agent: 'claude',
        createdAt: now,
        updatedAt: now,
      }).run()

      const { post } = createTestApp()
      const todoRes = await post('/api/mattermost/actions', {
        context: { action: 'task_detail', task_id: 'task-agent-chain' },
      })
      const todoData = await todoRes.json() as { update?: { props?: { attachments?: Array<{ actions?: Array<{ name: string }> }> } } }
      expect(todoData.update?.props?.attachments?.[0]?.actions?.map(action => action.name)).toContain('🤖 Start Agent')

      db.update(tasks).set({ status: 'IN_PROGRESS', updatedAt: now }).where(eq(tasks.id, 'task-agent-chain')).run()
      db.insert(terminals).values({
        id: 'terminal-agent-chain',
        name: 'claude: Run agent chain',
        cwd: '/tmp/fulcrum-mm-agent-chain',
        cols: 120,
        rows: 30,
        tmuxSession: '',
        status: 'error',
        createdAt: now,
        updatedAt: now,
      }).run()

      const crashedRes = await post('/api/mattermost/actions', {
        context: { action: 'task_detail', task_id: 'task-agent-chain' },
      })
      const crashedData = await crashedRes.json() as { update?: { props?: { attachments?: Array<{ fields?: Array<{ title: string; value: string }>; actions?: Array<{ name: string }> }> } } }
      const card = crashedData.update?.props?.attachments?.[0]
      expect(card?.fields?.find(field => field.title === 'Agent')?.value).toBe('claude crashed')
      expect(card?.actions?.map(action => action.name)).toContain('🤖 Restart Agent')
    })

    test('view_diff exposes notification closure actions for review and PR workflow', async () => {
      const worktreePath = mkdtempSync(join(tmpdir(), 'fulcrum-mm-diff-'))
      execFileSync('git', ['init'], { cwd: worktreePath })
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: worktreePath })
      execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: worktreePath })
      writeFileSync(join(worktreePath, 'auth.ts'), 'export const auth = "old"\n')
      execFileSync('git', ['add', 'auth.ts'], { cwd: worktreePath })
      execFileSync('git', ['commit', '-m', 'initial'], { cwd: worktreePath })
      writeFileSync(join(worktreePath, 'auth.ts'), 'export const auth = "new"\nexport const token = "safe"\n')

      const now = new Date().toISOString()
      db.insert(tasks).values({
        id: 'task-diff-preview',
        title: 'Preview diff in Mattermost',
        status: 'IN_REVIEW',
        position: 1,
        priority: 'medium',
        worktreePath,
        agent: 'claude',
        createdAt: now,
        updatedAt: now,
      }).run()

      const { post } = createTestApp()
      const res = await post('/api/mattermost/actions', {
        context: { action: 'view_diff', task_id: 'task-diff-preview' },
      })
      const data = await res.json() as { update?: { props?: { attachments?: Array<{ text?: string; actions?: Array<{ name: string }> }> } } }
      const attachment = data.update?.props?.attachments?.[0]
      expect(attachment?.text).toContain('Diff —')
      expect(attachment?.text).toContain('auth.ts')
      expect(attachment?.text).toContain('+2 -1')
      const actionNames = attachment?.actions?.map(action => action.name)
      expect(actionNames).toContain('→ Review')
      expect(actionNames).toContain('Create PR')
      expect(actionNames).toContain('Merge')
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
