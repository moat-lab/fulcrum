import { describe, test, expect } from 'bun:test'
import {
  parseTaskStatus,
  parseTaskPriority,
  toTaskSummary,
  toAppSummary,
  toJobSummary,
  toProjectSummary,
  taskActions,
  filterTasks,
  buildDashboardPayload,
  buildMonitorPayload,
  buildCreateTaskInput,
  summarizeDiff,
  CLI_JSON_SCHEMA_VERSION,
} from '../../commands/mattermost-verbs'
import { CliError } from '../../utils/errors'
import type { Task, App, ProjectWithDetails, SystemdTimer } from '@shared/types'

function fakeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: overrides.id ?? 'task-1',
    title: overrides.title ?? 'Test task',
    description: null,
    status: overrides.status ?? 'TO_DO',
    position: 0,
    repoPath: null,
    repoName: null,
    baseBranch: null,
    branch: null,
    prefix: null,
    worktreePath: overrides.worktreePath ?? null,
    viewState: null,
    prUrl: overrides.prUrl ?? null,
    startupScript: null,
    agent: overrides.agent ?? 'claude',
    aiMode: null,
    agentOptions: null,
    opencodeModel: null,
    type: overrides.type ?? null,
    derivedFromTaskId: null,
    pinned: false,
    projectId: overrides.projectId ?? null,
    repositoryId: null,
    tags: overrides.tags ?? [],
    startedAt: null,
    dueDate: overrides.dueDate ?? null,
    timeEstimate: null,
    priority: overrides.priority ?? null,
    recurrenceRule: null,
    recurrenceEndDate: null,
    recurrenceSourceTaskId: null,
    notes: null,
    hostId: null,
    createdAt: overrides.createdAt ?? '2026-05-14T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-05-14T00:00:00.000Z',
    ...overrides,
  }
}

function fakeApp(overrides: Partial<App> = {}): App {
  return {
    id: overrides.id ?? 'app-1',
    name: overrides.name ?? 'demo',
    repositoryId: 'repo-1',
    branch: 'main',
    composeFile: 'compose.yaml',
    status: overrides.status ?? 'running',
    autoDeployEnabled: true,
    lastDeployedAt: null,
    lastDeployCommit: null,
    createdAt: '2026-05-14T00:00:00.000Z',
    updatedAt: '2026-05-14T00:00:00.000Z',
    ...overrides,
  }
}

describe('mattermost-verbs schema contract', () => {
  test('schema version is exposed and stable at 1', () => {
    expect(CLI_JSON_SCHEMA_VERSION).toBe(1)
  })
})

describe('parseTaskStatus', () => {
  test.each([
    ['todo', 'TO_DO'],
    ['doing', 'IN_PROGRESS'],
    ['progress', 'IN_PROGRESS'],
    ['wip', 'IN_PROGRESS'],
    ['review', 'IN_REVIEW'],
    ['done', 'DONE'],
    ['canceled', 'CANCELED'],
    ['cancelled', 'CANCELED'],
    ['TO_DO', 'TO_DO'],
  ])('maps %s -> %s', (input, expected) => {
    expect(parseTaskStatus(input)).toBe(expected as never)
  })

  test('throws on invalid status', () => {
    expect(() => parseTaskStatus('garbage')).toThrow(CliError)
  })
})

describe('parseTaskPriority', () => {
  test('accepts high/medium/low (case-insensitive)', () => {
    expect(parseTaskPriority('High')).toBe('high')
    expect(parseTaskPriority('medium')).toBe('medium')
    expect(parseTaskPriority('LOW')).toBe('low')
  })

  test('throws on invalid priority', () => {
    expect(() => parseTaskPriority('urgent')).toThrow(CliError)
  })
})

describe('toTaskSummary', () => {
  test('reduces a Task to the contract fields', () => {
    const t = fakeTask({ priority: 'high', tags: ['urgent'], dueDate: '2026-05-14' })
    const s = toTaskSummary(t)
    expect(s).toEqual({
      id: 'task-1',
      title: 'Test task',
      status: 'TO_DO',
      priority: 'high',
      type: null,
      projectId: null,
      tags: ['urgent'],
      dueDate: '2026-05-14',
      agent: 'claude',
      worktreePath: null,
      prUrl: null,
      startedAt: null,
      createdAt: '2026-05-14T00:00:00.000Z',
      updatedAt: '2026-05-14T00:00:00.000Z',
    })
  })
})

describe('toAppSummary', () => {
  test('reduces an App to the contract fields', () => {
    const a = fakeApp({
      status: 'running',
      lastDeployCommit: 'abc123',
      repository: { id: 'r1', path: '/r', displayName: 'demo-repo' },
    })
    const s = toAppSummary(a)
    expect(s).toEqual({
      id: 'app-1',
      name: 'demo',
      status: 'running',
      branch: 'main',
      repository: 'demo-repo',
      lastDeployedAt: null,
      lastDeployCommit: 'abc123',
      autoDeployEnabled: true,
    })
  })
})

describe('toJobSummary', () => {
  test('strips runtime-only fields and keeps schedule info', () => {
    const j: SystemdTimer = {
      name: 'fulcrum-sweep.timer',
      scope: 'user',
      description: null,
      state: 'active',
      enabled: true,
      nextRun: '2026-05-14T12:00:00Z',
      lastRun: null,
      lastResult: 'success',
      schedule: 'hourly',
      serviceName: 'fulcrum-sweep.service',
      unitPath: '/etc/systemd/user/fulcrum-sweep.timer',
    }
    expect(toJobSummary(j)).toEqual({
      name: 'fulcrum-sweep.timer',
      scope: 'user',
      state: 'active',
      enabled: true,
      nextRun: '2026-05-14T12:00:00Z',
      lastRun: null,
      lastResult: 'success',
      schedule: 'hourly',
    })
  })
})

describe('toProjectSummary', () => {
  test('counts total/active tasks per project', () => {
    const p: ProjectWithDetails = {
      id: 'p1',
      name: 'demo',
      description: null,
      notes: null,
      repositoryId: null,
      appId: null,
      terminalTabId: null,
      status: 'active',
      defaultAgent: 'claude',
      claudeOptions: null,
      opencodeOptions: null,
      opencodeModel: null,
      startupScript: null,
      lastAccessedAt: null,
      createdAt: '2026-05-14T00:00:00.000Z',
      updatedAt: '2026-05-14T00:00:00.000Z',
    } as unknown as ProjectWithDetails
    const tasksForProject = [
      fakeTask({ id: 'a', status: 'IN_PROGRESS' }),
      fakeTask({ id: 'b', status: 'DONE' }),
      fakeTask({ id: 'c', status: 'TO_DO' }),
    ]
    expect(toProjectSummary(p, tasksForProject).taskCounts).toEqual({ total: 3, active: 2 })
  })
})

describe('taskActions', () => {
  test('TO_DO task offers Start and Cancel', () => {
    const a = taskActions(fakeTask({ status: 'TO_DO' }))
    expect(a.find((x) => x.id === 'set_status_in_progress')).toBeTruthy()
    expect(a.find((x) => x.id === 'set_status_canceled')?.destructive).toBe(true)
    expect(a.find((x) => x.id === 'start_agent')).toBeFalsy()
  })

  test('IN_PROGRESS task with worktree offers agent control', () => {
    const a = taskActions(fakeTask({ status: 'IN_PROGRESS', worktreePath: '/tmp/wt' }))
    expect(a.find((x) => x.id === 'start_agent')).toBeTruthy()
    expect(a.find((x) => x.id === 'kill_agent')?.destructive).toBe(true)
    expect(a.find((x) => x.id === 'view_diff')).toBeTruthy()
  })

  test('DONE task offers no destructive actions', () => {
    const a = taskActions(fakeTask({ status: 'DONE' }))
    expect(a.find((x) => x.id === 'set_status_canceled')).toBeFalsy()
  })
})

describe('filterTasks', () => {
  const tasks = [
    fakeTask({ id: 't1', status: 'TO_DO', priority: 'high', tags: ['urgent'], projectId: 'p1' }),
    fakeTask({ id: 't2', status: 'IN_PROGRESS', priority: 'medium', tags: ['urgent'], projectId: 'p1' }),
    fakeTask({ id: 't3', status: 'DONE', priority: 'low', tags: [], projectId: 'p2' }),
    fakeTask({ id: 't4', status: 'CANCELED', priority: null, tags: [], projectId: null }),
    fakeTask({ id: 't5', status: 'IN_REVIEW', priority: 'high', tags: ['regression'], projectId: 'p2' }),
  ]

  test('default active filter excludes DONE and CANCELED', () => {
    const r = filterTasks(tasks, {})
    expect(r.total).toBe(3)
    expect(r.tasks.map((t) => t.id).sort()).toEqual(['t1', 't2', 't5'])
  })

  test('explicit status filter selects exact', () => {
    const r = filterTasks(tasks, { status: 'IN_PROGRESS' })
    expect(r.tasks.map((t) => t.id)).toEqual(['t2'])
  })

  test('priority filter narrows further', () => {
    const r = filterTasks(tasks, { status: 'active', priority: 'high' })
    expect(r.tasks.map((t) => t.id).sort()).toEqual(['t1', 't5'])
  })

  test('tag filter strips # and matches array membership', () => {
    const r = filterTasks(tasks, { status: 'active', tag: 'urgent' })
    expect(r.tasks.map((t) => t.id).sort()).toEqual(['t1', 't2'])
  })

  test('projectId filter scopes to one project', () => {
    const r = filterTasks(tasks, { status: 'active', projectId: 'p1' })
    expect(r.tasks.map((t) => t.id).sort()).toEqual(['t1', 't2'])
  })

  test('pagination produces stable page slice', () => {
    const r = filterTasks(tasks, { status: 'active', pageSize: 2, page: 2 })
    expect(r.page).toBe(2)
    expect(r.pageSize).toBe(2)
    expect(r.total).toBe(3)
    expect(r.totalPages).toBe(2)
    expect(r.tasks.length).toBe(1)
  })
})

describe('buildDashboardPayload', () => {
  test('counts by status and surfaces due-today active tasks', () => {
    const today = '2026-05-14'
    const tasks = [
      fakeTask({ id: 't1', status: 'TO_DO', dueDate: today }),
      fakeTask({ id: 't2', status: 'IN_PROGRESS', dueDate: today }),
      fakeTask({ id: 't3', status: 'DONE', dueDate: today }),
      fakeTask({ id: 't4', status: 'CANCELED' }),
    ]
    const apps = [
      fakeApp({ id: 'a1', status: 'running' }),
      fakeApp({ id: 'a2', status: 'failed' }),
      fakeApp({ id: 'a3', status: 'running' }),
    ]
    const p = buildDashboardPayload(tasks, apps, today)
    expect(p.tasks_by_status).toEqual({
      TO_DO: 1,
      IN_PROGRESS: 1,
      IN_REVIEW: 0,
      DONE: 1,
      CANCELED: 1,
    })
    expect(p.active_tasks).toBe(2)
    expect(p.apps_by_status).toEqual({ running: 2, failed: 1 })
    expect(p.total_apps).toBe(3)
    // DONE on today is excluded from due_today
    expect(p.due_today.map((t) => t.id).sort()).toEqual(['t1', 't2'])
  })
})

describe('buildMonitorPayload', () => {
  const FIXED_NOW = new Date('2026-05-16T08:14:22.000Z')

  test('reporting: emits in-window sample values and full envelope', () => {
    const payload = buildMonitorPayload(
      {
        window: '1h',
        hostId: 'vctcn-app1',
        monitorStatus: 'reporting',
        lastSampleAt: '2026-05-16T08:14:22.000Z',
        since: '2026-05-16T07:14:22.000Z',
        current: {
          cpu: 12.5,
          memory: { usedPercent: 40.2 },
          disk: { usedPercent: 55.0 },
        },
      },
      FIXED_NOW
    )
    expect(payload).toEqual({
      host_id: 'vctcn-app1',
      window: '1h',
      monitor_status: 'reporting',
      last_sample_at: '2026-05-16T08:14:22.000Z',
      since: '2026-05-16T07:14:22.000Z',
      cpu_percent: 12.5,
      memory_percent: 40.2,
      disk_percent: 55.0,
    })
  })

  test('no_data_in_window: keeps last_sample_at, nulls metric fields', () => {
    const payload = buildMonitorPayload(
      {
        window: '1h',
        hostId: 'vctcn-app2',
        monitorStatus: 'no_data_in_window',
        lastSampleAt: '2026-05-16T03:00:00.000Z',
        since: '2026-05-16T07:14:22.000Z',
        current: {
          cpu: 0,
          memory: { usedPercent: 0 },
          disk: { usedPercent: 0 },
        },
      },
      FIXED_NOW
    )
    expect(payload).toEqual({
      host_id: 'vctcn-app2',
      window: '1h',
      monitor_status: 'no_data_in_window',
      last_sample_at: '2026-05-16T03:00:00.000Z',
      since: '2026-05-16T07:14:22.000Z',
      cpu_percent: null,
      memory_percent: null,
      disk_percent: null,
    })
  })

  test('unconfigured: last_sample_at null, metric fields null', () => {
    const payload = buildMonitorPayload(
      {
        window: '1h',
        hostId: 'never-registered',
        monitorStatus: 'unconfigured',
        lastSampleAt: null,
        since: '2026-05-16T07:14:22.000Z',
        current: null,
      },
      FIXED_NOW
    )
    expect(payload).toEqual({
      host_id: 'never-registered',
      window: '1h',
      monitor_status: 'unconfigured',
      last_sample_at: null,
      since: '2026-05-16T07:14:22.000Z',
      cpu_percent: null,
      memory_percent: null,
      disk_percent: null,
    })
  })

  test('back-compat: older server response (no status fields) coerces to unconfigured + null metrics, derives since from window', () => {
    const payload = buildMonitorPayload(
      {
        window: '1h',
        hostId: 'legacy-host',
        current: {
          cpu: 33.3,
          memory: { usedPercent: 50.0 },
          disk: { usedPercent: 60.0 },
        },
      },
      FIXED_NOW
    )
    // Legacy fields still present so old plugin keys (host_id, window, cpu/memory/disk_percent)
    // resolve without runtime errors; non-reporting status nulls the metric values to keep
    // the em-dash fallback intact downstream.
    expect(payload.host_id).toBe('legacy-host')
    expect(payload.window).toBe('1h')
    expect(payload.monitor_status).toBe('unconfigured')
    expect(payload.last_sample_at).toBeNull()
    expect(payload.since).toBe('2026-05-16T07:14:22.000Z')
    expect(payload.cpu_percent).toBeNull()
    expect(payload.memory_percent).toBeNull()
    expect(payload.disk_percent).toBeNull()
  })
})

describe('buildCreateTaskInput', () => {
  test('forwards --host as hostId so remote-only deployments accept the POST', () => {
    const input = buildCreateTaskInput({ title: 'smoke', host: 'vctcn-app1' })
    expect(input.hostId).toBe('vctcn-app1')
    expect(input.title).toBe('smoke')
  })

  test('omits hostId when --host is absent (back-compat with local-only deployments)', () => {
    const input = buildCreateTaskInput({ title: 'smoke' })
    expect(input.hostId).toBeUndefined()
  })

  test('keeps the existing argv → POST body mapping for description/priority/type/project/repo/due/tags alongside hostId', () => {
    const input = buildCreateTaskInput({
      title: 'demo',
      description: 'hi',
      priority: 'High',
      type: 'worktree',
      project: 'p1',
      repo: 'r1',
      host: 'vctcn-app1',
      due: '2026-05-20',
      tags: 'a, b ,c',
    })
    expect(input).toEqual({
      title: 'demo',
      description: 'hi',
      priority: 'high',
      type: 'worktree',
      projectId: 'p1',
      repositoryId: 'r1',
      hostId: 'vctcn-app1',
      dueDate: '2026-05-20',
      tags: ['a', 'b', 'c'],
    })
  })
})

describe('summarizeDiff', () => {
  test('counts insertions and deletions per file from unified diff', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      'index 1..2 100644',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,2 +1,3 @@',
      ' unchanged',
      '+added one',
      '+added two',
      '-removed one',
      'diff --git a/b.ts b/b.ts',
      'index 3..4 100644',
      '--- a/b.ts',
      '+++ b/b.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n')
    const s = summarizeDiff(diff)
    expect(s.fileCount).toBe(2)
    expect(s.insertions).toBe(3)
    expect(s.deletions).toBe(2)
    expect(s.files).toEqual([
      { path: 'a.ts', insertions: 2, deletions: 1 },
      { path: 'b.ts', insertions: 1, deletions: 1 },
    ])
  })

  test('empty diff -> zero counts', () => {
    expect(summarizeDiff('')).toEqual({ fileCount: 0, insertions: 0, deletions: 0, files: [] })
  })
})
