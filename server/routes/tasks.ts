import { Hono } from 'hono'
import { nanoid } from 'nanoid'
import { db, tasks, repositories, taskLinks, taskRelationships, taskAttachments, tags, taskTags, draftItems, hosts, type Task, type NewTask, type TaskLink } from '../db'
import { eq, asc, and, or, inArray } from 'drizzle-orm'
import { detectLinkType } from '../lib/link-utils'
import { execSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { getFulcrumDir, getScratchBasePath, getWorktreeBasePath } from '../lib/settings'
import {
  getPTYManager,
  destroyTerminalAndBroadcast,
  killClaudeInTerminalsForWorktree,
} from '../terminal/pty-instance'
import { broadcast } from '../websocket/terminal-ws'
import { updateTaskStatus } from '../services/task-status'
import { reindexTaskFTS } from '../services/search-service'
import { log } from '../lib/logger'
import { createGitWorktree, createRemoteGitWorktree, copyFilesToWorktree, pullLatestInWorktree, checkRepoStateForWorktree } from '../lib/git-utils'
import { isValidBranchName } from '../lib/shell-escape'
import { getRuntimeConfig } from '../lib/runtime-config'

// Helper to delete git worktree
function deleteGitWorktree(repoPath: string, worktreePath: string): void {
  if (!fs.existsSync(worktreePath)) return

  try {
    execSync(`git worktree remove "${worktreePath}" --force`, {
      cwd: repoPath,
      encoding: 'utf-8',
    })
  } catch {
    // If git worktree remove fails, manually remove and prune
    fs.rmSync(worktreePath, { recursive: true, force: true })
    try {
      execSync('git worktree prune', { cwd: repoPath, encoding: 'utf-8' })
    } catch {
      // Ignore prune errors
    }
  }
}

// Helper to destroy terminals associated with a worktree path
function destroyTerminalsForWorktree(worktreePath: string): void {
  try {
    const ptyManager = getPTYManager()
    const terminals = ptyManager.listTerminals()
    for (const terminal of terminals) {
      if (terminal.cwd === worktreePath) {
        destroyTerminalAndBroadcast(terminal.id)
      }
    }
  } catch {
    // PTY manager might not be initialized yet, ignore
  }
}

// MIME types we'll render inline via ?inline=1. Everything else is forced to
// download regardless of the query param, so an uploaded HTML/SVG can't execute
// in the app's origin.
const INLINE_SAFE_MIME_TYPES = new Set([
  'application/pdf',
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'text/plain', 'text/markdown',
])

// Max file size: 50MB
const MAX_FILE_SIZE = 50 * 1024 * 1024

// Get the uploads directory for a task
function getTaskUploadsDir(taskId: string): string {
  return path.join(getFulcrumDir(), 'uploads', 'tasks', taskId)
}

// Sanitize filename for storage
function sanitizeFilename(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]/g, '_')
}

// Delete all attachments for a task (files and DB records)
function deleteTaskAttachments(taskId: string): void {
  // Delete from DB
  db.delete(taskAttachments).where(eq(taskAttachments.taskId, taskId)).run()

  // Delete the upload directory
  const uploadDir = getTaskUploadsDir(taskId)
  if (fs.existsSync(uploadDir)) {
    fs.rmSync(uploadDir, { recursive: true, force: true })
  }
}

const app = new Hono()

function generateWorktreeInfo(repoPath: string, taskTitle: string, prefix?: string | null): { worktreePath: string; branch: string } {
  const worktreesDir = getWorktreeBasePath()
  const slugifiedTitle = taskTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50)
  const suffix = Math.random().toString(36).slice(2, 6)
  const cleanPrefix = prefix?.replace(/\/+$/, '')
  const branch = cleanPrefix ? `${cleanPrefix}/${slugifiedTitle}-${suffix}` : `${slugifiedTitle}-${suffix}`
  const worktreeName = branch
  const repoName = path.basename(repoPath)
  const worktreePath = path.join(worktreesDir, repoName, worktreeName)
  return { worktreePath, branch }
}

export async function createTaskRecord(body: Omit<NewTask, 'id' | 'createdAt' | 'updatedAt'> & {
  copyFiles?: string
  startupScript?: string
  agent?: string
  agentOptions?: Record<string, string> | null
  opencodeModel?: string | null
  tags?: string[]
  blockedByTaskIds?: string[]
  derivedFromTaskId?: string | null
  type?: 'worktree' | 'scratch' | 'draft' | null
  prefix?: string | null
  hostId?: string | null
  pullToLatest?: boolean
  pullRemoteBranch?: string | null
}): { taskId: string; warnings: string[]; derivation: { parentBlocked: boolean; propagatedTo: string[]; guidance?: string } } | { error: string; status?: number } {
  const existingTasks = db
    .select()
    .from(tasks)
    .where(eq(tasks.status, body.status || 'IN_PROGRESS'))
    .all()
  const maxPosition = existingTasks.reduce((max, t) => Math.max(max, t.position), -1)

  const now = new Date().toISOString()
  const startedAt = body.status === 'TO_DO' ? null : (body.startedAt || now)
  const worktreeInfo = body.repoPath && body.worktreePath === undefined && body.type === 'worktree'
    ? generateWorktreeInfo(body.repoPath, body.title, body.prefix)
    : null

  if (getRuntimeConfig().remoteOnly && !body.hostId) {
    return { error: 'remote-only mode requires hostId', status: 400 }
  }

  const newTask: NewTask = {
    id: crypto.randomUUID(),
    title: body.title,
    description: body.description || null,
    status: body.status || 'IN_PROGRESS',
    position: maxPosition + 1,
    repoPath: body.repoPath || null,
    repoName: body.repoName || null,
    baseBranch: body.baseBranch || null,
    branch: body.branch || worktreeInfo?.branch || null,
    prefix: body.prefix || null,
    worktreePath: body.worktreePath || worktreeInfo?.worktreePath || null,
    startupScript: body.startupScript || null,
    agent: body.agent || 'claude',
    aiMode: body.aiMode || null,
    agentOptions: body.agentOptions ? JSON.stringify(body.agentOptions) : null,
    opencodeModel: body.opencodeModel || null,
    type: body.type || null,
    derivedFromTaskId: body.derivedFromTaskId || null,
    projectId: body.projectId || null,
    repositoryId: body.repositoryId || null,
    startedAt,
    dueDate: body.dueDate || null,
    timeEstimate: body.timeEstimate != null ? (Number.isInteger(body.timeEstimate) && body.timeEstimate >= 1 ? body.timeEstimate : null) : null,
    priority: body.priority && ['high', 'medium', 'low'].includes(body.priority) ? body.priority : 'medium',
    recurrenceRule: body.recurrenceRule || null,
    recurrenceEndDate: body.recurrenceEndDate || null,
    recurrenceSourceTaskId: null,
    hostId: body.hostId || null,
    pinned: body.pinned ?? false,
    createdAt: now,
    updatedAt: now,
  }

  const warnings: string[] = []

  if (body.derivedFromTaskId) {
    const parentTask = db.select().from(tasks).where(eq(tasks.id, body.derivedFromTaskId)).get()
    if (!parentTask) {
      return { error: 'Parent task not found for derivation', status: 400 }
    }
    if (parentTask.status === 'DONE') {
      return { error: 'Cannot derive from a DONE task', status: 400 }
    }
    if (parentTask.status === 'CANCELED') {
      return { error: 'Cannot derive from a CANCELED task', status: 400 }
    }
  }

  if (newTask.branch && newTask.worktreePath && newTask.repoPath && newTask.baseBranch) {
    if (!isValidBranchName(newTask.branch)) {
      return { error: 'Invalid branch name: only alphanumeric, /, _, -, . characters allowed', status: 400 }
    }

    if (body.pullToLatest && !body.hostId) {
      const repoState = checkRepoStateForWorktree(newTask.repoPath, newTask.baseBranch, body.pullRemoteBranch || undefined)
      warnings.push(...repoState.warnings)
      if (repoState.skipPull) {
        return { error: repoState.warnings.find(w => w.includes('Pull skipped')) || 'Cannot pull: base branch has unpushed commits', status: 400 }
      }
    }

    if (body.hostId) {
      const host = db.select().from(hosts).where(eq(hosts.id, body.hostId)).get()
      if (!host) {
        return { error: `Host not found: ${body.hostId}`, status: 400 }
      }
      const sshConfig = {
        host: host.hostname,
        port: host.port,
        username: host.username,
        authMethod: host.authMethod as 'key' | 'password',
        privateKeyPath: host.privateKeyPath ?? undefined,
        password: host.password ?? undefined,
        hostFingerprint: host.hostFingerprint ?? undefined,
      }
      const result = await createRemoteGitWorktree(sshConfig, newTask.repoPath, newTask.worktreePath, newTask.branch, newTask.baseBranch)
      if (!result.success) {
        return { error: `Failed to create remote worktree: ${result.error}`, status: 500 }
      }
      if (body.copyFiles) log.api.info('copyFiles skipped for remote task (not yet supported)', { taskId: newTask.id })
      if (body.pullToLatest) log.api.info('pullToLatest skipped for remote task (not yet supported)', { taskId: newTask.id })
    } else {
      const result = createGitWorktree(newTask.repoPath, newTask.worktreePath, newTask.branch, newTask.baseBranch)
      if (!result.success) {
        return { error: `Failed to create worktree: ${result.error}`, status: 500 }
      }
      if (body.pullToLatest) {
        const pullResult = pullLatestInWorktree(newTask.worktreePath, body.pullRemoteBranch || undefined)
        if (!pullResult.success) {
          log.api.error('Failed to pull latest in worktree', { error: pullResult.error })
          warnings.push(`Pull failed: ${pullResult.error}`)
        }
      }
      if (body.copyFiles) {
        try {
          copyFilesToWorktree(newTask.repoPath, newTask.worktreePath, body.copyFiles)
        } catch (err) {
          log.api.error('Failed to copy files', { error: String(err) })
        }
      }
    }
  }

  if (body.type === 'scratch' && newTask.worktreePath) {
    try {
      fs.mkdirSync(newTask.worktreePath, { recursive: true })
    } catch (err) {
      return { error: `Failed to create scratch directory: ${err instanceof Error ? err.message : String(err)}`, status: 500 }
    }
  }

  const derivationResult: { parentBlocked: boolean; propagatedTo: string[]; guidance?: string } = { parentBlocked: false, propagatedTo: [] }
  const affectedTaskIds: string[] = []

  try {
    db.transaction(() => {
      db.insert(tasks).values(newTask).run()

      if (body.tags && body.tags.length > 0) {
        for (const tagName of body.tags) {
          const name = tagName.trim().toLowerCase()
          if (!name) continue

          let tag = db.select().from(tags).where(eq(tags.name, name)).get()
          if (!tag) {
            const tagId = crypto.randomUUID()
            db.insert(tags)
              .values({ id: tagId, name, color: null, createdAt: now })
              .run()
            tag = db.select().from(tags).where(eq(tags.id, tagId)).get()
          }

          if (tag) {
            const existing = db
              .select()
              .from(taskTags)
              .where(and(eq(taskTags.taskId, newTask.id), eq(taskTags.tagId, tag.id)))
              .get()
            if (!existing) {
              db.insert(taskTags)
                .values({ id: crypto.randomUUID(), taskId: newTask.id, tagId: tag.id, createdAt: now })
                .run()
            }
          }
        }
      }

      if (body.blockedByTaskIds && body.blockedByTaskIds.length > 0) {
        const uniqueIds = [...new Set(body.blockedByTaskIds)].filter((id) => id !== newTask.id)
        for (const dependsOnTaskId of uniqueIds) {
          const targetTask = db.select().from(tasks).where(eq(tasks.id, dependsOnTaskId)).get()
          if (!targetTask) continue

          db.insert(taskRelationships)
            .values({
              id: crypto.randomUUID(),
              taskId: newTask.id,
              relatedTaskId: dependsOnTaskId,
              type: 'depends_on',
              createdAt: now,
            })
            .run()
        }
      }

      if (body.derivedFromTaskId) {
        db.insert(taskRelationships)
          .values({
            id: crypto.randomUUID(),
            taskId: body.derivedFromTaskId,
            relatedTaskId: newTask.id,
            type: 'depends_on',
            source: 'derivation',
            createdAt: now,
          })
          .run()
        derivationResult.parentBlocked = true
        derivationResult.guidance = `Your current task is now blocked by the derived task you just created. Stop working on the current task until the derived task "${body.title}" is completed.`
        affectedTaskIds.push(body.derivedFromTaskId)

        const dependentsOfParent = db
          .select()
          .from(taskRelationships)
          .where(
            and(
              eq(taskRelationships.relatedTaskId, body.derivedFromTaskId),
              eq(taskRelationships.type, 'depends_on')
            )
          )
          .all()
          .filter((dep) => dep.taskId !== newTask.id)

        const existingDeps = dependentsOfParent.length > 0
          ? db.select()
              .from(taskRelationships)
              .where(
                and(
                  inArray(taskRelationships.taskId, dependentsOfParent.map((d) => d.taskId)),
                  eq(taskRelationships.relatedTaskId, newTask.id),
                  eq(taskRelationships.type, 'depends_on')
                )
              )
              .all()
          : []
        const existingDepTaskIds = new Set(existingDeps.map((d) => d.taskId))

        for (const dep of dependentsOfParent) {
          if (existingDepTaskIds.has(dep.taskId)) continue

          db.insert(taskRelationships)
            .values({
              id: crypto.randomUUID(),
              taskId: dep.taskId,
              relatedTaskId: newTask.id,
              type: 'depends_on',
              source: 'derivation',
              createdAt: now,
            })
            .run()
          affectedTaskIds.push(dep.taskId)
          derivationResult.propagatedTo.push(dep.taskId)
        }
      }

      const allRels = db.select().from(taskRelationships).where(eq(taskRelationships.type, 'depends_on')).all()
      const adj = new Map<string, string[]>()
      for (const rel of allRels) {
        if (!adj.has(rel.taskId)) adj.set(rel.taskId, [])
        adj.get(rel.taskId)!.push(rel.relatedTaskId)
      }
      const visited = new Set<string>()
      const stack = [newTask.id]
      while (stack.length > 0) {
        const current = stack.pop()!
        if (current === newTask.id && visited.size > 0) {
          throw new Error('Circular dependency detected')
        }
        if (visited.has(current)) continue
        visited.add(current)
        for (const neighbor of adj.get(current) ?? []) {
          stack.push(neighbor)
        }
      }
    })
  } catch (txErr) {
    if (newTask.worktreePath) {
      try {
        if (newTask.repoPath) {
          deleteGitWorktree(newTask.repoPath, newTask.worktreePath)
        } else if (newTask.type === 'scratch') {
          fs.rmSync(newTask.worktreePath, { recursive: true, force: true })
        }
      } catch { /* best-effort cleanup */ }
    }
    return { error: txErr instanceof Error ? txErr.message : 'Failed to create task', status: 400 }
  }

  for (const taskId of affectedTaskIds) {
    broadcast({ type: 'task:updated', payload: { taskId } })
  }
  if (body.derivedFromTaskId) {
    broadcast({ type: 'task:updated', payload: { taskId: newTask.id } })
  }

  if (body.repoPath) {
    db.update(repositories)
      .set({ lastUsedAt: now, lastBaseBranch: body.baseBranch || null, updatedAt: now })
      .where(eq(repositories.path, body.repoPath))
      .run()
  } else if (body.repositoryId && body.baseBranch) {
    db.update(repositories)
      .set({ lastUsedAt: now, lastBaseBranch: body.baseBranch, updatedAt: now })
      .where(eq(repositories.id, body.repositoryId))
      .run()
  }

  return { taskId: newTask.id, warnings, derivation: derivationResult }
}


// Helper to get links for a task
function getTaskLinks(taskId: string): TaskLink[] {
  return db.select().from(taskLinks).where(eq(taskLinks.taskId, taskId)).all()
}

// Helper to get tags for a task from join table
function getTaskTags(taskId: string): string[] {
  const joins = db
    .select()
    .from(taskTags)
    .where(eq(taskTags.taskId, taskId))
    .all()

  if (joins.length === 0) {
    return []
  }

  const tagIds = joins.map((j) => j.tagId)
  const tagRows = db
    .select()
    .from(tags)
    .where(inArray(tags.id, tagIds))
    .all()
  return tagRows.map((t) => t.name)
}

// Helper to parse JSON fields from database
function toApiResponse(
  task: Task,
  includeLinks = false
): Task & { viewState: unknown; agentOptions: Record<string, string> | null; tags: string[]; links?: TaskLink[] } {
  const response: Task & { viewState: unknown; agentOptions: Record<string, string> | null; tags: string[]; links?: TaskLink[] } = {
    ...task,
    viewState: task.viewState ? JSON.parse(task.viewState) : null,
    agentOptions: task.agentOptions ? JSON.parse(task.agentOptions) : null,
    tags: getTaskTags(task.id),
  }
  if (includeLinks) {
    response.links = getTaskLinks(task.id)
  }
  return response
}

// GET /api/tasks - List all tasks (optionally filter by projectId or orphans)
app.get('/', (c) => {
  const projectId = c.req.query('projectId')
  const orphans = c.req.query('orphans') === 'true'
  const tag = c.req.query('tag')
  const status = c.req.query('status')

  const query = db.select().from(tasks).orderBy(asc(tasks.position))

  let allTasks = query.all()

  // Filter by status (supports comma-separated values e.g. "IN_PROGRESS,TO_DO")
  if (status) {
    const statuses = status.split(',')
    allTasks = allTasks.filter((t) => statuses.includes(t.status))
  }

  // Apply filters in memory (for simplicity with nullable fields)
  if (projectId) {
    allTasks = allTasks.filter((t) => t.projectId === projectId)
  } else if (orphans) {
    allTasks = allTasks.filter((t) => t.projectId === null)
  }

  // Filter by tag if specified
  if (tag) {
    allTasks = allTasks.filter((t) => {
      const taskTags = getTaskTags(t.id)
      return taskTags.includes(tag)
    })
  }

  return c.json(allTasks.map((t) => toApiResponse(t, true)))
})

// POST /api/tasks - Create task
app.post('/', async (c) => {
  try {
    const body = await c.req.json<
      Omit<NewTask, 'id' | 'createdAt' | 'updatedAt'> & {
        copyFiles?: string
        startupScript?: string
        agent?: string
        agentOptions?: Record<string, string> | null
        opencodeModel?: string | null
        tags?: string[]
        blockedByTaskIds?: string[]
        derivedFromTaskId?: string | null
        type?: 'worktree' | 'scratch' | 'draft' | null
        prefix?: string | null
        hostId?: string | null
        pullToLatest?: boolean
        pullRemoteBranch?: string | null
      }
    >()

    const result = await createTaskRecord(body)
    if ('error' in result) {
      return c.json({ error: result.error }, result.status || 400)
    }

    const created = db.select().from(tasks).where(eq(tasks.id, result.taskId)).get()
    broadcast({ type: 'task:updated', payload: { taskId: result.taskId } })
    const response = created ? toApiResponse(created, true) : null
    if (response && body.derivedFromTaskId && result.derivation.parentBlocked) {
      ;(response as Record<string, unknown>)._derivationResult = result.derivation
    }
    if (response && result.warnings.length > 0) {
      ;(response as Record<string, unknown>)._warnings = result.warnings
    }
    return c.json(response, 201)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to create task' }, 400)
  }
})

// DELETE /api/tasks/bulk - Delete multiple tasks (must be before /:id route)
app.delete('/bulk', async (c) => {
  try {
    const body = await c.req.json<{ ids: string[]; deleteLinkedWorktrees?: boolean }>()

    if (!Array.isArray(body.ids) || body.ids.length === 0) {
      return c.json({ error: 'ids must be a non-empty array' }, 400)
    }

    const now = new Date().toISOString()
    let deletedCount = 0

    for (const id of body.ids) {
      const existing = db.select().from(tasks).where(eq(tasks.id, id)).get()
      if (!existing) continue

      // Handle linked worktree/directory based on deleteLinkedWorktrees flag
      if (existing.worktreePath) {
        // Always destroy terminals for the worktree/scratch dir
        destroyTerminalsForWorktree(existing.worktreePath)

        // Only delete the worktree/directory if flag is true
        if (body.deleteLinkedWorktrees) {
          if (existing.repoPath) {
            deleteGitWorktree(existing.repoPath, existing.worktreePath)
          } else if (existing.type === 'scratch') {
            try {
              fs.rmSync(existing.worktreePath, { recursive: true, force: true })
            } catch (err) {
              log.api.error('Failed to delete scratch directory', { path: existing.worktreePath, error: String(err) })
            }
          }
        }
      }

      // Shift down tasks in the same column that were after this task
      const columnTasks = db.select().from(tasks).where(eq(tasks.status, existing.status)).all()

      for (const t of columnTasks) {
        if (t.position > existing.position) {
          db.update(tasks)
            .set({ position: t.position - 1, updatedAt: now })
            .where(eq(tasks.id, t.id))
            .run()
        }
      }

      // Delete associated links
      db.delete(taskLinks).where(eq(taskLinks.taskId, id)).run()

      // Delete associated attachments (files and DB records)
      deleteTaskAttachments(id)

      // Delete associated draft items
      db.delete(draftItems).where(eq(draftItems.taskId, id)).run()

      // Delete associated task relationships (dependencies)
      db.delete(taskRelationships).where(
        or(eq(taskRelationships.taskId, id), eq(taskRelationships.relatedTaskId, id))
      ).run()

      db.delete(tasks).where(eq(tasks.id, id)).run()
      broadcast({ type: 'task:updated', payload: { taskId: id } })
      deletedCount++
    }

    return c.json({ success: true, deleted: deletedCount })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to delete tasks' }, 400)
  }
})

// GET /api/tasks/:id - Get single task
app.get('/:id', (c) => {
  const id = c.req.param('id')
  const task = db.select().from(tasks).where(eq(tasks.id, id)).get()
  if (!task) {
    return c.json({ error: 'Task not found' }, 404)
  }
  return c.json(toApiResponse(task, true))
})

// POST /api/tasks/:id/initialize-worktree - Initialize a manual task as a worktree task
app.post('/:id/initialize-worktree', async (c) => {
  const id = c.req.param('id')

  try {
    const existing = db.select().from(tasks).where(eq(tasks.id, id)).get()
    if (!existing) {
      return c.json({ error: 'Task not found' }, 404)
    }

    // Check if task already has worktree context
    if (existing.worktreePath) {
      return c.json({ error: 'Task already has worktree context' }, 400)
    }

    const body = await c.req.json<{
      agent?: string
      aiMode?: 'default' | 'plan'
      repoPath: string
      repoName: string
      baseBranch: string
      branch: string
      worktreePath: string
      copyFiles?: string
      startupScript?: string
      agentOptions?: Record<string, string> | null
      opencodeModel?: string | null
      prefix?: string | null
      pullToLatest?: boolean
      pullRemoteBranch?: string | null
    }>()

    if (!body.repoPath || !body.branch || !body.worktreePath || !body.baseBranch) {
      return c.json({ error: 'repoPath, branch, worktreePath, and baseBranch are required' }, 400)
    }

    // Server-side check: block pull if base branch has unpushed commits
    const warnings: string[] = []
    if (body.pullToLatest) {
      const repoState = checkRepoStateForWorktree(body.repoPath, body.baseBranch, body.pullRemoteBranch || undefined)
      warnings.push(...repoState.warnings)
      if (repoState.skipPull) {
        return c.json({ error: repoState.warnings.find(w => w.includes('Pull skipped')) || 'Cannot pull: base branch has unpushed commits. Push first or disable Pull to Latest.' }, 400)
      }
    }

    // Create git worktree
    const result = createGitWorktree(body.repoPath, body.worktreePath, body.branch, body.baseBranch)
    if (!result.success) {
      return c.json({ error: `Failed to create worktree: ${result.error}` }, 500)
    }

    // Pull latest from remote if requested
    if (body.pullToLatest) {
      const pullResult = pullLatestInWorktree(body.worktreePath, body.pullRemoteBranch || undefined)
      if (!pullResult.success) {
        log.api.error('Failed to pull latest during worktree initialization', { error: pullResult.error })
        warnings.push(`Pull failed: ${pullResult.error}`)
      }
    }

    // Copy files if patterns provided
    if (body.copyFiles) {
      try {
        copyFilesToWorktree(body.repoPath, body.worktreePath, body.copyFiles)
      } catch (err) {
        log.api.error('Failed to copy files during worktree initialization', { error: String(err) })
        // Non-fatal: continue with task update
      }
    }

    const now = new Date().toISOString()

    // Update the task with worktree fields and change status to IN_PROGRESS
    db.update(tasks)
      .set({
        agent: body.agent || 'claude',
        aiMode: body.aiMode || null,
        repoPath: body.repoPath,
        repoName: body.repoName,
        baseBranch: body.baseBranch,
        branch: body.branch,
        prefix: body.prefix || null,
        worktreePath: body.worktreePath,
        startupScript: body.startupScript || null,
        agentOptions: body.agentOptions ? JSON.stringify(body.agentOptions) : null,
        opencodeModel: body.opencodeModel || null,
        status: 'IN_PROGRESS',
        startedAt: now,
        updatedAt: now,
      })
      .where(eq(tasks.id, id))
      .run()

    // Update lastUsedAt and lastBaseBranch for the repository
    db.update(repositories)
      .set({ lastUsedAt: now, lastBaseBranch: body.baseBranch || null, updatedAt: now })
      .where(eq(repositories.path, body.repoPath))
      .run()

    const updated = db.select().from(tasks).where(eq(tasks.id, id)).get()
    broadcast({ type: 'task:updated', payload: { taskId: id } })
    const response = updated ? toApiResponse(updated, true) : null
    return c.json(warnings.length > 0 ? { ...response, _warnings: warnings } : response)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to initialize worktree task' }, 400)
  }
})

// POST /api/tasks/:id/initialize-scratch - Initialize a manual task as a scratch task
app.post('/:id/initialize-scratch', async (c) => {
  const id = c.req.param('id')

  try {
    const existing = db.select().from(tasks).where(eq(tasks.id, id)).get()
    if (!existing) {
      return c.json({ error: 'Task not found' }, 404)
    }

    if (existing.worktreePath) {
      return c.json({ error: 'Task already has a directory' }, 400)
    }

    const body = await c.req.json<{
      agent?: string
      aiMode?: 'default' | 'plan'
    }>().catch(() => ({} as { agent?: string; aiMode?: 'default' | 'plan' }))

    // Generate scratch directory path
    const scratchBase = getScratchBasePath()
    const slugifiedTitle = existing.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50)
    const suffix = Math.random().toString(36).slice(2, 6)
    const dirName = slugifiedTitle ? `${slugifiedTitle}-${suffix}` : suffix
    const dirPath = path.join(scratchBase, dirName)

    // Create scratch directory
    try {
      fs.mkdirSync(dirPath, { recursive: true })
    } catch (err) {
      return c.json({ error: `Failed to create scratch directory: ${err instanceof Error ? err.message : String(err)}` }, 500)
    }

    const now = new Date().toISOString()

    db.update(tasks)
      .set({
        type: 'scratch',
        worktreePath: dirPath,
        agent: body.agent || existing.agent || 'claude',
        aiMode: body.aiMode || null,
        status: 'IN_PROGRESS',
        startedAt: now,
        updatedAt: now,
      })
      .where(eq(tasks.id, id))
      .run()

    const updated = db.select().from(tasks).where(eq(tasks.id, id)).get()
    broadcast({ type: 'task:updated', payload: { taskId: id } })
    return c.json(updated ? toApiResponse(updated, true) : null)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to initialize scratch task' }, 400)
  }
})

// PATCH /api/tasks/:id - Update task
// Build update data from PATCH body using a field→transform map
const TASK_PATCH_FIELDS: Record<string, (v: unknown) => unknown> = {
  title: (v) => v,
  description: (v) => v,
  notes: (v) => v,
  prUrl: (v) => v,
  dueDate: (v) => v,
  priority: (v) => v,
  pinned: (v) => v,
  recurrenceRule: (v) => v,
  recurrenceEndDate: (v) => v,
  projectId: (v) => v,
  repositoryId: (v) => v,
  agent: (v) => v,
  aiMode: (v) => v,
  opencodeModel: (v) => v,
  startupScript: (v) => v,
  type: (v) => v,
  startedAt: (v) => v,
  repoPath: (v) => v,
  repoName: (v) => v,
  baseBranch: (v) => v,
  branch: (v) => v,
  prefix: (v) => v,
  worktreePath: (v) => v,
  hostId: (v) => v,
  timeEstimate: (v) => v != null ? (Number.isInteger(Number(v)) && Number(v) >= 1 ? Number(v) : null) : null,
  viewState: (v) => v ? JSON.stringify(v) : null,
  agentOptions: (v) => v ? JSON.stringify(v) : null,
}

function buildTaskUpdateData(body: Record<string, unknown>, now: string): Record<string, unknown> {
  const updateData: Record<string, unknown> = { updatedAt: now }
  for (const [field, transform] of Object.entries(TASK_PATCH_FIELDS)) {
    if (body[field] !== undefined) {
      updateData[field] = transform(body[field])
    }
  }
  return updateData
}

app.patch('/:id', async (c) => {
  const id = c.req.param('id')

  try {
    const existing = db.select().from(tasks).where(eq(tasks.id, id)).get()
    if (!existing) {
      return c.json({ error: 'Task not found' }, 404)
    }

    const body = await c.req.json<Partial<Task> & { viewState?: unknown }>()
    const now = new Date().toISOString()

    if (getRuntimeConfig().remoteOnly && body.hostId === null) {
      return c.json({ error: 'remote-only mode requires hostId' }, 400)
    }

    // hostId reassignment rules:
    //   - only worktree / scratch tasks have an execution host (manual / draft
    //     have no agent, no filesystem to point at)
    //   - once worktreePath is set the worktree lives on a specific host's
    //     filesystem and cannot be moved without recreating it
    // Both rules are also enforced in the UI (TaskDetailsPanel only mounts the
    // selector for worktree/scratch + !worktreePath), but we re-check here so
    // direct API access stays in sync with what the UI exposes.
    if (body.hostId !== undefined && body.hostId !== existing.hostId) {
      if (existing.worktreePath) {
        return c.json({ error: 'Cannot change host on an initialized worktree task. Delete the worktree first.' }, 400)
      }
      if (existing.type !== 'worktree' && existing.type !== 'scratch') {
        return c.json({ error: 'Host can only be set on worktree or scratch tasks.' }, 400)
      }
      // Verify the target host exists. Without this a typo'd id silently writes
      // through and worktree init crashes later when joining hosts. POST does
      // the same check (line 261) — PATCH must too.
      if (body.hostId !== null) {
        const host = db.select().from(hosts).where(eq(hosts.id, body.hostId)).get()
        if (!host) {
          return c.json({ error: `Host not found: ${body.hostId}` }, 400)
        }
      }
    }

    // Handle status change via centralized function
    if (body.status && body.status !== existing.status) {
      await updateTaskStatus(id, body.status)
    }

    // Build whitelisted update data (excludes status, tags, and unknown fields)
    const updates = buildTaskUpdateData(body as Record<string, unknown>, now)

    // Handle tags via join table
    const tagsToUpdate = (body as { tags?: string[] }).tags

    // Only do additional db update if there are fields beyond updatedAt
    if (Object.keys(updates).length > 1) {
      db.update(tasks)
        .set(updates)
        .where(eq(tasks.id, id))
        .run()
      broadcast({ type: 'task:updated', payload: { taskId: id } })
    }

    // Update tags via join table if provided
    if (tagsToUpdate !== undefined) {
      // Clear existing tags
      db.delete(taskTags).where(eq(taskTags.taskId, id)).run()

      // Add new tags
      if (tagsToUpdate && tagsToUpdate.length > 0) {
        for (const tagName of tagsToUpdate) {
          const name = tagName.trim().toLowerCase()
          if (!name) continue

          // Get or create tag
          let tag = db.select().from(tags).where(eq(tags.name, name)).get()
          if (!tag) {
            const tagId = crypto.randomUUID()
            db.insert(tags)
              .values({ id: tagId, name, color: null, createdAt: now })
              .run()
            tag = db.select().from(tags).where(eq(tags.id, tagId)).get()
          }

          if (tag) {
            db.insert(taskTags)
              .values({ id: crypto.randomUUID(), taskId: id, tagId: tag.id, createdAt: now })
              .run()
          }
        }
      }
      broadcast({ type: 'task:updated', payload: { taskId: id } })
    }

    const updated = db.select().from(tasks).where(eq(tasks.id, id)).get()
    return c.json(updated ? toApiResponse(updated, true) : null)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to update task' }, 400)
  }
})

// DELETE /api/tasks/:id - Delete task (optionally delete linked worktree)
app.delete('/:id', (c) => {
  const id = c.req.param('id')
  const deleteLinkedWorktree = c.req.query('deleteLinkedWorktree') === 'true'

  const existing = db.select().from(tasks).where(eq(tasks.id, id)).get()
  if (!existing) {
    return c.json({ error: 'Task not found' }, 404)
  }

  // Handle linked worktree/directory based on deleteLinkedWorktree flag
  if (existing.worktreePath) {
    // Always destroy terminals for the worktree/scratch dir
    destroyTerminalsForWorktree(existing.worktreePath)

    if (deleteLinkedWorktree) {
      if (existing.repoPath) {
        // Git worktree: use git worktree remove
        deleteGitWorktree(existing.repoPath, existing.worktreePath)
      } else if (existing.type === 'scratch') {
        // Standalone directory: simple fs remove
        try {
          fs.rmSync(existing.worktreePath, { recursive: true, force: true })
        } catch (err) {
          log.api.error('Failed to delete scratch directory', { path: existing.worktreePath, error: String(err) })
        }
      }
    }
  }

  // Shift down tasks in the same column that were after this task
  const columnTasks = db.select().from(tasks).where(eq(tasks.status, existing.status)).all()
  const now = new Date().toISOString()

  for (const t of columnTasks) {
    if (t.position > existing.position) {
      db.update(tasks)
        .set({ position: t.position - 1, updatedAt: now })
        .where(eq(tasks.id, t.id))
        .run()
    }
  }

  // Delete associated links
  db.delete(taskLinks).where(eq(taskLinks.taskId, id)).run()

  // Delete associated attachments (files and DB records)
  deleteTaskAttachments(id)

  // Delete associated draft items
  db.delete(draftItems).where(eq(draftItems.taskId, id)).run()

  // Delete associated task relationships (dependencies)
  db.delete(taskRelationships).where(
    or(eq(taskRelationships.taskId, id), eq(taskRelationships.relatedTaskId, id))
  ).run()

  // Cascade-unset derivedFromTaskId on any task that pointed at this one as parent.
  // Reviewer note (#58): the schema field has no FK + no onDelete, so without this
  // children would silently keep a dangling parent id and DerivedFromBadge would
  // resolve to undefined. Equivalent to onDelete: 'set null'.
  db.update(tasks)
    .set({ derivedFromTaskId: null, updatedAt: now })
    .where(eq(tasks.derivedFromTaskId, id))
    .run()

  db.delete(tasks).where(eq(tasks.id, id)).run()
  broadcast({ type: 'task:updated', payload: { taskId: id } })
  return c.json({ success: true })
})

// PATCH /api/tasks/:id/status - Update task status with position reordering
app.patch('/:id/status', async (c) => {
  const id = c.req.param('id')

  try {
    const existing = db.select().from(tasks).where(eq(tasks.id, id)).get()
    if (!existing) {
      return c.json({ error: 'Task not found' }, 404)
    }

    const body = await c.req.json<{ status: string; position: number }>()
    const now = new Date().toISOString()

    // If status changed or position changed, we need to reorder
    const oldStatus = existing.status
    const newStatus = body.status
    const newPosition = body.position

    if (oldStatus !== newStatus) {
      // Moving to a different column
      // Shift down tasks in old column that were after this task
      const oldColumnTasks = db.select().from(tasks).where(eq(tasks.status, oldStatus)).all()
      for (const t of oldColumnTasks) {
        if (t.position > existing.position) {
          db.update(tasks)
            .set({ position: t.position - 1, updatedAt: now })
            .where(eq(tasks.id, t.id))
            .run()
        }
      }

      // Shift up tasks in new column to make room
      const newColumnTasks = db.select().from(tasks).where(eq(tasks.status, newStatus)).all()
      for (const t of newColumnTasks) {
        if (t.position >= newPosition) {
          db.update(tasks)
            .set({ position: t.position + 1, updatedAt: now })
            .where(eq(tasks.id, t.id))
            .run()
        }
      }
    } else {
      // Same column, just reorder
      const columnTasks = db.select().from(tasks).where(eq(tasks.status, oldStatus)).all()

      if (newPosition > existing.position) {
        // Moving down
        for (const t of columnTasks) {
          if (t.id !== id && t.position > existing.position && t.position <= newPosition) {
            db.update(tasks)
              .set({ position: t.position - 1, updatedAt: now })
              .where(eq(tasks.id, t.id))
              .run()
          }
        }
      } else if (newPosition < existing.position) {
        // Moving up
        for (const t of columnTasks) {
          if (t.id !== id && t.position >= newPosition && t.position < existing.position) {
            db.update(tasks)
              .set({ position: t.position + 1, updatedAt: now })
              .where(eq(tasks.id, t.id))
              .run()
          }
        }
      }
    }

    // Update the task status (handles all side effects: broadcast, notifications, killClaude)
    const updated = await updateTaskStatus(id, newStatus, newPosition)

    return c.json(updated ? toApiResponse(updated, true) : null)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to update task status' }, 400)
  }
})

// POST /api/tasks/:id/kill-claude - Kill Claude processes in task terminals
app.post('/:id/kill-claude', (c) => {
  const id = c.req.param('id')
  const task = db.select().from(tasks).where(eq(tasks.id, id)).get()

  if (!task) {
    return c.json({ error: 'Task not found' }, 404)
  }

  if (!task.worktreePath) {
    return c.json({ success: true, terminalsAffected: 0 })
  }

  try {
    const count = killClaudeInTerminalsForWorktree(task.worktreePath)
    return c.json({ success: true, terminalsAffected: count })
  } catch {
    return c.json({ success: true, terminalsAffected: 0 })
  }
})

// GET /api/tasks/:id/links - List links for a task
app.get('/:id/links', (c) => {
  const taskId = c.req.param('id')
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get()
  if (!task) {
    return c.json({ error: 'Task not found' }, 404)
  }
  const links = getTaskLinks(taskId)
  return c.json(links)
})

// POST /api/tasks/:id/links - Add a link to a task
app.post('/:id/links', async (c) => {
  const taskId = c.req.param('id')

  try {
    const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get()
    if (!task) {
      return c.json({ error: 'Task not found' }, 404)
    }

    const body = await c.req.json<{ url: string; label?: string }>()
    if (!body.url) {
      return c.json({ error: 'URL is required' }, 400)
    }

    const detected = detectLinkType(body.url)
    const now = new Date().toISOString()

    const newLink = {
      id: crypto.randomUUID(),
      taskId,
      url: body.url,
      label: body.label || detected.label,
      type: detected.type,
      createdAt: now,
    }

    db.insert(taskLinks).values(newLink).run()
    broadcast({ type: 'task:updated', payload: { taskId } })

    return c.json(newLink, 201)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to add link' }, 400)
  }
})

// DELETE /api/tasks/:id/links/:linkId - Remove a link from a task
app.delete('/:id/links/:linkId', (c) => {
  const taskId = c.req.param('id')
  const linkId = c.req.param('linkId')

  const link = db
    .select()
    .from(taskLinks)
    .where(and(eq(taskLinks.id, linkId), eq(taskLinks.taskId, taskId)))
    .get()

  if (!link) {
    return c.json({ error: 'Link not found' }, 404)
  }

  db.delete(taskLinks).where(eq(taskLinks.id, linkId)).run()
  broadcast({ type: 'task:updated', payload: { taskId } })

  return c.json({ success: true })
})

// POST /api/tasks/:id/tags - Add a tag to a task
app.post('/:id/tags', async (c) => {
  const taskId = c.req.param('id')

  try {
    const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get()
    if (!task) {
      return c.json({ error: 'Task not found' }, 404)
    }

    const body = await c.req.json<{ tag?: string; tagId?: string; color?: string }>()

    let tagId = body.tagId
    const tagName = body.tag?.trim()

    // If no tagId provided, find or create tag by name
    if (!tagId && tagName) {
      // Check if tag exists
      const existing = db.select().from(tags).where(eq(tags.name, tagName)).get()
      if (existing) {
        tagId = existing.id
      } else {
        // Create new tag
        const now = new Date().toISOString()
        tagId = nanoid()
        db.insert(tags)
          .values({
            id: tagId,
            name: tagName,
            color: body.color?.trim() || null,
            createdAt: now,
          })
          .run()
      }
    }

    if (!tagId) {
      return c.json({ error: 'tag or tagId is required' }, 400)
    }

    // Verify tag exists
    const tag = db.select().from(tags).where(eq(tags.id, tagId)).get()
    if (!tag) {
      return c.json({ error: 'Tag not found' }, 404)
    }

    // Check if already linked
    const existingLink = db
      .select()
      .from(taskTags)
      .where(and(eq(taskTags.taskId, taskId), eq(taskTags.tagId, tagId)))
      .get()

    if (!existingLink) {
      const now = new Date().toISOString()
      db.insert(taskTags)
        .values({
          id: nanoid(),
          taskId,
          tagId,
          createdAt: now,
        })
        .run()

      db.update(tasks)
        .set({ updatedAt: now })
        .where(eq(tasks.id, taskId))
        .run()
    }

    reindexTaskFTS(taskId)
    const currentTags = getTaskTags(taskId)
    broadcast({ type: 'task:updated', payload: { taskId } })
    return c.json({ tags: currentTags })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to add tag' }, 400)
  }
})

// DELETE /api/tasks/:id/tags/:tag - Remove a tag from a task (by tag name or ID)
app.delete('/:id/tags/:tag', (c) => {
  const taskId = c.req.param('id')
  const tagParam = decodeURIComponent(c.req.param('tag'))

  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get()
  if (!task) {
    return c.json({ error: 'Task not found' }, 404)
  }

  // Find tag by ID first, then by name
  let tag = db.select().from(tags).where(eq(tags.id, tagParam)).get()
  if (!tag) {
    tag = db.select().from(tags).where(eq(tags.name, tagParam)).get()
  }

  if (!tag) {
    // Tag doesn't exist, nothing to remove
    const currentTags = getTaskTags(taskId)
    return c.json({ tags: currentTags })
  }

  // Delete the task-tag association
  db.delete(taskTags)
    .where(and(eq(taskTags.taskId, taskId), eq(taskTags.tagId, tag.id)))
    .run()

  const now = new Date().toISOString()
  db.update(tasks)
    .set({ updatedAt: now })
    .where(eq(tasks.id, taskId))
    .run()

  reindexTaskFTS(taskId)
  const currentTags = getTaskTags(taskId)
  broadcast({ type: 'task:updated', payload: { taskId } })
  return c.json({ tags: currentTags })
})

// PATCH /api/tasks/:id/due-date - Set or clear due date
app.patch('/:id/due-date', async (c) => {
  const taskId = c.req.param('id')

  try {
    const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get()
    if (!task) {
      return c.json({ error: 'Task not found' }, 404)
    }

    const body = await c.req.json<{ dueDate: string | null }>()

    const now = new Date().toISOString()
    db.update(tasks)
      .set({ dueDate: body.dueDate, updatedAt: now })
      .where(eq(tasks.id, taskId))
      .run()

    broadcast({ type: 'task:updated', payload: { taskId } })
    return c.json({ dueDate: body.dueDate })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to set due date' }, 400)
  }
})

// GET /api/tasks/:id/dependencies - Get dependencies for a task
app.get('/:id/dependencies', (c) => {
  const taskId = c.req.param('id')

  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get()
  if (!task) {
    return c.json({ error: 'Task not found' }, 404)
  }

  // Get tasks that this task depends on (blockers) - only 'depends_on' type
  const dependsOn = db
    .select()
    .from(taskRelationships)
    .where(
      and(
        eq(taskRelationships.taskId, taskId),
        eq(taskRelationships.type, 'depends_on')
      )
    )
    .all()

  // Get tasks that depend on this task (dependents) - only 'depends_on' type
  const dependents = db
    .select()
    .from(taskRelationships)
    .where(
      and(
        eq(taskRelationships.relatedTaskId, taskId),
        eq(taskRelationships.type, 'depends_on')
      )
    )
    .all()

  // Fetch the actual task details for dependencies
  const dependsOnTasks = dependsOn.map((dep) => {
    const t = db.select().from(tasks).where(eq(tasks.id, dep.relatedTaskId)).get()
    return {
      id: dep.id,
      dependsOnTaskId: dep.relatedTaskId,
      task: t ? { id: t.id, title: t.title, status: t.status } : null,
      createdAt: dep.createdAt,
    }
  })

  const dependentTasks = dependents.map((dep) => {
    const t = db.select().from(tasks).where(eq(tasks.id, dep.taskId)).get()
    return {
      id: dep.id,
      taskId: dep.taskId,
      task: t ? { id: t.id, title: t.title, status: t.status } : null,
      createdAt: dep.createdAt,
    }
  })

  // Task is blocked if any of its dependencies are not DONE
  const isBlocked = dependsOnTasks.some(
    (dep) => dep.task && dep.task.status !== 'DONE' && dep.task.status !== 'CANCELED'
  )

  return c.json({
    dependsOn: dependsOnTasks,
    dependents: dependentTasks,
    isBlocked,
  })
})

// POST /api/tasks/:id/dependencies - Add a dependency
app.post('/:id/dependencies', async (c) => {
  const taskId = c.req.param('id')

  try {
    const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get()
    if (!task) {
      return c.json({ error: 'Task not found' }, 404)
    }

    const body = await c.req.json<{ dependsOnTaskId: string }>()
    if (!body.dependsOnTaskId) {
      return c.json({ error: 'dependsOnTaskId is required' }, 400)
    }

    // Can't depend on itself
    if (body.dependsOnTaskId === taskId) {
      return c.json({ error: 'Task cannot depend on itself' }, 400)
    }

    // Check that the target task exists
    const targetTask = db.select().from(tasks).where(eq(tasks.id, body.dependsOnTaskId)).get()
    if (!targetTask) {
      return c.json({ error: 'Target task not found' }, 404)
    }

    // Check for existing dependency
    const existing = db
      .select()
      .from(taskRelationships)
      .where(
        and(
          eq(taskRelationships.taskId, taskId),
          eq(taskRelationships.relatedTaskId, body.dependsOnTaskId),
          eq(taskRelationships.type, 'depends_on')
        )
      )
      .get()

    if (existing) {
      return c.json({ error: 'Dependency already exists' }, 400)
    }

    // Check for circular dependency (target depends on us)
    const circular = db
      .select()
      .from(taskRelationships)
      .where(
        and(
          eq(taskRelationships.taskId, body.dependsOnTaskId),
          eq(taskRelationships.relatedTaskId, taskId),
          eq(taskRelationships.type, 'depends_on')
        )
      )
      .get()

    if (circular) {
      return c.json({ error: 'Circular dependency detected' }, 400)
    }

    const now = new Date().toISOString()
    const newDep = {
      id: crypto.randomUUID(),
      taskId,
      relatedTaskId: body.dependsOnTaskId,
      type: 'depends_on' as const,
      createdAt: now,
    }

    db.insert(taskRelationships).values(newDep).run()

    broadcast({ type: 'task:updated', payload: { taskId } })
    broadcast({ type: 'task:updated', payload: { taskId: body.dependsOnTaskId } })

    // Return with the old field name for API compatibility
    return c.json({
      id: newDep.id,
      taskId: newDep.taskId,
      dependsOnTaskId: newDep.relatedTaskId,
      createdAt: newDep.createdAt,
    }, 201)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to add dependency' }, 400)
  }
})

// DELETE /api/tasks/:id/dependencies/:depId - Remove a dependency
app.delete('/:id/dependencies/:depId', (c) => {
  const taskId = c.req.param('id')
  const depId = c.req.param('depId')

  const dep = db
    .select()
    .from(taskRelationships)
    .where(and(eq(taskRelationships.id, depId), eq(taskRelationships.taskId, taskId)))
    .get()

  if (!dep) {
    return c.json({ error: 'Dependency not found' }, 404)
  }

  db.delete(taskRelationships).where(eq(taskRelationships.id, depId)).run()

  broadcast({ type: 'task:updated', payload: { taskId } })
  broadcast({ type: 'task:updated', payload: { taskId: dep.relatedTaskId } })

  return c.json({ success: true })
})

// GET /api/tasks/dependencies/graph - Get all dependencies for graph visualization (must be before /:id)
// Note: This is handled separately below since it needs to come before the :id routes

// ==================== ATTACHMENT ROUTES ====================

// GET /api/tasks/:id/attachments - List attachments for a task
app.get('/:id/attachments', (c) => {
  const taskId = c.req.param('id')

  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get()
  if (!task) {
    return c.json({ error: 'Task not found' }, 404)
  }

  const attachments = db
    .select()
    .from(taskAttachments)
    .where(eq(taskAttachments.taskId, taskId))
    .all()

  return c.json(attachments)
})

// POST /api/tasks/:id/attachments - Upload an attachment
app.post('/:id/attachments', async (c) => {
  const taskId = c.req.param('id')

  try {
    const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get()
    if (!task) {
      return c.json({ error: 'Task not found' }, 404)
    }

    const formData = await c.req.formData()
    const file = formData.get('file') as File | null

    if (!file) {
      return c.json({ error: 'No file provided' }, 400)
    }

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      return c.json({ error: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB` }, 400)
    }

    // Create upload directory
    const uploadDir = getTaskUploadsDir(taskId)
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true })
    }

    // Generate unique filename
    const uuid = crypto.randomUUID()
    const sanitizedName = sanitizeFilename(file.name)
    const storedFilename = `${uuid}-${sanitizedName}`
    const storedPath = path.join(uploadDir, storedFilename)

    // Write file to disk
    const arrayBuffer = await file.arrayBuffer()
    fs.writeFileSync(storedPath, Buffer.from(arrayBuffer))

    // Create DB record
    const now = new Date().toISOString()
    const newAttachment = {
      id: crypto.randomUUID(),
      taskId,
      filename: file.name,
      storedPath,
      mimeType: file.type || 'application/octet-stream',
      size: file.size,
      createdAt: now,
    }

    db.insert(taskAttachments).values(newAttachment).run()
    broadcast({ type: 'task:updated', payload: { taskId } })

    return c.json(newAttachment, 201)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to upload attachment' }, 400)
  }
})

// GET /api/tasks/:id/attachments/:attachmentId - Download an attachment
app.get('/:id/attachments/:attachmentId', (c) => {
  const taskId = c.req.param('id')
  const attachmentId = c.req.param('attachmentId')

  const attachment = db
    .select()
    .from(taskAttachments)
    .where(and(eq(taskAttachments.id, attachmentId), eq(taskAttachments.taskId, taskId)))
    .get()

  if (!attachment) {
    return c.json({ error: 'Attachment not found' }, 404)
  }

  // Check file exists
  if (!fs.existsSync(attachment.storedPath)) {
    return c.json({ error: 'File not found on disk' }, 404)
  }

  // Read file and return
  const fileBuffer = fs.readFileSync(attachment.storedPath)
  const inlineRequested = c.req.query('inline') === '1'
  const disposition = inlineRequested && INLINE_SAFE_MIME_TYPES.has(attachment.mimeType) ? 'inline' : 'attachment'
  return new Response(fileBuffer, {
    headers: {
      'Content-Type': attachment.mimeType,
      'Content-Disposition': `${disposition}; filename="${attachment.filename}"`,
      'Content-Length': String(attachment.size),
      'X-Content-Type-Options': 'nosniff',
    },
  })
})

// DELETE /api/tasks/:id/attachments/:attachmentId - Delete an attachment
app.delete('/:id/attachments/:attachmentId', (c) => {
  const taskId = c.req.param('id')
  const attachmentId = c.req.param('attachmentId')

  const attachment = db
    .select()
    .from(taskAttachments)
    .where(and(eq(taskAttachments.id, attachmentId), eq(taskAttachments.taskId, taskId)))
    .get()

  if (!attachment) {
    return c.json({ error: 'Attachment not found' }, 404)
  }

  // Delete file from disk
  if (fs.existsSync(attachment.storedPath)) {
    fs.unlinkSync(attachment.storedPath)
  }

  // Delete from DB
  db.delete(taskAttachments).where(eq(taskAttachments.id, attachmentId)).run()
  broadcast({ type: 'task:updated', payload: { taskId } })

  return c.json({ success: true })
})

export default app
