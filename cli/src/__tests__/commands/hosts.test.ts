import { describe, expect, test } from 'bun:test'
import { activeTasksForHost, buildCreateHostInput } from '../../commands/hosts'
import { CliError } from '../../utils/errors'
import type { Task } from '@shared/types'

function task(overrides: Partial<Task>): Task {
  return {
    id: overrides.id ?? 'task-1',
    title: overrides.title ?? 'Task',
    description: null,
    status: overrides.status ?? 'TO_DO',
    position: 0,
    repoPath: null,
    repoName: null,
    baseBranch: null,
    branch: null,
    prefix: null,
    worktreePath: null,
    viewState: null,
    prUrl: null,
    startupScript: null,
    agent: 'claude',
    aiMode: null,
    agentOptions: null,
    opencodeModel: null,
    type: null,
    derivedFromTaskId: null,
    pinned: false,
    projectId: null,
    repositoryId: null,
    tags: [],
    startedAt: null,
    dueDate: null,
    timeEstimate: null,
    priority: null,
    recurrenceRule: null,
    recurrenceEndDate: null,
    recurrenceSourceTaskId: null,
    notes: null,
    hostId: overrides.hostId ?? null,
    createdAt: '2026-05-03T00:00:00.000Z',
    updatedAt: '2026-05-03T00:00:00.000Z',
    ...overrides,
  }
}

describe('hosts command helpers', () => {
  test('buildCreateHostInput accepts flag mode with remote SSH port', async () => {
    const input = await buildCreateHostInput('dev', {
      hostname: 'dev.example.test',
      port: '2222',
      username: 'agent',
      'key-path': '~/.ssh/dev',
      directory: '/srv/fulcrum',
      'fulcrum-url': 'http://10.0.0.2:7777',
    })

    expect(input).toEqual({
      name: 'dev',
      hostname: 'dev.example.test',
      username: 'agent',
      port: 2222,
      authMethod: 'key',
      privateKeyPath: '~/.ssh/dev',
      password: undefined,
      defaultDirectory: '/srv/fulcrum',
      fulcrumUrl: 'http://10.0.0.2:7777',
    })
  })

  test('buildCreateHostInput requires missing flag-mode fields without prompting', async () => {
    await expect(buildCreateHostInput('dev', {
      hostname: 'dev.example.test',
    }, { interactive: false })).rejects.toMatchObject({ code: 'MISSING_USERNAME' } satisfies Partial<CliError>)
  })

  test('buildCreateHostInput validates remote SSH port range', async () => {
    await expect(buildCreateHostInput('dev', {
      hostname: 'dev.example.test',
      port: '70000',
      username: 'agent',
    })).rejects.toMatchObject({ code: 'INVALID_PORT' } satisfies Partial<CliError>)
  })

  test('activeTasksForHost only includes unfinished tasks attached to the host', () => {
    const tasks = [
      task({ id: 'todo', status: 'TO_DO', hostId: 'host-1' }),
      task({ id: 'progress', status: 'IN_PROGRESS', hostId: 'host-1' }),
      task({ id: 'review', status: 'IN_REVIEW', hostId: 'host-1' }),
      task({ id: 'done', status: 'DONE', hostId: 'host-1' }),
      task({ id: 'canceled', status: 'CANCELED', hostId: 'host-1' }),
      task({ id: 'other', status: 'IN_PROGRESS', hostId: 'host-2' }),
    ]

    expect(activeTasksForHost(tasks, 'host-1').map((t) => t.id)).toEqual(['todo', 'progress', 'review'])
  })
})
