/**
 * Mattermost-plugin verb surface.
 *
 * These verbs expose the data the `mattermost-plugin-fulcrum` Go plugin needs
 * to render slash-command responses, dashboards, and action callbacks. They
 * are the **stable contract** between fulcrum and the plugin — see
 * `cli/JSON_SCHEMA.md` for the per-verb output shape and `schema_version`
 * bump policy. Plugin parses `--json` stdout only; the human-rendered text
 * form is for operator debugging.
 */

import { defineCommand } from 'citty'
import type { Task, TaskStatus, TaskPriority, App, Project, ProjectWithDetails, SystemdTimer } from '@shared/types'
import { FulcrumClient, type CreateTaskInput } from '../client'
import { outputVerbPayload, CLI_JSON_SCHEMA_VERSION } from '../utils/output'
import { CliError, ExitCodes } from '../utils/errors'
import { globalArgs, toFlags, setupJsonOutput } from './shared'

// ============================================================================
// Filter / parse helpers (pure)
// ============================================================================

const TASK_STATUS_ALIASES: Record<string, TaskStatus> = {
  todo: 'TO_DO',
  to_do: 'TO_DO',
  doing: 'IN_PROGRESS',
  in_progress: 'IN_PROGRESS',
  progress: 'IN_PROGRESS',
  wip: 'IN_PROGRESS',
  review: 'IN_REVIEW',
  in_review: 'IN_REVIEW',
  done: 'DONE',
  canceled: 'CANCELED',
  cancelled: 'CANCELED',
}

const VALID_PRIORITIES: ReadonlySet<TaskPriority> = new Set<TaskPriority>(['high', 'medium', 'low'])

export function parseTaskStatus(value: string): TaskStatus {
  const normalized = value.toLowerCase().trim()
  const mapped = TASK_STATUS_ALIASES[normalized]
  if (mapped) return mapped
  const upper = value.toUpperCase()
  if (upper === 'TO_DO' || upper === 'IN_PROGRESS' || upper === 'IN_REVIEW' || upper === 'DONE' || upper === 'CANCELED') {
    return upper as TaskStatus
  }
  throw new CliError(
    'INVALID_STATUS',
    `Invalid status: ${value}. Valid: todo, doing, review, done, canceled.`,
    ExitCodes.INVALID_ARGS
  )
}

export function parseTaskPriority(value: string): TaskPriority {
  const v = value.toLowerCase().trim() as TaskPriority
  if (!VALID_PRIORITIES.has(v)) {
    throw new CliError(
      'INVALID_PRIORITY',
      `Invalid priority: ${value}. Valid: high, medium, low.`,
      ExitCodes.INVALID_ARGS
    )
  }
  return v
}

// ============================================================================
// Payload builders (pure — unit-tested in mattermost-verbs.test.ts)
// ============================================================================

export interface TaskSummary {
  id: string
  title: string
  status: TaskStatus
  priority: TaskPriority | null
  type: Task['type']
  projectId: string | null
  tags: string[]
  dueDate: string | null
  agent: Task['agent']
  worktreePath: string | null
  prUrl: string | null
  startedAt: string | null
  createdAt: string
  updatedAt: string
}

export function toTaskSummary(t: Task): TaskSummary {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    type: t.type,
    projectId: t.projectId,
    tags: t.tags,
    dueDate: t.dueDate,
    agent: t.agent,
    worktreePath: t.worktreePath,
    prUrl: t.prUrl,
    startedAt: t.startedAt,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  }
}

export interface TasksFilter {
  status?: TaskStatus | 'active'
  priority?: TaskPriority
  projectId?: string
  tag?: string
  page?: number
  pageSize?: number
}

const DEFAULT_PAGE_SIZE = 20

export function filterTasks(all: Task[], filter: TasksFilter): {
  tasks: Task[]
  total: number
  page: number
  pageSize: number
  totalPages: number
} {
  let filtered = all
  if (filter.status === 'active' || !filter.status) {
    filtered = filtered.filter((t) => t.status !== 'DONE' && t.status !== 'CANCELED')
  } else {
    filtered = filtered.filter((t) => t.status === filter.status)
  }
  if (filter.priority) {
    filtered = filtered.filter((t) => t.priority === filter.priority)
  }
  if (filter.projectId) {
    filtered = filtered.filter((t) => t.projectId === filter.projectId)
  }
  if (filter.tag) {
    filtered = filtered.filter((t) => t.tags.includes(filter.tag!))
  }
  const pageSize = filter.pageSize ?? DEFAULT_PAGE_SIZE
  const page = Math.max(1, filter.page ?? 1)
  const total = filtered.length
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const start = (page - 1) * pageSize
  return {
    tasks: filtered.slice(start, start + pageSize),
    total,
    page,
    pageSize,
    totalPages,
  }
}

export interface TaskAction {
  id: string
  label: string
  destructive?: boolean
}

export function taskActions(task: Task): TaskAction[] {
  const actions: TaskAction[] = []
  if (task.status === 'TO_DO') {
    actions.push({ id: 'set_status_in_progress', label: 'Start' })
  } else if (task.status === 'IN_PROGRESS') {
    actions.push({ id: 'set_status_in_review', label: 'Review' })
    actions.push({ id: 'set_status_done', label: 'Done' })
  } else if (task.status === 'IN_REVIEW') {
    actions.push({ id: 'set_status_done', label: 'Done' })
  }
  if (task.status !== 'DONE' && task.status !== 'CANCELED') {
    actions.push({ id: 'set_status_canceled', label: 'Cancel', destructive: true })
  }
  if (task.worktreePath) {
    actions.push({ id: 'start_agent', label: 'Start Agent' })
    actions.push({ id: 'kill_agent', label: 'Kill Agent', destructive: true })
    actions.push({ id: 'view_diff', label: 'View Diff' })
  }
  return actions
}

export interface DashboardPayload {
  tasks_by_status: Record<TaskStatus, number>
  active_tasks: number
  apps_by_status: Record<string, number>
  total_apps: number
  due_today: TaskSummary[]
}

export function buildDashboardPayload(
  allTasks: Task[],
  allApps: App[],
  today: string
): DashboardPayload {
  const tasksByStatus: Record<TaskStatus, number> = {
    TO_DO: 0,
    IN_PROGRESS: 0,
    IN_REVIEW: 0,
    DONE: 0,
    CANCELED: 0,
  }
  const dueToday: TaskSummary[] = []
  let activeTasks = 0
  for (const t of allTasks) {
    tasksByStatus[t.status] = (tasksByStatus[t.status] || 0) + 1
    if (t.status !== 'DONE' && t.status !== 'CANCELED') {
      activeTasks += 1
      if (t.dueDate === today) dueToday.push(toTaskSummary(t))
    }
  }
  const appsByStatus: Record<string, number> = {}
  for (const a of allApps) {
    appsByStatus[a.status] = (appsByStatus[a.status] || 0) + 1
  }
  return {
    tasks_by_status: tasksByStatus,
    active_tasks: activeTasks,
    apps_by_status: appsByStatus,
    total_apps: allApps.length,
    due_today: dueToday,
  }
}

export interface AppSummary {
  id: string
  name: string
  status: App['status']
  branch: string
  repository: string | null
  lastDeployedAt: string | null
  lastDeployCommit: string | null
  autoDeployEnabled: boolean
}

export function toAppSummary(a: App): AppSummary {
  return {
    id: a.id,
    name: a.name,
    status: a.status,
    branch: a.branch,
    repository: a.repository?.displayName ?? null,
    lastDeployedAt: a.lastDeployedAt,
    lastDeployCommit: a.lastDeployCommit,
    autoDeployEnabled: a.autoDeployEnabled,
  }
}

export interface ProjectSummary {
  id: string
  name: string
  description: string | null
  status: Project['status']
  defaultAgent: Project['defaultAgent']
  taskCounts: { total: number; active: number }
}

export function toProjectSummary(p: ProjectWithDetails, tasksForProject: Task[]): ProjectSummary {
  let total = 0
  let active = 0
  for (const t of tasksForProject) {
    total += 1
    if (t.status !== 'DONE' && t.status !== 'CANCELED') active += 1
  }
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    status: p.status,
    defaultAgent: p.defaultAgent,
    taskCounts: { total, active },
  }
}

export interface JobSummary {
  name: string
  scope: SystemdTimer['scope']
  state: SystemdTimer['state']
  enabled: boolean
  nextRun: string | null
  lastRun: string | null
  lastResult: SystemdTimer['lastResult']
  schedule: string | null
}

export function toJobSummary(j: SystemdTimer): JobSummary {
  return {
    name: j.name,
    scope: j.scope,
    state: j.state,
    enabled: j.enabled,
    nextRun: j.nextRun,
    lastRun: j.lastRun,
    lastResult: j.lastResult,
    schedule: j.schedule,
  }
}

// ============================================================================
// citty argument shared shapes
// ============================================================================

const verbArgs = {
  ...globalArgs,
  json: { type: 'boolean' as const, description: 'Emit JSON envelope (default and only output mode for plugin contract)', default: true },
}

function client(args: Record<string, unknown>): FulcrumClient {
  const flags = toFlags(args)
  return new FulcrumClient(flags.url, flags.port)
}

function emit<T extends Record<string, unknown>>(verb: string, payload: T) {
  // Always force JSON for plugin contract — verb surface has no pretty mode.
  setupJsonOutput({ json: true })
  outputVerbPayload(verb, payload)
}

function emitError(verb: string, code: string, message: string, exitCode: number = ExitCodes.RUNTIME_ERROR): never {
  setupJsonOutput({ json: true })
  outputVerbPayload(verb, { error: { code, message } })
  process.exit(exitCode)
}

// ============================================================================
// dashboard
// ============================================================================

export const dashboardCommand = defineCommand({
  meta: { name: 'dashboard', description: 'Fulcrum dashboard summary (Mattermost plugin contract)' },
  args: verbArgs,
  async run({ args }) {
    const c = client(args)
    try {
      const [tasksList, appsList] = await Promise.all([c.listTasks(), c.listApps()])
      const today = new Date().toISOString().slice(0, 10)
      emit('dashboard', buildDashboardPayload(tasksList, appsList, today))
    } catch (err) {
      emitError('dashboard', 'FETCH_FAILED', err instanceof Error ? err.message : String(err))
    }
  },
})

// ============================================================================
// tasks
// ============================================================================

const tasksListCommand = defineCommand({
  meta: { name: 'list', description: 'List tasks with optional filters' },
  args: {
    ...verbArgs,
    status: { type: 'string' as const, description: 'todo|doing|review|done|canceled|active (default: active)' },
    priority: { type: 'string' as const, description: 'high|medium|low' },
    project: { type: 'string' as const, description: 'Project ID' },
    tag: { type: 'string' as const, description: 'Tag name' },
    page: { type: 'string' as const, description: 'Page number (1-based)' },
  },
  async run({ args }) {
    const c = client(args)
    const filter: TasksFilter = {}
    if (args.status) {
      const s = String(args.status).toLowerCase()
      filter.status = s === 'active' ? 'active' : parseTaskStatus(s)
    } else {
      filter.status = 'active'
    }
    if (args.priority) filter.priority = parseTaskPriority(String(args.priority))
    if (args.project) filter.projectId = String(args.project)
    if (args.tag) filter.tag = String(args.tag).replace(/^#/, '')
    if (args.page) filter.page = Number(args.page) || 1
    try {
      const all = await c.listTasks()
      const result = filterTasks(all, filter)
      emit('tasks.list', {
        filter: {
          status: filter.status ?? null,
          priority: filter.priority ?? null,
          project_id: filter.projectId ?? null,
          tag: filter.tag ?? null,
          page: result.page,
          page_size: result.pageSize,
          total_pages: result.totalPages,
        },
        total: result.total,
        tasks: result.tasks.map(toTaskSummary),
      })
    } catch (err) {
      emitError('tasks.list', 'FETCH_FAILED', err instanceof Error ? err.message : String(err))
    }
  },
})

const tasksGetCommand = defineCommand({
  meta: { name: 'get', description: 'Get a single task by ID' },
  args: {
    ...verbArgs,
    id: { type: 'positional' as const, description: 'Task ID', required: true },
  },
  async run({ args }) {
    const c = client(args)
    try {
      const t = await c.getTask(String(args.id))
      emit('tasks.get', { task: toTaskSummary(t), actions: taskActions(t) })
    } catch (err) {
      emitError('tasks.get', 'FETCH_FAILED', err instanceof Error ? err.message : String(err))
    }
  },
})

/**
 * Map citty args from `fulcrum tasks create` into a `CreateTaskInput`.
 *
 * Extracted as a pure helper so unit tests can assert the argv → POST-body
 * shape without spinning up the FulcrumClient. The `host` flag is the seam
 * the Mattermost plugin (`/f tasks create --host <id>`) needs in remote-only
 * deployments — server rejects with `remote-only mode requires hostId` if
 * `hostId` is missing from the body.
 */
export function buildCreateTaskInput(args: Record<string, unknown>): CreateTaskInput {
  const tags = args.tags
    ? String(args.tags).split(',').map((t) => t.trim()).filter(Boolean)
    : undefined
  const type = args.type ? String(args.type) : undefined
  return {
    title: String(args.title),
    description: args.description ? String(args.description) : undefined,
    priority: args.priority ? parseTaskPriority(String(args.priority)) : undefined,
    type: type ?? null,
    projectId: args.project ? String(args.project) : null,
    repositoryId: args.repo ? String(args.repo) : null,
    hostId: args.host ? String(args.host) : undefined,
    dueDate: args.due ? String(args.due) : null,
    tags,
  }
}

const tasksCreateCommand = defineCommand({
  meta: { name: 'create', description: 'Create a new task' },
  args: {
    ...verbArgs,
    title: { type: 'string' as const, description: 'Task title', required: true },
    description: { type: 'string' as const, description: 'Task description' },
    priority: { type: 'string' as const, description: 'high|medium|low' },
    type: { type: 'string' as const, description: 'worktree|scratch|manual' },
    project: { type: 'string' as const, description: 'Project ID' },
    repo: { type: 'string' as const, description: 'Repository ID' },
    host: { type: 'string' as const, description: 'Host ID (required in remote-only deployments)' },
    due: { type: 'string' as const, description: 'Due date YYYY-MM-DD' },
    tags: { type: 'string' as const, description: 'Comma-separated tags' },
  },
  async run({ args }) {
    if (!args.title) emitError('tasks.create', 'MISSING_TITLE', 'title is required', ExitCodes.INVALID_ARGS)
    const c = client(args)
    try {
      const t = await c.createTask(buildCreateTaskInput(args))
      emit('tasks.create', { task: toTaskSummary(t) })
    } catch (err) {
      emitError('tasks.create', 'CREATE_FAILED', err instanceof Error ? err.message : String(err))
    }
  },
})

const tasksSetStatusCommand = defineCommand({
  meta: { name: 'set-status', description: 'Change task status' },
  args: {
    ...verbArgs,
    id: { type: 'positional' as const, description: 'Task ID', required: true },
    status: { type: 'positional' as const, description: 'New status', required: true },
  },
  async run({ args }) {
    const c = client(args)
    const status = parseTaskStatus(String(args.status))
    try {
      const t = await c.moveTask(String(args.id), status)
      emit('tasks.set-status', { task: toTaskSummary(t) })
    } catch (err) {
      emitError('tasks.set-status', 'UPDATE_FAILED', err instanceof Error ? err.message : String(err))
    }
  },
})

const tasksSetPriorityCommand = defineCommand({
  meta: { name: 'set-priority', description: 'Change task priority' },
  args: {
    ...verbArgs,
    id: { type: 'positional' as const, description: 'Task ID', required: true },
    priority: { type: 'positional' as const, description: 'high|medium|low', required: true },
  },
  async run({ args }) {
    const c = client(args)
    const priority = parseTaskPriority(String(args.priority))
    try {
      const t = await c.updateTask(String(args.id), { priority })
      emit('tasks.set-priority', { task: toTaskSummary(t) })
    } catch (err) {
      emitError('tasks.set-priority', 'UPDATE_FAILED', err instanceof Error ? err.message : String(err))
    }
  },
})

export interface DiffSummary {
  branch: string | null
  baseBranch: string | null
  fileCount: number
  insertions: number
  deletions: number
  files: Array<{ path: string; insertions: number; deletions: number }>
}

export function summarizeDiff(diffText: string): Pick<DiffSummary, 'fileCount' | 'insertions' | 'deletions' | 'files'> {
  const files: DiffSummary['files'] = []
  let currentFile: string | null = null
  let totalIns = 0
  let totalDel = 0
  for (const line of diffText.split('\n')) {
    const headerMatch = line.match(/^diff --git a\/(.+?) b\//)
    if (headerMatch) {
      currentFile = headerMatch[1]
      files.push({ path: currentFile, insertions: 0, deletions: 0 })
      continue
    }
    if (!currentFile) continue
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) continue
    const entry = files[files.length - 1]
    if (line.startsWith('+')) {
      entry.insertions += 1
      totalIns += 1
    } else if (line.startsWith('-')) {
      entry.deletions += 1
      totalDel += 1
    }
  }
  return { fileCount: files.length, insertions: totalIns, deletions: totalDel, files }
}

const tasksDiffCommand = defineCommand({
  meta: { name: 'diff', description: 'Get worktree diff for a task' },
  args: {
    ...verbArgs,
    id: { type: 'positional' as const, description: 'Task ID', required: true },
  },
  async run({ args }) {
    const c = client(args)
    try {
      const task = await c.getTask(String(args.id))
      if (!task.worktreePath) {
        emit('tasks.diff', {
          task_id: task.id,
          branch: task.branch,
          base_branch: task.baseBranch,
          diff: null,
          summary: { fileCount: 0, insertions: 0, deletions: 0, files: [] },
        })
        return
      }
      const diff = await c.getDiff(task.worktreePath, { ignoreWhitespace: false, includeUntracked: true })
      const summary = summarizeDiff(diff.diff || '')
      emit('tasks.diff', {
        task_id: task.id,
        branch: task.branch,
        base_branch: task.baseBranch,
        diff: diff.diff || null,
        summary,
      })
    } catch (err) {
      emitError('tasks.diff', 'FETCH_FAILED', err instanceof Error ? err.message : String(err))
    }
  },
})

const tasksStartAgentCommand = defineCommand({
  meta: { name: 'start-agent', description: 'Start the configured agent for a task' },
  args: {
    ...verbArgs,
    id: { type: 'positional' as const, description: 'Task ID', required: true },
  },
  async run({ args }) {
    const c = client(args)
    try {
      const result = await c.startTaskAgent(String(args.id))
      emit('tasks.start-agent', {
        task_id: String(args.id),
        terminal_id: result.terminalId,
        agent: result.agent,
      })
    } catch (err) {
      emitError('tasks.start-agent', 'START_FAILED', err instanceof Error ? err.message : String(err))
    }
  },
})

const tasksKillAgentCommand = defineCommand({
  meta: { name: 'kill-agent', description: 'Kill running agent processes for a task' },
  args: {
    ...verbArgs,
    id: { type: 'positional' as const, description: 'Task ID', required: true },
  },
  async run({ args }) {
    const c = client(args)
    try {
      const result = await c.killTaskAgent(String(args.id))
      emit('tasks.kill-agent', {
        task_id: String(args.id),
        terminals_affected: result.terminalsAffected,
      })
    } catch (err) {
      emitError('tasks.kill-agent', 'KILL_FAILED', err instanceof Error ? err.message : String(err))
    }
  },
})

export const tasksCommand = defineCommand({
  meta: { name: 'tasks', description: 'Task verbs for Mattermost plugin contract' },
  args: verbArgs,
  subCommands: {
    list: tasksListCommand,
    get: tasksGetCommand,
    create: tasksCreateCommand,
    'set-status': tasksSetStatusCommand,
    'set-priority': tasksSetPriorityCommand,
    diff: tasksDiffCommand,
    'start-agent': tasksStartAgentCommand,
    'kill-agent': tasksKillAgentCommand,
  },
  async run({ args }) {
    // No-arg form is equivalent to `tasks list` with default filters.
    const positionals = (args._ as string[] | undefined) ?? []
    if (positionals.length > 0) return
    const c = client(args)
    try {
      const all = await c.listTasks()
      const result = filterTasks(all, { status: 'active' })
      emit('tasks.list', {
        filter: { status: 'active', priority: null, project_id: null, tag: null, page: 1, page_size: result.pageSize, total_pages: result.totalPages },
        total: result.total,
        tasks: result.tasks.map(toTaskSummary),
      })
    } catch (err) {
      emitError('tasks.list', 'FETCH_FAILED', err instanceof Error ? err.message : String(err))
    }
  },
})

// ============================================================================
// apps
// ============================================================================

const appsListCommand = defineCommand({
  meta: { name: 'list', description: 'List apps' },
  args: verbArgs,
  async run({ args }) {
    const c = client(args)
    try {
      const apps = await c.listApps()
      emit('apps.list', { apps: apps.map(toAppSummary), total: apps.length })
    } catch (err) {
      emitError('apps.list', 'FETCH_FAILED', err instanceof Error ? err.message : String(err))
    }
  },
})

const appsGetCommand = defineCommand({
  meta: { name: 'get', description: 'Get a single app' },
  args: { ...verbArgs, id: { type: 'positional' as const, description: 'App ID', required: true } },
  async run({ args }) {
    const c = client(args)
    try {
      const a = await c.getApp(String(args.id))
      emit('apps.get', { app: toAppSummary(a), services: a.services ?? [] })
    } catch (err) {
      emitError('apps.get', 'FETCH_FAILED', err instanceof Error ? err.message : String(err))
    }
  },
})

const appsDeployCommand = defineCommand({
  meta: { name: 'deploy', description: 'Trigger a deployment' },
  args: { ...verbArgs, id: { type: 'positional' as const, description: 'App ID', required: true } },
  async run({ args }) {
    const c = client(args)
    try {
      const r = await c.deployApp(String(args.id))
      emit('apps.deploy', { success: r.success, deployment_id: r.deployment?.id ?? null, error: r.error ?? null })
    } catch (err) {
      emitError('apps.deploy', 'DEPLOY_FAILED', err instanceof Error ? err.message : String(err))
    }
  },
})

const appsStopCommand = defineCommand({
  meta: { name: 'stop', description: 'Stop an app' },
  args: { ...verbArgs, id: { type: 'positional' as const, description: 'App ID', required: true } },
  async run({ args }) {
    const c = client(args)
    try {
      const r = await c.stopApp(String(args.id))
      emit('apps.stop', { success: r.success, error: r.error ?? null })
    } catch (err) {
      emitError('apps.stop', 'STOP_FAILED', err instanceof Error ? err.message : String(err))
    }
  },
})

const appsRollbackCommand = defineCommand({
  meta: { name: 'rollback', description: 'Rollback to a previous deployment' },
  args: {
    ...verbArgs,
    id: { type: 'positional' as const, description: 'App ID', required: true },
    deployment: { type: 'positional' as const, description: 'Deployment ID to roll back to', required: true },
  },
  async run({ args }) {
    const c = client(args)
    try {
      const r = await c.rollbackApp(String(args.id), String(args.deployment))
      emit('apps.rollback', { success: r.success, deployment_id: r.deployment?.id ?? null, error: r.error ?? null })
    } catch (err) {
      emitError('apps.rollback', 'ROLLBACK_FAILED', err instanceof Error ? err.message : String(err))
    }
  },
})

const appsLogsCommand = defineCommand({
  meta: { name: 'logs', description: 'Fetch service logs' },
  args: {
    ...verbArgs,
    id: { type: 'positional' as const, description: 'App ID', required: true },
    service: { type: 'string' as const, description: 'Specific service to filter' },
    tail: { type: 'string' as const, description: 'Number of trailing log lines' },
  },
  async run({ args }) {
    const c = client(args)
    try {
      const r = await c.getAppLogs(String(args.id), {
        service: args.service ? String(args.service) : undefined,
        tail: args.tail ? Number(args.tail) : undefined,
      })
      emit('apps.logs', { app_id: String(args.id), service: args.service ?? null, logs: r.logs })
    } catch (err) {
      emitError('apps.logs', 'FETCH_FAILED', err instanceof Error ? err.message : String(err))
    }
  },
})

export const appsCommand = defineCommand({
  meta: { name: 'apps', description: 'App verbs for Mattermost plugin contract' },
  args: verbArgs,
  subCommands: {
    list: appsListCommand,
    get: appsGetCommand,
    deploy: appsDeployCommand,
    stop: appsStopCommand,
    rollback: appsRollbackCommand,
    logs: appsLogsCommand,
  },
  async run({ args }) {
    const positionals = (args._ as string[] | undefined) ?? []
    if (positionals.length > 0) return
    const c = client(args)
    try {
      const apps = await c.listApps()
      emit('apps.list', { apps: apps.map(toAppSummary), total: apps.length })
    } catch (err) {
      emitError('apps.list', 'FETCH_FAILED', err instanceof Error ? err.message : String(err))
    }
  },
})

// ============================================================================
// search
// ============================================================================

export const searchCommand = defineCommand({
  meta: { name: 'search', description: 'Unified full-text search' },
  args: {
    ...verbArgs,
    query: { type: 'positional' as const, description: 'Search query', required: true },
    limit: { type: 'string' as const, description: 'Max results (default 25)' },
  },
  async run({ args }) {
    const c = client(args)
    try {
      const results = await c.search({
        query: String(args.query),
        limit: args.limit ? Number(args.limit) : 25,
      })
      emit('search', {
        query: String(args.query),
        total: results.length,
        results,
      })
    } catch (err) {
      emitError('search', 'FETCH_FAILED', err instanceof Error ? err.message : String(err))
    }
  },
})

// ============================================================================
// monitor
// ============================================================================

export type MonitorStatus = 'reporting' | 'no_data_in_window' | 'unconfigured'

const MONITOR_STATUS_VALUES: ReadonlySet<MonitorStatus> = new Set<MonitorStatus>([
  'reporting',
  'no_data_in_window',
  'unconfigured',
])

interface SystemMetricsResponse {
  window: string
  hostId: string
  monitorStatus?: string
  lastSampleAt?: string | null
  since?: string
  current?: {
    cpu?: number | null
    memory?: { usedPercent?: number | null } | null
    disk?: { usedPercent?: number | null } | null
  } | null
}

export interface MonitorPayload {
  host_id: string
  window: string
  monitor_status: MonitorStatus
  last_sample_at: string | null
  since: string
  cpu_percent: number | null
  memory_percent: number | null
  disk_percent: number | null
}

// Window suffix grammar matches server `parseWindow` ("1h", "30m", ...).
// Returns null for unparseable strings so callers can fall back deliberately.
function windowToMs(window: string): number | null {
  const match = window.match(/^(\d+)(m|h)$/)
  if (!match) return null
  const value = parseInt(match[1], 10)
  return match[2] === 'h' ? value * 3600_000 : value * 60_000
}

export function buildMonitorPayload(
  metrics: SystemMetricsResponse,
  now: Date = new Date()
): MonitorPayload {
  const rawStatus = metrics.monitorStatus
  const monitorStatus: MonitorStatus =
    rawStatus && MONITOR_STATUS_VALUES.has(rawStatus as MonitorStatus)
      ? (rawStatus as MonitorStatus)
      : 'unconfigured'
  const lastSampleAt = metrics.lastSampleAt ?? null
  const windowMs = windowToMs(metrics.window) ?? 3600_000
  const since = metrics.since ?? new Date(now.getTime() - windowMs).toISOString()
  const current = metrics.current ?? null
  const isReporting = monitorStatus === 'reporting' && current !== null
  return {
    host_id: metrics.hostId,
    window: metrics.window,
    monitor_status: monitorStatus,
    last_sample_at: lastSampleAt,
    since,
    cpu_percent: isReporting ? (current?.cpu ?? null) : null,
    memory_percent: isReporting ? (current?.memory?.usedPercent ?? null) : null,
    disk_percent: isReporting ? (current?.disk?.usedPercent ?? null) : null,
  }
}

export const monitorCommand = defineCommand({
  meta: { name: 'monitor', description: 'System metrics snapshot' },
  args: {
    ...verbArgs,
    host: { type: 'string' as const, description: 'Host ID to query (default: local)' },
    window: { type: 'string' as const, description: 'Window (e.g. 1h, 30m; default 1h)' },
  },
  async run({ args }) {
    const c = client(args)
    const window = args.window ? String(args.window) : '1h'
    const host = args.host ? String(args.host) : undefined
    try {
      const metrics = await c.getSystemMetrics(window, host)
      emit('monitor', buildMonitorPayload(metrics))
    } catch (err) {
      emitError('monitor', 'FETCH_FAILED', err instanceof Error ? err.message : String(err))
    }
  },
})

// ============================================================================
// jobs
// ============================================================================

export const jobsCommand = defineCommand({
  meta: { name: 'jobs', description: 'List scheduled jobs (systemd/launchd timers)' },
  args: {
    ...verbArgs,
    scope: { type: 'string' as const, description: 'all|user|system (default all)' },
  },
  async run({ args }) {
    const c = client(args)
    const scope = args.scope ? (String(args.scope) as 'all' | 'user' | 'system') : 'all'
    try {
      const jobs = await c.listJobs(scope)
      emit('jobs', { scope, total: jobs.length, jobs: jobs.map(toJobSummary) })
    } catch (err) {
      emitError('jobs', 'FETCH_FAILED', err instanceof Error ? err.message : String(err))
    }
  },
})

// ============================================================================
// projects
// ============================================================================

export const projectsCommand = defineCommand({
  meta: { name: 'projects', description: 'List projects' },
  args: verbArgs,
  async run({ args }) {
    const c = client(args)
    try {
      const projects = await c.listProjects()
      const allTasks = await c.listTasks()
      const tasksByProject = new Map<string, Task[]>()
      for (const t of allTasks) {
        if (!t.projectId) continue
        const list = tasksByProject.get(t.projectId) || []
        list.push(t)
        tasksByProject.set(t.projectId, list)
      }
      emit('projects', {
        total: projects.length,
        projects: projects.map((p) => toProjectSummary(p, tasksByProject.get(p.id) || [])),
      })
    } catch (err) {
      emitError('projects', 'FETCH_FAILED', err instanceof Error ? err.message : String(err))
    }
  },
})

// ============================================================================
// schema constant re-export for callers that want to assert version
// ============================================================================

export { CLI_JSON_SCHEMA_VERSION }
