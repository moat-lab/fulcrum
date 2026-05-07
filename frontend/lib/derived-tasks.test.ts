import { describe, expect, test } from 'bun:test'
import { selectDerivedTasks } from './derived-tasks'
import type { Task } from '../../shared/types'

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Test task',
    description: null,
    status: 'TO_DO',
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
    hostId: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

describe('selectDerivedTasks', () => {
  test('returns an empty list when the parent has no derived tasks', () => {
    const result = selectDerivedTasks([
      makeTask({ id: 'other-child', derivedFromTaskId: 'other-parent' }),
      makeTask({ id: 'standalone', derivedFromTaskId: null }),
    ], 'parent')

    expect(result).toEqual([])
  })

  test('filters derived children and orders active work before completed work', () => {
    const done = makeTask({
      id: 'done-child',
      title: 'Done child',
      status: 'DONE',
      derivedFromTaskId: 'parent',
      createdAt: '2026-01-04T00:00:00Z',
    })
    const olderTodo = makeTask({
      id: 'older-todo-child',
      title: 'Older todo child',
      status: 'TO_DO',
      derivedFromTaskId: 'parent',
      createdAt: '2026-01-02T00:00:00Z',
    })
    const active = makeTask({
      id: 'active-child',
      title: 'Active child',
      status: 'IN_PROGRESS',
      derivedFromTaskId: 'parent',
      createdAt: '2026-01-01T00:00:00Z',
    })
    const newerTodo = makeTask({
      id: 'newer-todo-child',
      title: 'Newer todo child',
      status: 'TO_DO',
      derivedFromTaskId: 'parent',
      createdAt: '2026-01-03T00:00:00Z',
    })

    const result = selectDerivedTasks([
      done,
      olderTodo,
      makeTask({ id: 'unrelated', status: 'IN_PROGRESS', derivedFromTaskId: 'other-parent' }),
      active,
      newerTodo,
    ], 'parent')

    expect(result.map((task) => task.id)).toEqual([
      'active-child',
      'newer-todo-child',
      'older-todo-child',
      'done-child',
    ])
  })
})
