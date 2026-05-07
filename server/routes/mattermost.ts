/**
 * Mattermost integration routes.
 *
 * POST /commands  — Slash command handler (/f)
 * POST /actions   — Interactive button/select callbacks
 * POST /dialogs   — Dialog (modal form) submissions
 */

import { Hono } from 'hono'
import { getSettings, updateSettingByPath } from '../lib/settings'
import { log } from '../lib/logger'
import { updateTaskStatus } from '../services/task-status'
import { deployApp, stopApp, rollbackApp, getProjectName } from '../services/deployment'
import { stackServices, serviceLogs } from '../services/docker-swarm'
import { db, tasks, projects, repositories, apps } from '../db'
import { eq } from 'drizzle-orm'
import { killClaudeInTerminalsForWorktree } from '../terminal/pty-instance'
import { createTaskRecord } from './tasks'
import {
  buildDashboardCard,
  buildTaskListCard,
  buildTaskDetailCard,
  buildTaskDiffCard,
  buildAppsCard,
  buildAppDetailCard,
  buildMonitorCard,
  buildJobsCard,
  buildProjectsCard,
  buildSearchCard,
  buildDeployFailedCard,
} from '../services/mattermost/cards'
import { openDialog, postMessage, updatePost, getActionsUrl, fulcrumUrl } from '../services/mattermost/client'
import { getPTYManager } from '../terminal/pty-instance'
import type { MattermostAttachment, MattermostDialog } from '../services/mattermost/client'

const MATTERMOST_RESPONSE_USERNAME = 'fulcrum'
const MATTERMOST_RESPONSE_ICON_PATH = '/icon-192.png'
const VALID_STATUS = new Set(['TO_DO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE', 'CANCELED'])
const VALID_PRIORITY = new Set(['high', 'medium', 'low'])
const VALID_TASK_TYPE = new Set(['worktree', 'scratch', 'manual'])
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const DESTRUCTIVE_ACTIONS = new Set(['stop_app', 'kill_agent'])
const DESTRUCTIVE_STATUS = new Set(['CANCELED'])
const IN_CHANNEL_SUBCOMMANDS = new Set(['', 'deploy'])

type MattermostPostUpdateTarget = { postId: string } | { postId: null }

type MattermostDialogSubmission =
  | { callbackId: 'create_task'; submission: CreateTaskSubmission; channelId: string }
  | { callbackId: 'configure_settings'; submission: ConfigureSettingsSubmission }

type CreateTaskSubmission = {
  title?: string
  description?: string
  priority?: string
  type?: string
  project_id?: string
  repository_id?: string
  due_date?: string
  tags?: string
}

type ConfigureSettingsSubmission = {
  server_url?: string
  bot_token?: string
  team_id?: string
  channel_id?: string
  command_token?: string
}

type DialogValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: Record<string, string> }

function parseDialogSubmission(body: Record<string, unknown>): DialogValidationResult<MattermostDialogSubmission> {
  const callbackId = body.callback_id
  const submission = (body.submission ?? {}) as Record<string, unknown>

  switch (callbackId) {
    case 'create_task':
      return {
        ok: true,
        value: {
          callbackId,
          submission: submission as CreateTaskSubmission,
          channelId: typeof body.channel_id === 'string' ? body.channel_id : '',
        },
      }
    case 'configure_settings':
      return { ok: true, value: { callbackId, submission: submission as ConfigureSettingsSubmission } }
    default:
      return { ok: false, errors: { '': `Unknown dialog: ${String(callbackId)}` } }
  }
}

function parseMattermostTags(input: string | undefined): string[] {
  if (!input) return []
  return Array.from(new Set(input.split(',').map(tag => tag.trim()).filter(Boolean)))
}

function normalizeDueDate(input: string | undefined): DialogValidationResult<string | null> {
  const value = input?.trim()
  if (!value) return { ok: true, value: null }
  if (!DATE_PATTERN.test(value)) return { ok: false, errors: { due_date: 'Use YYYY-MM-DD' } }
  return { ok: true, value }
}

type MattermostAuthResult =
  | { ok: true }
  | { ok: false; message: string }

const app = new Hono()

function mattermostUpdate(attachment: MattermostAttachment) {
  return { props: { attachments: [attachment] } }
}

async function updateMattermostPost(target: MattermostPostUpdateTarget, attachment: MattermostAttachment): Promise<void> {
  if (target.postId === null) return
  await updatePost(target.postId, mattermostUpdate(attachment))
}

function buildDeploymentProgressCard(appName: string, progress: { stage: string; message: string; progress?: number }): MattermostAttachment {
  const pct = progress.progress ?? 0
  const filled = Math.max(0, Math.min(10, Math.round(pct / 10)))
  const bar = pct > 0 ? `\n${'█'.repeat(filled)}${'░'.repeat(10 - filled)} ${pct}%` : ''
  return {
    fallback: `Deploying ${appName}`,
    color: progress.stage === 'failed' ? '#EF4444' : progress.stage === 'done' ? '#22C55E' : '#F59E0B',
    pretext: `#### 🔨 Deploying ${appName}`,
    text: `**${progress.stage}** — ${progress.message}${bar}`,
  }
}

function authorizeMattermostRequest(token: string | undefined, userId: string | undefined): MattermostAuthResult {
  const config = getSettings().channels.mattermost
  if (!config.enabled) {
    return { ok: false, message: 'Mattermost integration disabled.' }
  }
  if (!config.commandToken) {
    log.messaging.error('Mattermost commandToken not configured — refusing callback')
    return { ok: false, message: 'Mattermost commandToken not configured.' }
  }
  if (token !== config.commandToken) {
    return { ok: false, message: 'Invalid command token.' }
  }
  if (config.allowedUserIds.length > 0 && (!userId || !config.allowedUserIds.includes(userId))) {
    return { ok: false, message: 'Mattermost user not allowed.' }
  }
  return { ok: true }
}

// --- Slash Command Handler ---
// Mattermost sends application/x-www-form-urlencoded
app.post('/commands', async (c) => {
  const body = await c.req.parseBody()
  const token = body.token as string | undefined
  const text = (body.text as string || '').trim()
  const triggerId = body.trigger_id as string
  const channelId = body.channel_id as string
  const userId = body.user_id as string | undefined

  const auth = authorizeMattermostRequest(token, userId)
  if (!auth.ok) {
    return c.json({ response_type: 'ephemeral', text: auth.message })
  }

  const subcommand = text.split(/\s+/)[0]?.toLowerCase() || ''
  const inChannel = IN_CHANNEL_SUBCOMMANDS.has(subcommand)

  try {
    const attachment = await dispatchCommand(text, triggerId, channelId, userId)
    return c.json({
      response_type: inChannel ? 'in_channel' : 'ephemeral',
      username: MATTERMOST_RESPONSE_USERNAME,
      icon_url: fulcrumUrl(MATTERMOST_RESPONSE_ICON_PATH),
      props: { attachments: [attachment] },
    })
  } catch (err) {
    log.messaging.error('Mattermost command error', { text, error: String(err) })
    return c.json({
      response_type: 'ephemeral',
      text: `Error: ${err instanceof Error ? err.message : String(err)}`,
    })
  }
})

// Command dispatcher - parse subcommand and args
async function dispatchCommand(text: string, triggerId: string, _channelId: string, _userId: string) {
  const parts = text.split(/\s+/)
  const subcommand = parts[0]?.toLowerCase() || ''
  const args = parts.slice(1).join(' ')

  switch (subcommand) {
    case '':
      return buildDashboardCard()

    case 'tasks': {
      const filter = parseTaskFilter(args)
      return buildTaskListCard(filter)
    }

    case 'task': {
      if (!args) return buildTaskListCard()
      return buildTaskDetailCard(args.trim())
    }

    case 'new': {
      await openCreateTaskDialog(triggerId, args)
      return { text: '_Opening create task dialog..._', color: '#7C3AED' }
    }

    case 'deploy': {
      if (!args) return buildAppsCard()
      // Find app by name
      const allApps = db.select().from(apps).all()
      const matched = allApps.find(a => a.name.toLowerCase() === args.toLowerCase())
      if (!matched) {
        return { text: `App "${args}" not found. Use \`/f apps\` to list all apps.`, color: '#EF4444' }
      }
      return buildAppDetailCard(matched.id)
    }

    case 'apps':
      return buildAppsCard()

    case 'search':
      if (!args) return { text: 'Usage: `/f search <keywords>`', color: '#6B7280' }
      return buildSearchCard(args)

    case 'monitor':
      return buildMonitorCard()

    case 'settings': {
      await openConfigureSettingsDialog(triggerId)
      return { text: '_Opening Mattermost settings dialog..._', color: '#7C3AED' }
    }

    case 'jobs':
      return buildJobsCard()

    case 'projects':
      return buildProjectsCard()

    case 'help':
      return buildHelpCard()

    default:
      // Unknown subcommand — show help.
      // Use `/f task <id>` to look up a task by ID; we don't auto-detect IDs here
      // because nanoid prefixes can collide and arbitrary 4+ char tokens are too greedy.
      return buildHelpCard()
  }
}

function parseTaskFilter(args: string) {
  const filter: { status?: string; priority?: string; projectId?: string; tag?: string; page?: number } = {}
  if (!args) return { status: 'active' }

  const parts = args.split(/\s+/)
  for (const part of parts) {
    const lower = part.toLowerCase()
    if (['doing', 'progress', 'wip', 'review', 'todo', 'done', 'canceled'].includes(lower)) {
      filter.status = lower
    } else if (['high', 'medium', 'low'].includes(lower)) {
      filter.priority = lower
    } else if (part.startsWith('#')) {
      filter.tag = part.slice(1)
    } else if (/^page=\d+$/i.test(part)) {
      filter.page = Number(part.split('=')[1])
    } else if (part.startsWith('@')) {
      // Find project by name
      const name = part.slice(1)
      const proj = db.select().from(projects).all().find(p => p.name.toLowerCase() === name.toLowerCase())
      if (proj) filter.projectId = proj.id
    } else {
      filter.status = lower
    }
  }

  return filter
}

function buildHelpCard() {
  return {
    fallback: 'Fulcrum Help',
    color: '#7C3AED',
    pretext: '#### Fulcrum Commands',
    text: [
      '`/f` — Dashboard overview',
      '`/f tasks [doing|review|todo|done|high|#tag|@project]` — Task list',
      '`/f task <id>` — Task detail with actions',
      '`/f new <title>` — Create new task',
      '`/f deploy <app>` — App deployment',
      '`/f apps` — All applications',
      '`/f search <keywords>` — Search tasks & projects',
      '`/f monitor` — System resources and agents',
      '`/f settings` — Configure Mattermost integration',
      '`/f jobs` — Scheduled jobs',
      '`/f projects` — Project list',
    ].join('\n'),
  }
}

// --- Create Task Dialog ---

async function openCreateTaskDialog(triggerId: string, prefillTitle: string) {
  const allProjects = db.select().from(projects).where(eq(projects.status, 'active')).all()
  const allRepos = db.select().from(repositories).all()

  const dialog: MattermostDialog = {
    callback_id: 'create_task',
    title: 'Create Task',
    submit_label: 'Create',
    elements: [
      {
        display_name: 'Title',
        name: 'title',
        type: 'text',
        placeholder: 'Task title',
        default: prefillTitle || undefined,
      },
      {
        display_name: 'Description',
        name: 'description',
        type: 'textarea',
        optional: true,
        placeholder: 'What needs to be done?',
      },
      {
        display_name: 'Priority',
        name: 'priority',
        type: 'select',
        default: 'medium',
        options: [
          { text: '🔴 High', value: 'high' },
          { text: '🟡 Medium', value: 'medium' },
          { text: '🟢 Low', value: 'low' },
        ],
      },
      {
        display_name: 'Type',
        name: 'type',
        type: 'select',
        default: getSettings().tasks.defaultTaskType,
        options: [
          { text: 'Worktree (code task)', value: 'worktree' },
          { text: 'Scratch (isolated dir)', value: 'scratch' },
          { text: 'Manual (no directory)', value: 'manual' },
        ],
      },
      {
        display_name: 'Project',
        name: 'project_id',
        type: 'select',
        optional: true,
        options: [
          { text: '— None —', value: '' },
          ...allProjects.map(p => ({ text: p.name, value: p.id })),
        ],
      },
      {
        display_name: 'Repository',
        name: 'repository_id',
        type: 'select',
        optional: true,
        options: [
          { text: '— None —', value: '' },
          ...allRepos.slice(0, 20).map(r => ({ text: r.displayName || r.path.split('/').pop() || r.path, value: r.id })),
        ],
      },
      {
        display_name: 'Due Date (YYYY-MM-DD)',
        name: 'due_date',
        type: 'text',
        optional: true,
        placeholder: '2026-04-15',
      },
      {
        display_name: 'Tags (comma-separated)',
        name: 'tags',
        type: 'text',
        optional: true,
        placeholder: 'bug, urgent',
      },
    ],
  }

  await openDialog(triggerId, dialog)
}

async function openConfigureSettingsDialog(triggerId: string) {
  const config = getSettings().channels.mattermost
  const dialog: MattermostDialog = {
    callback_id: 'configure_settings',
    title: 'Configure Mattermost',
    submit_label: 'Save',
    elements: [
      {
        display_name: 'Server URL',
        name: 'server_url',
        type: 'text',
        default: config.serverUrl || undefined,
        placeholder: 'https://mattermost.example.com',
      },
      {
        display_name: 'Bot Token',
        name: 'bot_token',
        type: 'text',
        subtype: 'password',
        optional: true,
        placeholder: config.botToken ? 'Leave blank to keep current token' : 'Mattermost bot token',
      },
      {
        display_name: 'Team ID',
        name: 'team_id',
        type: 'text',
        default: config.teamId || undefined,
        placeholder: 'Mattermost team ID',
      },
      {
        display_name: 'Default Channel ID',
        name: 'channel_id',
        type: 'text',
        default: config.channelId || undefined,
        placeholder: 'Channel ID for posts/notifications',
      },
      {
        display_name: 'Slash Command Token',
        name: 'command_token',
        type: 'text',
        subtype: 'password',
        optional: true,
        placeholder: config.commandToken ? 'Leave blank to keep current token' : 'Slash command token',
      },
    ],
  }

  await openDialog(triggerId, dialog)
}

function selectedOptionValue(body: Record<string, unknown>): string | undefined {
  const selectedOption = body.selected_option
  if (typeof selectedOption === 'string') return selectedOption
  if (selectedOption && typeof selectedOption === 'object' && 'value' in selectedOption) {
    const value = (selectedOption as { value?: unknown }).value
    if (typeof value === 'string') return value
  }
  return undefined
}

function isConfirmed(context: Record<string, unknown>): boolean {
  return context.confirm === true
}

function confirmationResponse(message: string, context: Record<string, unknown>) {
  const cancelContext = typeof context.task_id === 'string'
    ? { action: 'task_detail', task_id: context.task_id }
    : typeof context.app_id === 'string'
      ? { action: 'app_detail', app_id: context.app_id }
      : { action: 'monitor' }

  return {
    update: {
      props: {
        attachments: [{
          fallback: message,
          color: '#EF4444',
          text: message,
          actions: [
            {
              id: 'confirm',
              name: 'Confirm',
              type: 'button' as const,
              style: 'danger',
              integration: { url: getActionsUrl(), context: { ...context, confirm: true } },
            },
            {
              id: 'cancel',
              name: 'Cancel',
              type: 'button' as const,
              integration: { url: getActionsUrl(), context: cancelContext },
            },
          ],
        }],
      },
    },
  }
}

// --- Action Handler (button/select callbacks) ---

app.post('/actions', async (c) => {
  const body = await c.req.json() as Record<string, unknown>
  const token = body.token as string | undefined
  const context = (body.context && typeof body.context === 'object' ? body.context : {}) as Record<string, unknown>
  const action = context.action as string
  const userId = body.user_id as string | undefined
  const _postId = body.post_id as string
  const triggerId = body.trigger_id as string

  const auth = authorizeMattermostRequest(token, userId)
  if (!auth.ok) {
    return c.json({ ephemeral_text: auth.message })
  }

  try {
    switch (action) {
      case 'list_tasks': {
        const filter: { status?: string; priority?: string; projectId?: string; tag?: string; page?: number } = {}
        if (context.status) filter.status = context.status as string
        if (context.priority) filter.priority = context.priority as string
        if (context.project_id) filter.projectId = context.project_id as string
        if (context.tag) filter.tag = context.tag as string
        if (context.page) filter.page = Number(context.page)
        const card = await buildTaskListCard(filter)
        return c.json({ update: { props: { attachments: [card] } } })
      }

      case 'task_detail': {
        const card = await buildTaskDetailCard(context.task_id as string)
        return c.json({ update: { props: { attachments: [card] } } })
      }

      case 'status_change': {
        const taskId = context.task_id as string
        const newStatus = context.status as string
        if (!VALID_STATUS.has(newStatus)) {
          return c.json({ ephemeral_text: `Invalid status: ${newStatus}` })
        }
        if (DESTRUCTIVE_STATUS.has(newStatus) && !isConfirmed(context)) {
          return c.json(confirmationResponse('Confirm canceling this task?', context))
        }
        await updateTaskStatus(taskId, newStatus)
        const card = await buildTaskDetailCard(taskId)
        return c.json({ update: { props: { attachments: [card] } } })
      }

      case 'change_priority': {
        const taskId = context.task_id as string
        const newPriority = selectedOptionValue(body)
        if (!newPriority || !VALID_PRIORITY.has(newPriority)) {
          return c.json({ ephemeral_text: `Invalid priority: ${newPriority ?? '(none)'}` })
        }
        db.update(tasks).set({
          priority: newPriority,
          updatedAt: new Date().toISOString(),
        }).where(eq(tasks.id, taskId)).run()
        const card = await buildTaskDetailCard(taskId)
        return c.json({ update: { props: { attachments: [card] } } })
      }

      case 'view_diff': {
        const card = await buildTaskDiffCard(context.task_id as string)
        return c.json({ update: mattermostUpdate(card) })
      }

      case 'start_agent': {
        const taskId = context.task_id as string
        const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get()
        if (!task) return c.json({ ephemeral_text: 'Task not found.' })
        if (!task.worktreePath) return c.json({ ephemeral_text: 'Task has no worktree or scratch directory.' })
        try {
          const ptyManager = getPTYManager()
          const terminal = await ptyManager.create({
            name: `${task.agent || 'agent'}: ${task.title.slice(0, 32)}`,
            cwd: task.worktreePath,
            cols: 120,
            rows: 30,
            taskId: task.id,
            hostId: task.hostId ?? undefined,
          })
          const command = task.agent === 'opencode' ? 'opencode\n' : 'claude\n'
          ptyManager.write(terminal.id, command)
          await updateTaskStatus(task.id, 'IN_PROGRESS')
          const card = await buildTaskDetailCard(task.id)
          return c.json({ update: mattermostUpdate(card), ephemeral_text: 'Agent started.' })
        } catch (err) {
          return c.json({ ephemeral_text: `Failed to start agent: ${err instanceof Error ? err.message : String(err)}` })
        }
      }

      case 'list_apps': {
        const card = await buildAppsCard()
        return c.json({ update: { props: { attachments: [card] } } })
      }

      case 'app_detail': {
        const card = await buildAppDetailCard(context.app_id as string)
        return c.json({ update: { props: { attachments: [card] } } })
      }

      case 'deploy_app': {
        const appId = context.app_id as string
        const postTarget: MattermostPostUpdateTarget = body.post_id ? { postId: body.post_id as string } : { postId: null }
        const appRecord = db.select().from(apps).where(eq(apps.id, appId)).get()
        const appName = appRecord?.name ?? 'app'
        try {
          await updateMattermostPost(postTarget, buildDeploymentProgressCard(appName, { stage: 'queued', message: 'Deployment queued...' }))
          const result = await deployApp(appId, { deployedBy: 'manual' }, async (progress) => {
            await updateMattermostPost(postTarget, buildDeploymentProgressCard(appName, progress))
          })
          if (!result.success) {
            const failedCard = buildDeployFailedCard(appId, appName, result.error || 'unknown error')
            await updateMattermostPost(postTarget, failedCard)
            return c.json({ update: mattermostUpdate(failedCard), ephemeral_text: `❌ Deploy failed: ${result.error || 'unknown error'}` })
          }
          const card = await buildAppDetailCard(appId)
          return c.json({ update: mattermostUpdate(card) })
        } catch (err) {
          return c.json({ ephemeral_text: `❌ Deploy failed: ${err}` })
        }
      }

      case 'stop_app': {
        const appId = context.app_id as string
        if (DESTRUCTIVE_ACTIONS.has(action) && !isConfirmed(context)) {
          return c.json(confirmationResponse('Confirm stopping this app?', context))
        }
        try {
          const result = await stopApp(appId)
          if (!result.success) {
            return c.json({ ephemeral_text: `❌ Stop failed: ${result.error || 'unknown error'}` })
          }
          const card = await buildAppDetailCard(appId)
          return c.json({ update: { props: { attachments: [card] } } })
        } catch (err) {
          return c.json({ ephemeral_text: `❌ Stop failed: ${err}` })
        }
      }

      case 'app_logs': {
        const appId = context.app_id as string
        try {
          const appRecord = db.select().from(apps).where(eq(apps.id, appId)).get()
          if (!appRecord) {
            return c.json({ ephemeral_text: 'App not found.' })
          }
          const repo = db.select().from(repositories).where(eq(repositories.id, appRecord.repositoryId)).get()
          const projectName = getProjectName(appId, repo?.displayName)
          const services = await stackServices(projectName)
          const allLogs: string[] = []
          for (const svc of services) {
            const svcLogs = await serviceLogs(svc.name, 20)
            if (svcLogs) {
              allLogs.push(`=== ${svc.serviceName} ===\n${svcLogs}`)
            }
          }
          const logText = allLogs.join('\n\n')
          return c.json({
            update: {
              props: {
                attachments: [{
                  fallback: 'App Logs',
                  color: '#6B7280',
                  pretext: '#### 📋 App Logs (last 20 lines)',
                  text: `\`\`\`\n${logText.slice(-2000) || 'No logs available'}\n\`\`\``,
                  actions: [
                    {
                      id: 'back',
                      name: '← Back',
                      type: 'button' as const,
                      integration: { url: getActionsUrl(), context: { action: 'app_detail', app_id: appId } },
                    },
                  ],
                }],
              },
            },
          })
        } catch (err) {
          log.messaging.error('Mattermost app_logs error', { appId, error: String(err) })
          return c.json({ ephemeral_text: 'Failed to fetch logs.' })
        }
      }

      case 'rollback_app': {
        const appId = context.app_id as string
        const deploymentId = selectedOptionValue(body)
        if (!deploymentId) {
          return c.json({ ephemeral_text: 'No deployment selected for rollback.' })
        }
        try {
          const result = await rollbackApp(appId, deploymentId)
          if (!result.success) {
            return c.json({ ephemeral_text: `Rollback failed: ${result.error || 'unknown error'}` })
          }
          const card = await buildAppDetailCard(appId)
          return c.json({ update: { props: { attachments: [card] } } })
        } catch (err) {
          return c.json({ ephemeral_text: `Rollback failed: ${err}` })
        }
      }

      case 'create_pr': {
        const taskId = context.task_id as string
        const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get()
        if (!task) return c.json({ ephemeral_text: 'Task not found.' })
        if (task.prUrl) return c.json({ ephemeral_text: `PR already exists: ${task.prUrl}` })
        return c.json({ ephemeral_text: 'Open the task terminal and create the PR from the prepared diff.', update: mattermostUpdate(await buildTaskDiffCard(task.id)) })
      }

      case 'merge_to_main': {
        const taskId = context.task_id as string
        const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get()
        if (!task) return c.json({ ephemeral_text: 'Task not found.' })
        if (!task.prUrl) return c.json({ ephemeral_text: 'No PR URL is linked to this task yet.' })
        return c.json({ ephemeral_text: `Merge gate stays on GitHub: ${task.prUrl}` })
      }

      case 'delete_worktree': {
        const taskId = context.task_id as string
        const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get()
        if (!task) return c.json({ ephemeral_text: 'Task not found.' })
        return c.json({ ephemeral_text: task.worktreePath ? `Delete worktree from Fulcrum after confirming no local changes: ${task.worktreePath}` : 'Task has no worktree.' })
      }

      case 'monitor': {
        const card = await buildMonitorCard()
        return c.json({ update: { props: { attachments: [card] } } })
      }

      case 'kill_agent': {
        const taskId = context.task_id as string
        if (!isConfirmed(context)) {
          return c.json(confirmationResponse('Confirm killing this task agent?', context))
        }
        const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get()
        if (!task) {
          return c.json({ ephemeral_text: 'Task not found.' })
        }
        if (!task.worktreePath) {
          return c.json({ ephemeral_text: 'Task has no worktree path.' })
        }
        const killed = killClaudeInTerminalsForWorktree(task.worktreePath)
        const card = await buildTaskDetailCard(taskId)
        return c.json({
          ephemeral_text: killed > 0 ? `Killed ${killed} agent process${killed === 1 ? '' : 'es'}.` : 'No running agent process found.',
          update: { props: { attachments: [card] } },
        })
      }

      case 'open_configure_settings_dialog': {
        await openConfigureSettingsDialog(triggerId)
        return c.json({})
      }

      case 'open_create_task_dialog': {
        if (!triggerId) {
          return c.json({ ephemeral_text: 'Cannot open create task dialog: missing Mattermost trigger_id.' })
        }
        await openCreateTaskDialog(triggerId, '')
        return c.json({})
      }

      case 'open_link': {
        return c.json({ ephemeral_text: context.url as string })
      }

      default:
        return c.json({ ephemeral_text: `Unknown action: ${action}` })
    }
  } catch (err) {
    log.messaging.error('Mattermost action error', { action, error: String(err) })
    return c.json({ ephemeral_text: `Error: ${err instanceof Error ? err.message : String(err)}` })
  }
})

// --- Dialog Submission Handler ---

app.post('/dialogs', async (c) => {
  const body = await c.req.json<Record<string, unknown>>()
  const token = body.token as string | undefined
  const userId = body.user_id as string | undefined

  const auth = authorizeMattermostRequest(token, userId)
  if (!auth.ok) {
    return c.json({ errors: { '': auth.message } })
  }

  const parsed = parseDialogSubmission(body)
  if (!parsed.ok) return c.json({ errors: parsed.errors })

  try {
    switch (parsed.value.callbackId) {
      case 'create_task': {
        const submission = parsed.value.submission
        const title = submission.title?.trim()
        if (!title) return c.json({ errors: { title: 'Title is required' } })

        const priority = submission.priority || 'medium'
        if (!VALID_PRIORITY.has(priority)) return c.json({ errors: { priority: `Invalid priority: ${priority}` } })

        const selectedType = submission.type || getSettings().tasks.defaultTaskType
        if (!VALID_TASK_TYPE.has(selectedType)) return c.json({ errors: { type: `Invalid type: ${selectedType}` } })

        const dueDate = normalizeDueDate(submission.due_date)
        if (!dueDate.ok) return c.json({ errors: dueDate.errors })

        const taskType = selectedType === 'manual' ? null : selectedType
        const repositoryId = submission.repository_id || null
        const selectedRepo = repositoryId ? db.select().from(repositories).where(eq(repositories.id, repositoryId)).get() : null
        const result = await createTaskRecord({
          title,
          description: submission.description?.trim() || null,
          status: 'TO_DO',
          priority,
          type: taskType,
          projectId: submission.project_id || null,
          repositoryId,
          dueDate: dueDate.value,
          agent: getSettings().agent.defaultAgent || 'claude',
          repoPath: selectedRepo?.path || null,
          repoName: selectedRepo?.displayName || null,
          baseBranch: selectedRepo?.lastBaseBranch || null,
          startedAt: new Date().toISOString(),
          tags: parseMattermostTags(submission.tags),
        })

        if ('error' in result) {
          return c.json({ errors: { '': result.error } })
        }

        const card = await buildTaskDetailCard(result.taskId)
        await postMessage({
          channel_id: parsed.value.channelId || getSettings().channels.mattermost.channelId,
          props: { attachments: [card] },
        })

        return c.json(null)
      }

      case 'configure_settings': {
        const submission = parsed.value.submission
        const serverUrl = submission.server_url?.trim()
        const teamId = submission.team_id?.trim()
        const channelId = submission.channel_id?.trim()
        if (!serverUrl) return c.json({ errors: { server_url: 'Server URL is required' } })
        if (!teamId) return c.json({ errors: { team_id: 'Team ID is required' } })
        if (!channelId) return c.json({ errors: { channel_id: 'Default Channel ID is required' } })

        updateSettingByPath('channels.mattermost.serverUrl', serverUrl)
        updateSettingByPath('channels.mattermost.teamId', teamId)
        updateSettingByPath('channels.mattermost.channelId', channelId)
        updateSettingByPath('channels.mattermost.enabled', true)
        if (submission.bot_token?.trim()) updateSettingByPath('channels.mattermost.botToken', submission.bot_token.trim())
        if (submission.command_token?.trim()) updateSettingByPath('channels.mattermost.commandToken', submission.command_token.trim())

        return c.json(null)
      }
    }
  } catch (err) {
    log.messaging.error('Mattermost dialog error', { callbackId: parsed.value.callbackId, error: String(err) })
    return c.json({ errors: { '': `Error: ${err instanceof Error ? err.message : String(err)}` } })
  }
})

export default app
