import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import * as os from 'os'
import { setupTestEnv, type TestEnv } from '../__tests__/utils/env'
import { db, projects, projectRepositories, repositories, tasks } from '../db'
import { resolveWorkspaceForTaskId } from './herdr-workspace-mapper'

function ts(): string {
  return new Date().toISOString()
}

function insertProject(id: string, name: string): void {
  db.insert(projects)
    .values({ id, name, status: 'active', createdAt: ts(), updatedAt: ts() })
    .run()
}

function insertRepo(id: string, path: string, displayName: string): void {
  db.insert(repositories).values({ id, path, displayName, createdAt: ts(), updatedAt: ts() }).run()
}

function linkRepoToProject(projectId: string, repositoryId: string): void {
  db.insert(projectRepositories)
    .values({
      id: `pr-${repositoryId}`,
      projectId,
      repositoryId,
      isPrimary: true,
      createdAt: ts(),
    })
    .run()
}

function insertTask(opts: {
  id: string
  title: string
  projectId?: string | null
  repositoryId?: string | null
  agent?: string
}): void {
  db.insert(tasks)
    .values({
      id: opts.id,
      title: opts.title,
      status: 'TO_DO',
      position: 0,
      agent: opts.agent ?? 'claude',
      projectId: opts.projectId ?? null,
      repositoryId: opts.repositoryId ?? null,
      createdAt: ts(),
      updatedAt: ts(),
    })
    .run()
}

describe('resolveWorkspaceForTaskId', () => {
  let env: TestEnv

  beforeEach(() => {
    env = setupTestEnv()
  })

  afterEach(() => {
    env.cleanup()
  })

  test('returns null when task does not exist', () => {
    expect(resolveWorkspaceForTaskId('missing')).toBeNull()
  })

  test('git task with projectId: workspace = project name, cwd = repo path', () => {
    insertProject('p1', 'Fulcrum')
    insertRepo('r1', '/home/stephan/projects/fulcrum', 'fulcrum')
    insertTask({ id: 't1', title: 'fix bug', projectId: 'p1', repositoryId: 'r1' })

    const target = resolveWorkspaceForTaskId('t1')
    expect(target).toEqual({
      workspaceLabel: 'Fulcrum',
      workspaceCwd: '/home/stephan/projects/fulcrum',
      tabLabel: 'fix bug',
      agent: 'claude',
    })
  })

  test('returned target carries the task agent (opencode)', () => {
    insertTask({ id: 't1', title: 'opencode task', agent: 'opencode' })
    expect(resolveWorkspaceForTaskId('t1')?.agent).toBe('opencode')
  })

  test('git task with repositoryId only: resolves project via join table', () => {
    insertProject('p1', 'Fulcrum')
    insertRepo('r1', '/home/stephan/projects/fulcrum', 'fulcrum')
    linkRepoToProject('p1', 'r1')
    insertTask({ id: 't1', title: 'fix bug', projectId: null, repositoryId: 'r1' })

    const target = resolveWorkspaceForTaskId('t1')
    expect(target?.workspaceLabel).toBe('Fulcrum')
    expect(target?.workspaceCwd).toBe('/home/stephan/projects/fulcrum')
  })

  test('git task with unlinked repository falls back to repo displayName', () => {
    insertRepo('r1', '/srv/orphan', 'orphan-repo')
    insertTask({ id: 't1', title: 'orphan task', projectId: null, repositoryId: 'r1' })

    const target = resolveWorkspaceForTaskId('t1')
    expect(target?.workspaceLabel).toBe('orphan-repo')
    expect(target?.workspaceCwd).toBe('/srv/orphan')
  })

  test('scratch task with no project or repo falls back to scratch label and $HOME', () => {
    insertTask({ id: 't1', title: 'scratch idea' })

    const target = resolveWorkspaceForTaskId('t1')
    expect(target?.workspaceLabel).toBe('scratch') // default setting
    expect(target?.workspaceCwd).toBe(os.homedir())
    expect(target?.tabLabel).toBe('scratch idea')
  })

  test('task title longer than 32 chars is truncated with ellipsis', () => {
    const longTitle = 'this is a very long task title that exceeds the limit'
    insertTask({ id: 't1', title: longTitle })

    const target = resolveWorkspaceForTaskId('t1')
    expect(target?.tabLabel.length).toBe(32)
    expect(target?.tabLabel.endsWith('…')).toBe(true)
  })

  test('task with projectId but no repo: cwd = $HOME', () => {
    insertProject('p1', 'StandaloneProject')
    insertTask({ id: 't1', title: 'idea', projectId: 'p1' })

    const target = resolveWorkspaceForTaskId('t1')
    expect(target?.workspaceLabel).toBe('StandaloneProject')
    expect(target?.workspaceCwd).toBe(os.homedir())
  })
})
