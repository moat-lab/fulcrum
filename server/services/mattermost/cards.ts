/**
 * Card builder functions for Mattermost interactive messages.
 * Each function returns a Mattermost attachment (card) with fields and action buttons.
 */

import { execFileSync } from 'node:child_process'
import { db, tasks, apps, deployments, projects, tags, taskTags, taskLinks, taskRelationships, terminals } from '../../db'
import { eq, desc, and } from 'drizzle-orm'
import { listJobs } from '../job-service'
import { getActionsUrl, fulcrumUrl } from './client'
import type { MattermostAttachment, MattermostAction, MattermostField } from './client'
import { getPTYManager } from '../../terminal/pty-instance'
import type { NotificationPayload } from '../notification-service'

// --- Helpers ---

const STATUS_EMOJI: Record<string, string> = {
  TO_DO: '📋',
  IN_PROGRESS: '🔄',
  IN_REVIEW: '👀',
  DONE: '✅',
  CANCELED: '❌',
}

const PRIORITY_EMOJI: Record<string, string> = {
  high: '🔴',
  medium: '🟡',
  low: '🟢',
}

const APP_STATUS_EMOJI: Record<string, string> = {
  running: '✅',
  building: '🔨',
  failed: '❌',
  stopped: '⏹',
}

function actionBtn(id: string, name: string, context: Record<string, unknown>, style?: MattermostAction['style']): MattermostAction {
  return {
    id,
    name,
    type: 'button',
    style,
    integration: {
      url: getActionsUrl(),
      context,
    },
  }
}

type AgentRuntimeStatus = 'running' | 'idle' | 'crashed'

function getAgentRuntimeStatusFromDb(worktreePath: string): AgentRuntimeStatus {
  const terminalRecord = db
    .select({ status: terminals.status })
    .from(terminals)
    .where(eq(terminals.cwd, worktreePath))
    .get()

  if (!terminalRecord) {
    return 'idle'
  }

  return terminalRecord.status === 'running' ? 'running' : 'crashed'
}

function getAgentRuntimeStatus(worktreePath: string): AgentRuntimeStatus {
  try {
    const managedTerminal = getPTYManager().listTerminals().find((terminal) => terminal.cwd === worktreePath)
    if (managedTerminal) {
      return managedTerminal.status === 'running' ? 'running' : 'crashed'
    }
  } catch {
    return getAgentRuntimeStatusFromDb(worktreePath)
  }

  return getAgentRuntimeStatusFromDb(worktreePath)
}

function formatAgentStatus(agent: string, taskStatus: string, worktreePath: string | null): string {
  if (taskStatus !== 'IN_PROGRESS' || !worktreePath) {
    return agent
  }

  return `${agent} (${getAgentRuntimeStatus(worktreePath)})`
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—'
  const d = new Date(dateStr)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return '—'
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}min ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function nextTaskStatus(status: string | undefined): string | null {
  switch (status) {
    case 'TO_DO': return 'IN_PROGRESS'
    case 'IN_PROGRESS': return 'IN_REVIEW'
    case 'IN_REVIEW': return 'DONE'
    default: return null
  }
}

function taskNotificationActions(payload: NotificationPayload, actions: MattermostAction[]): void {
  if (!payload.taskId) return
  actions.push(actionBtn('view_task', 'View Task', { action: 'task_detail', task_id: payload.taskId }, 'primary'))
  const statusMatch = payload.message.match(/\b(TO_DO|IN_PROGRESS|IN_REVIEW|DONE|CANCELED)\b/g)
  const nextStatus = nextTaskStatus(statusMatch?.at(-1))
  if (nextStatus) {
    actions.push(actionBtn('next_status', `→ ${nextStatus}`, { action: 'status_change', task_id: payload.taskId, status: nextStatus }, 'good'))
  }
}

function appNotificationActions(payload: NotificationPayload, actions: MattermostAction[], appAction: 'logs' | 'retry' | 'rollback'): void {
  if (!payload.appId) return
  if (appAction === 'logs') actions.push(actionBtn('logs', 'Logs', { action: 'app_logs', app_id: payload.appId }, 'primary'))
  if (appAction === 'retry') actions.push(actionBtn('retry', 'Retry', { action: 'deploy_app', app_id: payload.appId }, 'primary'))
  if (appAction === 'rollback') actions.push(actionBtn('rollback', 'Rollback', { action: 'rollback_app', app_id: payload.appId }, 'danger'))
}

export function buildNotificationCard(payload: NotificationPayload): MattermostAttachment {
  const fields: MattermostField[] = []
  const actions: MattermostAction[] = []

  switch (payload.type) {
    case 'task_status_change':
      if (payload.taskTitle) fields.push({ short: true, title: 'Task', value: payload.taskTitle })
      taskNotificationActions(payload, actions)
      return {
        fallback: `${payload.title}: ${payload.message}`,
        color: '#7C3AED',
        pretext: `#### ${payload.title}`,
        text: payload.message,
        fields: fields.length > 0 ? fields : undefined,
        actions: actions.length > 0 ? actions : undefined,
      }
    case 'pr_merged':
      if (payload.taskTitle) fields.push({ short: true, title: 'Task', value: payload.taskTitle })
      if (payload.url) fields.push({ short: false, title: 'Pull Request', value: payload.url })
      if (payload.taskId) actions.push(actionBtn('view_task', 'View Task', { action: 'task_detail', task_id: payload.taskId }, 'primary'))
      if (payload.url) actions.push(actionBtn('open_pr', 'Open PR ↗', { action: 'open_link', url: payload.url }))
      return {
        fallback: `${payload.title}: ${payload.message}`,
        color: '#22C55E',
        pretext: `#### ${payload.title}`,
        text: payload.message,
        fields: fields.length > 0 ? fields : undefined,
        actions: actions.length > 0 ? actions : undefined,
      }
    case 'deployment_success':
      if (payload.appName) fields.push({ short: true, title: 'App', value: payload.appName })
      appNotificationActions(payload, actions, 'logs')
      appNotificationActions(payload, actions, 'rollback')
      return {
        fallback: `${payload.title}: ${payload.message}`,
        color: '#22C55E',
        pretext: `#### ${payload.title}`,
        text: payload.message,
        fields: fields.length > 0 ? fields : undefined,
        actions: actions.length > 0 ? actions : undefined,
      }
    case 'deployment_failed':
      if (payload.appName) fields.push({ short: true, title: 'App', value: payload.appName })
      appNotificationActions(payload, actions, 'logs')
      appNotificationActions(payload, actions, 'retry')
      appNotificationActions(payload, actions, 'rollback')
      return {
        fallback: `${payload.title}: ${payload.message}`,
        color: '#EF4444',
        pretext: `#### ${payload.title}`,
        text: payload.message,
        fields: fields.length > 0 ? fields : undefined,
        actions: actions.length > 0 ? actions : undefined,
      }
    case 'plan_complete':
      if (payload.taskTitle) fields.push({ short: true, title: 'Task', value: payload.taskTitle })
      if (payload.taskId) {
        actions.push(actionBtn('view_diff', 'View Diff', { action: 'task_detail', task_id: payload.taskId }, 'primary'))
        actions.push(actionBtn('review', '→ Review', { action: 'status_change', task_id: payload.taskId, status: 'IN_REVIEW' }, 'good'))
      }
      return {
        fallback: `${payload.title}: ${payload.message}`,
        color: '#7C3AED',
        pretext: `#### ${payload.title}`,
        text: payload.message,
        fields: fields.length > 0 ? fields : undefined,
        actions: actions.length > 0 ? actions : undefined,
      }
  }
}

function formatJobTime(dateStr: string | null): string {
  if (!dateStr) return '—'
  const date = new Date(dateStr)
  if (Number.isNaN(date.getTime())) return dateStr
  return date.toLocaleString()
}

function listClaudeAgentProcesses(): string[] {
  try {
    const output = execFileSync('pgrep', ['-fl', 'claude|opencode'], { encoding: 'utf-8', timeout: 2000 }).trim()
    if (!output) return []
    return output.split('\n').filter(line => !line.includes('pgrep')).slice(0, 5)
  } catch {
    return []
  }
}

function formatRelationshipLine(taskId: string): string {
  const related = db.select().from(tasks).where(eq(tasks.id, taskId)).get()
  return related ? `#${related.id.slice(0, 6)} ${related.title}` : `#${taskId.slice(0, 6)}`
}

function formatLinkLine(link: { label: string | null; url: string; type: string | null }): string {
  const label = link.label || link.type || link.url
  return `[${label}](${link.url})`
}

// --- Dashboard Card ---

export async function buildDashboardCard(): Promise<MattermostAttachment> {
  const allTasks = db.select().from(tasks).all()
  const allApps = db.select().from(apps).all()

  const tasksByStatus: Record<string, number> = {}
  const dueTodayTasks: typeof allTasks = []
  const today = new Date().toISOString().slice(0, 10)

  for (const t of allTasks) {
    if (t.status === 'DONE' || t.status === 'CANCELED') continue
    tasksByStatus[t.status] = (tasksByStatus[t.status] || 0) + 1
    if (t.dueDate === today) dueTodayTasks.push(t)
  }

  const appsByStatus: Record<string, number> = {}
  for (const a of allApps) {
    appsByStatus[a.status] = (appsByStatus[a.status] || 0) + 1
  }

  const fields: MattermostField[] = [
    {
      short: true,
      title: 'Tasks',
      value: [
        `IN_PROGRESS: **${tasksByStatus['IN_PROGRESS'] || 0}**`,
        `IN_REVIEW: **${tasksByStatus['IN_REVIEW'] || 0}**`,
        `TO_DO: **${tasksByStatus['TO_DO'] || 0}**`,
      ].join('\n'),
    },
    {
      short: true,
      title: 'Apps',
      value: [
        `Running: **${appsByStatus['running'] || 0}**`,
        `Failed: **${appsByStatus['failed'] || 0}**`,
        `Building: **${appsByStatus['building'] || 0}**`,
      ].join('\n'),
    },
  ]

  if (dueTodayTasks.length > 0) {
    fields.push({
      short: false,
      title: `Due Today (${dueTodayTasks.length})`,
      value: dueTodayTasks.slice(0, 5).map(t =>
        `${PRIORITY_EMOJI[t.priority || 'medium']} #${t.id.slice(0, 6)} ${t.title}`
      ).join('\n'),
    })
  }

  const openLink = `[Open in Fulcrum ↗](${fulcrumUrl('/tasks')})`

  return {
    fallback: 'Fulcrum Dashboard',
    color: '#7C3AED',
    pretext: '#### Fulcrum Dashboard',
    fields,
    actions: [
      actionBtn('view_tasks', '📋 Tasks', { action: 'list_tasks', status: 'active' }, 'primary'),
      actionBtn('view_apps', '🚀 Apps', { action: 'list_apps' }),
      actionBtn('new_task', '➕ New Task', { action: 'open_create_task_dialog' }, 'good'),
      actionBtn('monitor', '🖥 Monitor', { action: 'monitor' }),
    ],
    text: openLink,
  }
}

// --- Task List Card ---

export async function buildTaskListCard(filter?: {
  status?: string
  priority?: string
  projectId?: string
  tag?: string
  page?: number
}): Promise<MattermostAttachment> {
  // Build conditions
  const conditions: ReturnType<typeof eq>[] = []

  if (filter?.status === 'active' || !filter?.status) {
    // Default: show non-terminal tasks
  } else if (filter.status) {
    const statusMap: Record<string, string> = {
      doing: 'IN_PROGRESS', progress: 'IN_PROGRESS', wip: 'IN_PROGRESS',
      review: 'IN_REVIEW',
      todo: 'TO_DO',
      done: 'DONE',
      canceled: 'CANCELED',
    }
    const mapped = statusMap[filter.status.toLowerCase()] || filter.status.toUpperCase()
    conditions.push(eq(tasks.status, mapped))
  }

  if (filter?.priority) {
    conditions.push(eq(tasks.priority, filter.priority.toLowerCase()))
  }

  if (filter?.projectId) {
    conditions.push(eq(tasks.projectId, filter.projectId))
  }

  let results = conditions.length > 0
    ? db.select().from(tasks).where(and(...conditions)).all()
    : db.select().from(tasks).all()

  // Filter out terminal statuses when showing 'active'
  if (filter?.status === 'active' || !filter?.status) {
    results = results.filter(t => !['DONE', 'CANCELED'].includes(t.status))
  }

  // Filter by tag if specified
  if (filter?.tag) {
    const tagRows = db.select().from(tags).where(eq(tags.name, filter.tag)).all()
    if (tagRows.length > 0) {
      const taggedTaskIds = db.select({ taskId: taskTags.taskId }).from(taskTags)
        .where(eq(taskTags.tagId, tagRows[0].id)).all().map(r => r.taskId)
      results = results.filter(t => taggedTaskIds.includes(t.id))
    } else {
      results = []
    }
  }

  // Sort: high priority first, then by due date
  results.sort((a, b) => {
    const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 }
    const pa = priorityOrder[a.priority || 'medium'] ?? 1
    const pb = priorityOrder[b.priority || 'medium'] ?? 1
    if (pa !== pb) return pa - pb
    if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate)
    if (a.dueDate) return -1
    if (b.dueDate) return 1
    return 0
  })

  const pageSize = 10
  const page = Math.max(1, filter?.page || 1)
  const totalPages = Math.max(1, Math.ceil(results.length / pageSize))
  const currentPage = Math.min(page, totalPages)
  const limited = results.slice((currentPage - 1) * pageSize, currentPage * pageSize)
  const statusLabel = filter?.status
    ? (filter.status === 'active' ? 'Active' : filter.status.toUpperCase())
    : 'Active'

  const lines = limited.map(t => {
    const emoji = STATUS_EMOJI[t.status] || '📋'
    const pri = PRIORITY_EMOJI[t.priority || 'medium'] || ''
    const due = t.dueDate ? ` due ${formatDate(t.dueDate)}` : ''
    const repo = t.repoName ? ` · ${t.repoName}` : ''
    return `${emoji} ${pri} **#${t.id.slice(0, 6)}** ${t.title}${repo}${due}`
  })

  const actions: MattermostAction[] = limited.slice(0, 5).map(t =>
    actionBtn(`task_${t.id}`, `#${t.id.slice(0, 6)}`, { action: 'task_detail', task_id: t.id })
  )

  const pageContext = {
    action: 'list_tasks',
    status: filter?.status || 'active',
    priority: filter?.priority,
    project_id: filter?.projectId,
    tag: filter?.tag,
  }
  if (currentPage > 1) {
    actions.push(actionBtn('prev_page', '← Prev', { ...pageContext, page: currentPage - 1 }))
  }
  if (currentPage < totalPages) {
    actions.push(actionBtn('next_page', 'Next →', { ...pageContext, page: currentPage + 1 }, 'primary'))
  }
  actions.push(actionBtn('new_task', '➕ New', { action: 'open_create_task_dialog' }, 'good'))

  const openLink = `[Open in Fulcrum ↗](${fulcrumUrl('/tasks')})`

  return {
    fallback: `Tasks — ${statusLabel}`,
    color: '#3B82F6',
    pretext: `#### Tasks — ${statusLabel} (${results.length}) · Page ${currentPage}/${totalPages}`,
    text: [lines.join('\n') || '_No tasks found_', openLink].filter(Boolean).join('\n\n'),
    actions,
  }
}

// --- Task Detail Card ---

export async function buildTaskDetailCard(taskId: string): Promise<MattermostAttachment> {
  // Find task - try exact match first, then prefix match
  let task = db.select().from(tasks).where(eq(tasks.id, taskId)).get()
  if (!task) {
    const allTasks = db.select().from(tasks).all()
    task = allTasks.find(t => t.id.startsWith(taskId))
  }

  if (!task) {
    return {
      fallback: 'Task not found',
      color: '#EF4444',
      text: `Task **${taskId}** not found.`,
    }
  }

  const statusEmoji = STATUS_EMOJI[task.status] || ''
  const priEmoji = PRIORITY_EMOJI[task.priority || 'medium'] || ''

  // Get tags for this task
  const taskTagRows = db.select({ name: tags.name })
    .from(taskTags)
    .innerJoin(tags, eq(tags.id, taskTags.tagId))
    .where(eq(taskTags.taskId, task.id))
    .all()
  const tagStr = taskTagRows.length > 0 ? taskTagRows.map(t => `\`${t.name}\``).join(' ') : ''

  const fields: MattermostField[] = [
    { short: true, title: 'Status', value: `${statusEmoji} ${task.status}` },
    { short: true, title: 'Priority', value: `${priEmoji} ${task.priority || 'medium'}` },
  ]

  if (task.repoName) {
    fields.push({ short: true, title: 'Repository', value: task.repoName })
  }
  if (task.branch) {
    fields.push({ short: true, title: 'Branch', value: `\`${task.branch}\`` })
  }
  if (task.dueDate) {
    fields.push({ short: true, title: 'Due', value: task.dueDate })
  }
  if (task.timeEstimate) {
    fields.push({ short: true, title: 'Estimate', value: `${task.timeEstimate}h` })
  }
  if (task.agent) {
    fields.push({ short: true, title: 'Agent', value: formatAgentStatus(task.agent, task.status, task.worktreePath) })
  }
  if (tagStr) {
    fields.push({ short: false, title: 'Tags', value: tagStr })
  }

  if (task.prUrl) {
    fields.push({ short: false, title: 'PR', value: `[${task.prUrl}](${task.prUrl})` })
  }

  const links = db.select().from(taskLinks).where(eq(taskLinks.taskId, task.id)).all()
  if (links.length > 0) {
    fields.push({ short: false, title: 'Links', value: links.slice(0, 5).map(formatLinkLine).join('\n') })
  }

  const outgoingRelationships = db.select().from(taskRelationships)
    .where(eq(taskRelationships.taskId, task.id))
    .all()
  const incomingRelationships = db.select().from(taskRelationships)
    .where(eq(taskRelationships.relatedTaskId, task.id))
    .all()
  const dependencies = outgoingRelationships.filter(r => r.type === 'depends_on')
  const dependents = incomingRelationships.filter(r => r.type === 'depends_on')
  if (dependencies.length > 0) {
    fields.push({ short: false, title: 'Depends On', value: dependencies.slice(0, 5).map(r => formatRelationshipLine(r.relatedTaskId)).join('\n') })
  }
  if (dependents.length > 0) {
    fields.push({ short: false, title: 'Blocked By This', value: dependents.slice(0, 5).map(r => formatRelationshipLine(r.taskId)).join('\n') })
  }

  // Build status transition buttons based on current status
  const actions: MattermostAction[] = []

  switch (task.status) {
    case 'TO_DO':
      actions.push(actionBtn('start', '▶ Start', { action: 'status_change', task_id: task.id, status: 'IN_PROGRESS' }, 'primary'))
      actions.push(actionBtn('cancel', '✕ Cancel', { action: 'status_change', task_id: task.id, status: 'CANCELED' }, 'danger'))
      break
    case 'IN_PROGRESS':
      actions.push(actionBtn('review', '→ Review', { action: 'status_change', task_id: task.id, status: 'IN_REVIEW' }, 'primary'))
      actions.push(actionBtn('done', '→ Done', { action: 'status_change', task_id: task.id, status: 'DONE' }, 'good'))
      actions.push(actionBtn('cancel', '✕ Cancel', { action: 'status_change', task_id: task.id, status: 'CANCELED' }, 'danger'))
      if (task.worktreePath) {
        actions.push(actionBtn('kill_agent', 'Kill Agent', { action: 'kill_agent', task_id: task.id }, 'danger'))
      }
      break
    case 'IN_REVIEW':
      actions.push(actionBtn('done', '→ Done', { action: 'status_change', task_id: task.id, status: 'DONE' }, 'good'))
      actions.push(actionBtn('back', '← Progress', { action: 'status_change', task_id: task.id, status: 'IN_PROGRESS' }))
      actions.push(actionBtn('cancel', '✕ Cancel', { action: 'status_change', task_id: task.id, status: 'CANCELED' }, 'danger'))
      break
    case 'DONE':
    case 'CANCELED':
      actions.push(actionBtn('reopen', '↺ Reopen', { action: 'status_change', task_id: task.id, status: 'TO_DO' }))
      break
  }

  // Priority change dropdown
  const priorityOptions = [
    { text: '🔴 High', value: 'high' },
    { text: '🟡 Medium', value: 'medium' },
    { text: '🟢 Low', value: 'low' },
  ]
  const currentPriority = task.priority || 'medium'
  actions.push({
    id: 'change_priority',
    name: 'Priority',
    type: 'select',
    integration: {
      url: getActionsUrl(),
      context: { action: 'change_priority', task_id: task.id },
    },
    options: priorityOptions,
    default_option: priorityOptions.find(o => o.value === currentPriority),
  })

  const openLink = `[Open in Fulcrum ↗](${fulcrumUrl(`/tasks/${task.id}`)})`
  const descText = task.description ? `\n${task.description.slice(0, 200)}${task.description.length > 200 ? '...' : ''}` : ''
  const text = [descText.trim(), openLink].filter(Boolean).join('\n\n')

  return {
    fallback: `Task #${task.id.slice(0, 6)} — ${task.title}`,
    color: task.status === 'DONE' ? '#22C55E' : task.status === 'CANCELED' ? '#6B7280' : '#7C3AED',
    pretext: `#### Task #${task.id.slice(0, 6)} — ${task.title}`,
    text: text || undefined,
    fields,
    actions,
  }
}

// --- Apps List Card ---

export async function buildAppsCard(): Promise<MattermostAttachment> {
  const allApps = db.select().from(apps).all()

  if (allApps.length === 0) {
    return {
      fallback: 'No apps',
      color: '#6B7280',
      text: '_No applications deployed._',
    }
  }

  const lines = allApps.map(a => {
    const emoji = APP_STATUS_EMOJI[a.status] || '❓'
    const deployed = a.lastDeployedAt ? timeAgo(a.lastDeployedAt) : 'never'
    return `${emoji} **${a.name}** · ${a.status} · ${a.branch} · ${deployed}`
  })

  const actions: MattermostAction[] = allApps.slice(0, 5).map(a =>
    actionBtn(`app_${a.id}`, a.name, { action: 'app_detail', app_id: a.id })
  )

  const openLink = `[Open in Fulcrum ↗](${fulcrumUrl('/apps')})`

  return {
    fallback: `Applications (${allApps.length})`,
    color: '#10B981',
    pretext: `#### Applications (${allApps.length})`,
    text: [lines.join('\n'), openLink].filter(Boolean).join('\n\n'),
    actions,
  }
}

// --- App Detail / Deploy Card ---

export async function buildAppDetailCard(appId: string): Promise<MattermostAttachment> {
  const app = db.select().from(apps).where(eq(apps.id, appId)).get()
  if (!app) {
    return { fallback: 'App not found', color: '#EF4444', text: `App **${appId}** not found.` }
  }

  const recentDeploys = db.select().from(deployments)
    .where(eq(deployments.appId, appId))
    .orderBy(desc(deployments.createdAt))
    .limit(3)
    .all()

  const fields: MattermostField[] = [
    { short: true, title: 'Status', value: `${APP_STATUS_EMOJI[app.status] || ''} ${app.status}` },
    { short: true, title: 'Branch', value: app.branch },
  ]

  if (app.lastDeployedAt) {
    fields.push({ short: true, title: 'Last Deploy', value: timeAgo(app.lastDeployedAt) })
  }
  if (app.lastDeployCommit) {
    fields.push({ short: true, title: 'Commit', value: `\`${app.lastDeployCommit.slice(0, 7)}\`` })
  }

  if (recentDeploys.length > 0) {
    const deployLines = recentDeploys.map(d => {
      const icon = d.status === 'running' ? '✓' : d.status === 'failed' ? '✗' : '·'
      const commit = d.gitCommit ? d.gitCommit.slice(0, 7) : '—'
      return `${icon} \`${commit}\` ${timeAgo(d.createdAt)} ${d.deployedBy || ''}`
    })
    fields.push({ short: false, title: 'Recent Deployments', value: deployLines.join('\n') })
  }

  const actions: MattermostAction[] = [
    actionBtn('deploy', '🚀 Deploy Now', { action: 'deploy_app', app_id: app.id }, 'primary'),
  ]

  if (app.status === 'running') {
    actions.push(actionBtn('stop', '⏹ Stop', { action: 'stop_app', app_id: app.id }, 'danger'))
  }

  actions.push(actionBtn('logs', '📋 Logs', { action: 'app_logs', app_id: app.id }))

  if (recentDeploys.length > 0) {
    actions.push({
      id: 'rollback',
      name: '↩ Rollback',
      type: 'select',
      integration: {
        url: getActionsUrl(),
        context: { action: 'rollback_app', app_id: app.id },
      },
      options: recentDeploys
        .filter(d => d.status === 'running')
        .map(d => ({
          text: `${d.gitCommit?.slice(0, 7) || '—'} (${timeAgo(d.createdAt)})`,
          value: d.id,
        })),
    })
  }

  const openLink = `[Open in Fulcrum ↗](${fulcrumUrl('/apps')})`

  return {
    fallback: `App — ${app.name}`,
    color: app.status === 'running' ? '#22C55E' : app.status === 'failed' ? '#EF4444' : '#6B7280',
    pretext: `#### 🚀 ${app.name}`,
    text: openLink,
    fields,
    actions,
  }
}

// --- Monitor Card ---

export async function buildMonitorCard(): Promise<MattermostAttachment> {
  // Get system metrics via the monitoring endpoint logic
  let cpuInfo = '—'
  let memInfo = '—'

  try {
    const os = await import('os')
    const totalMem = os.totalmem()
    const freeMem = os.freemem()
    const usedMem = totalMem - freeMem
    const memPct = Math.round((usedMem / totalMem) * 100)
    memInfo = `${memPct}% (${(usedMem / 1073741824).toFixed(1)}G / ${(totalMem / 1073741824).toFixed(1)}G)`

    const cpus = os.cpus()
    const avgIdle = cpus.reduce((sum, cpu) => {
      const total = Object.values(cpu.times).reduce((a, b) => a + b, 0)
      return sum + cpu.times.idle / total
    }, 0) / cpus.length
    cpuInfo = `${Math.round((1 - avgIdle) * 100)}%`
  } catch {
    // Ignore
  }

  const fields: MattermostField[] = [
    { short: true, title: 'CPU', value: cpuInfo },
    { short: true, title: 'RAM', value: memInfo },
  ]

  const agentProcesses = listClaudeAgentProcesses()
  fields.push({
    short: false,
    title: `Agent Processes (${agentProcesses.length})`,
    value: agentProcesses.length > 0 ? agentProcesses.map(line => `\`${line.slice(0, 120)}\``).join('\n') : '_No Claude/OpenCode processes found_',
  })

  const openLink = `[Open in Fulcrum ↗](${fulcrumUrl('/monitoring')})`

  return {
    fallback: 'System Monitor',
    color: '#8B5CF6',
    pretext: '#### 🖥 System Monitor',
    fields,
    actions: [
      actionBtn('refresh', '🔄 Refresh', { action: 'monitor' }),
    ],
    text: openLink,
  }
}

// --- Jobs Card ---

export async function buildJobsCard(): Promise<MattermostAttachment> {
  const jobs = listJobs('all')

  if (jobs.length === 0) {
    return {
      fallback: 'Scheduled Jobs',
      color: '#6B7280',
      pretext: '#### Scheduled Jobs',
      text: '_No scheduled jobs found or jobs are unavailable on this platform._',
      actions: [actionBtn('open', 'Open ↗', { action: 'open_link', url: fulcrumUrl('/jobs') })],
    }
  }

  const stateEmoji: Record<string, string> = {
    active: '✅',
    inactive: '⏸',
    failed: '❌',
    waiting: '⏳',
  }
  const lines = jobs.slice(0, 10).map(job => {
    const emoji = stateEmoji[job.state] || '•'
    const enabled = job.enabled ? 'enabled' : 'disabled'
    return `${emoji} **${job.name}** · ${job.scope} · ${enabled} · next ${formatJobTime(job.nextRun)}`
  })

  return {
    fallback: `Scheduled Jobs (${jobs.length})`,
    color: '#0EA5E9',
    pretext: `#### Scheduled Jobs (${jobs.length})`,
    text: lines.join('\n'),
    actions: [actionBtn('open', 'Open ↗', { action: 'open_link', url: fulcrumUrl('/jobs') })],
  }
}

// --- Projects Card ---

export async function buildProjectsCard(): Promise<MattermostAttachment> {
  const allProjects = db.select().from(projects).where(eq(projects.status, 'active')).all()

  if (allProjects.length === 0) {
    return { fallback: 'No projects', color: '#6B7280', text: '_No active projects._' }
  }

  // Count tasks per project
  const allTasks = db.select().from(tasks).all()
  const taskCountByProject: Record<string, { total: number; active: number }> = {}
  for (const t of allTasks) {
    if (!t.projectId) continue
    if (!taskCountByProject[t.projectId]) taskCountByProject[t.projectId] = { total: 0, active: 0 }
    taskCountByProject[t.projectId].total++
    if (!['DONE', 'CANCELED'].includes(t.status)) taskCountByProject[t.projectId].active++
  }

  const lines = allProjects.map(p => {
    const counts = taskCountByProject[p.id] || { total: 0, active: 0 }
    return `**${p.name}** · ${counts.total} tasks (${counts.active} active)`
  })

  const actions: MattermostAction[] = allProjects.slice(0, 5).map(p =>
    actionBtn(`proj_${p.id}`, p.name, { action: 'list_tasks', project_id: p.id })
  )

  const openLink = `[Open in Fulcrum ↗](${fulcrumUrl('/repositories')})`

  return {
    fallback: `Projects (${allProjects.length})`,
    color: '#F59E0B',
    pretext: `#### Projects — Active (${allProjects.length})`,
    text: [lines.join('\n'), openLink].filter(Boolean).join('\n\n'),
    actions,
  }
}

// --- Search Card ---

export async function buildSearchCard(query: string): Promise<MattermostAttachment> {
  const { search } = await import('../search-service')
  const results = await search({ query, limit: 10 })

  const lines: string[] = []
  const taskActions: MattermostAction[] = []

  // Group results by entity type
  const byType: Record<string, typeof results> = {}
  for (const r of results) {
    if (!byType[r.entityType]) byType[r.entityType] = []
    byType[r.entityType].push(r)
  }

  if (byType.task?.length) {
    lines.push('**Tasks:**')
    for (const r of byType.task) {
      const status = (r.metadata?.status as string) || ''
      const emoji = STATUS_EMOJI[status] || '📋'
      lines.push(`${emoji} #${r.id.slice(0, 6)} ${r.title} · ${status}`)
      if (taskActions.length < 4) {
        taskActions.push(actionBtn(`task_${r.id}`, `#${r.id.slice(0, 6)}`, { action: 'task_detail', task_id: r.id }))
      }
    }
  }

  if (byType.project?.length) {
    lines.push('')
    lines.push('**Projects:**')
    for (const r of byType.project) {
      lines.push(`📁 ${r.title}`)
    }
  }

  if (byType.memory?.length) {
    lines.push('')
    lines.push('**Memories:**')
    for (const r of byType.memory) {
      lines.push(`🧠 ${r.title}`)
    }
  }

  if (lines.length === 0) {
    lines.push(`_No results for "${query}"_`)
  }

  const openLink = `[Open in Fulcrum ↗](${fulcrumUrl(`/search?q=${encodeURIComponent(query)}`)})`

  return {
    fallback: `Search: ${query}`,
    color: '#6366F1',
    pretext: `#### 🔍 Search: "${query}" (${results.length} results)`,
    text: [lines.join('\n'), openLink].filter(Boolean).join('\n\n'),
    actions: taskActions.length > 0 ? taskActions : undefined,
  }
}
