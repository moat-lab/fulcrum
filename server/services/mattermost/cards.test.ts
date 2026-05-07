import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { setupTestEnv, type TestEnv } from '../../__tests__/utils/env'
import { clearFnoxCache, setFnoxValue } from '../../lib/settings/fnox'
import { apps, db, deployments, projects, tags, tasks, taskTags } from '../../db'
import {
  buildAppDetailCard,
  buildDashboardCard,
  buildProjectsCard,
  buildTaskDetailCard,
  buildTaskListCard,
} from './cards'

const now = '2026-05-04T12:00:00.000Z'

function insertTask(overrides: Partial<typeof tasks.$inferInsert> & { id: string; title: string }) {
  db.insert(tasks).values({
    status: 'TO_DO',
    position: 1,
    agent: 'claude',
    priority: 'medium',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }).run()
}

function insertApp(overrides: Partial<typeof apps.$inferInsert> & { id: string; name: string }) {
  db.insert(apps).values({
    repositoryId: 'repo-1',
    branch: 'main',
    composeFile: 'compose.yml',
    status: 'stopped',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }).run()
}

describe.serial('Mattermost cards', () => {
  let testEnv: TestEnv

  beforeEach(() => {
    testEnv = setupTestEnv()
    process.env.PORT = '9999'
  })

  afterEach(() => {
    testEnv.cleanup()
  })

  test('buildDashboardCard counts active tasks, apps, and due-today tasks', async () => {
    const today = new Date().toISOString().slice(0, 10)
    insertTask({ id: 'task-doing', title: 'Doing task', status: 'IN_PROGRESS', priority: 'high', dueDate: today })
    insertTask({ id: 'task-review', title: 'Review task', status: 'IN_REVIEW' })
    insertTask({ id: 'task-done', title: 'Done task', status: 'DONE', dueDate: today })
    insertApp({ id: 'app-running', name: 'Running app', status: 'running' })
    insertApp({ id: 'app-failed', name: 'Failed app', status: 'failed' })

    const card = await buildDashboardCard()

    expect(card.pretext).toBe('#### Fulcrum Dashboard')
    expect(card.fields?.find(field => field.title === 'Tasks')?.value).toContain('IN_PROGRESS: **1**')
    expect(card.fields?.find(field => field.title === 'Tasks')?.value).toContain('IN_REVIEW: **1**')
    expect(card.fields?.find(field => field.title === 'Apps')?.value).toContain('Running: **1**')
    expect(card.fields?.find(field => field.title?.startsWith('Due Today'))?.value).toContain('Doing task')
    expect(card.actions?.map(action => action.integration?.context.action)).toEqual([
      'list_tasks',
      'list_apps',
      'open_create_task_dialog',
      'monitor',
    ])
  })

  test('buildTaskListCard filters active tasks, applies priority sorting, and exposes task actions', async () => {
    insertTask({ id: 'medium-late', title: 'Medium late', priority: 'medium', dueDate: '2026-05-08' })
    insertTask({ id: 'high-later', title: 'High later', priority: 'high', dueDate: '2026-05-09' })
    insertTask({ id: 'done-hidden', title: 'Done hidden', status: 'DONE', priority: 'high' })

    const card = await buildTaskListCard()

    expect(card.pretext).toBe('#### Tasks — Active (2) · Page 1/1')
    expect(card.text?.indexOf('High later')).toBeLessThan(card.text?.indexOf('Medium late') ?? 0)
    expect(card.text).not.toContain('Done hidden')
    expect(card.actions?.[0].integration?.context).toEqual({ action: 'task_detail', task_id: 'high-later' })
    expect(card.actions?.at(-1)?.integration?.context).toEqual({ action: 'open_create_task_dialog' })
  })

  test('buildTaskListCard filters by status alias, project, and tag', async () => {
    db.insert(projects).values({ id: 'proj-1', name: 'Mattermost', status: 'active', createdAt: now, updatedAt: now }).run()
    db.insert(tags).values({ id: 'tag-1', name: 'urgent', createdAt: now }).run()
    insertTask({ id: 'matched-task', title: 'Matched', status: 'IN_PROGRESS', projectId: 'proj-1' })
    insertTask({ id: 'wrong-status', title: 'Wrong status', status: 'TO_DO', projectId: 'proj-1' })
    insertTask({ id: 'wrong-project', title: 'Wrong project', status: 'IN_PROGRESS', projectId: 'proj-2' })
    db.insert(taskTags).values({ id: 'task-tag-1', taskId: 'matched-task', tagId: 'tag-1', createdAt: now }).run()
    db.insert(taskTags).values({ id: 'task-tag-2', taskId: 'wrong-project', tagId: 'tag-1', createdAt: now }).run()

    const card = await buildTaskListCard({ status: 'doing', projectId: 'proj-1', tag: 'urgent' })

    expect(card.pretext).toBe('#### Tasks — DOING (1) · Page 1/1')
    expect(card.text).toContain('Matched')
    expect(card.text).not.toContain('Wrong status')
    expect(card.text).not.toContain('Wrong project')
  })

  test('buildTaskDetailCard includes status buttons, priority default option, tags, and open link', async () => {
    db.insert(tags).values({ id: 'tag-1', name: 'mattermost', createdAt: now }).run()
    insertTask({
      id: 'detail-task-123',
      title: 'Task detail',
      description: 'Detailed work',
      status: 'IN_PROGRESS',
      priority: 'high',
      repoName: 'fulcrum',
      branch: 'issue-68',
    })
    db.insert(taskTags).values({ id: 'task-tag-1', taskId: 'detail-task-123', tagId: 'tag-1', createdAt: now }).run()

    clearFnoxCache()
    setFnoxValue('server.port', 9999)
    setFnoxValue('editor.host', 'fulcrum-card.example.test')
    const card = await buildTaskDetailCard('detail')

    expect(card.pretext).toContain('Task #detail')
    expect(card.fields?.find(field => field.title === 'Status')?.value).toContain('IN_PROGRESS')
    expect(card.fields?.find(field => field.title === 'Tags')?.value).toContain('`mattermost`')
    expect(card.actions?.find(action => action.id === 'review')?.integration?.context).toEqual({
      action: 'status_change',
      task_id: 'detail-task-123',
      status: 'IN_REVIEW',
    })
    expect(card.actions?.find(action => action.id === 'change_priority')?.default_option).toEqual({ text: '🔴 High', value: 'high' })
    expect(card.text).toContain('/tasks/detail-task-123')
    expect(card.actions?.find(action => action.id === 'open')).toBeUndefined()
  })

  test('buildAppDetailCard exposes deployment actions and only running rollback options', async () => {
    insertApp({ id: 'app-1', name: 'Fulcrum App', status: 'running', lastDeployCommit: 'abcdef123456' })
    db.insert(deployments).values({
      id: 'deploy-running',
      appId: 'app-1',
      status: 'running',
      gitCommit: 'abcdef123456',
      deployedBy: 'manual',
      startedAt: now,
      createdAt: now,
    }).run()
    db.insert(deployments).values({
      id: 'deploy-failed',
      appId: 'app-1',
      status: 'failed',
      gitCommit: 'fffffff12345',
      deployedBy: 'manual',
      startedAt: now,
      createdAt: now,
    }).run()

    const card = await buildAppDetailCard('app-1')

    expect(card.pretext).toBe('#### 🚀 Fulcrum App')
    expect(card.actions?.map(action => action.integration?.context.action)).toContain('deploy_app')
    expect(card.actions?.map(action => action.integration?.context.action)).toContain('stop_app')
    expect(card.actions?.find(action => action.id === 'rollback')?.options?.[0]?.text).toContain('abcdef1')
    expect(card.actions?.find(action => action.id === 'rollback')?.options?.[0]?.value).toBe('deploy-running')
  })

  test('buildProjectsCard lists active projects with total and active task counts', async () => {
    db.insert(projects).values({ id: 'proj-1', name: 'Active Project', status: 'active', createdAt: now, updatedAt: now }).run()
    db.insert(projects).values({ id: 'proj-2', name: 'Archived Project', status: 'archived', createdAt: now, updatedAt: now }).run()
    insertTask({ id: 'project-active', title: 'Active task', projectId: 'proj-1', status: 'TO_DO' })
    insertTask({ id: 'project-done', title: 'Done task', projectId: 'proj-1', status: 'DONE' })

    const card = await buildProjectsCard()

    expect(card.pretext).toBe('#### Projects — Active (1)')
    expect(card.text).toContain('**Active Project** · 2 tasks (1 active)')
    expect(card.text).not.toContain('Archived Project')
    expect(card.actions?.[0].integration?.context).toEqual({ action: 'list_tasks', project_id: 'proj-1' })
  })
})
