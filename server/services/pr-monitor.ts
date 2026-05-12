import { execSync } from 'child_process'
import { db } from '../db'
import { tasks } from '../db/schema'
import { isNotNull, isNull, and, eq, notInArray } from 'drizzle-orm'
import { updateTaskStatus } from './task-status'
import { gitPull } from '../lib/git-utils'
import { sendNotification } from './notification-service'
import { log } from '../lib/logger'

const POLL_INTERVAL = 60_000 // 60 seconds

interface PRStatus {
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  mergedAt: string | null
}

// Parse PR URL to extract owner/repo/number
// e.g., https://github.com/owner/repo/pull/123
function parsePrUrl(
  url: string
): { owner: string; repo: string; number: number } | null {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
  if (!match) return null
  return { owner: match[1], repo: match[2], number: parseInt(match[3], 10) }
}

// Check PR status using gh CLI
function checkPrStatus(prUrl: string): PRStatus | null {
  const parsed = parsePrUrl(prUrl)
  if (!parsed) {
    log.pr.warn('Invalid PR URL format', { prUrl })
    return null
  }

  try {
    const output = execSync(
      `gh pr view ${parsed.number} --repo ${parsed.owner}/${parsed.repo} --json state,mergedAt`,
      { encoding: 'utf-8', timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'] }
    )
    const data = JSON.parse(output)
    return {
      state: data.state,
      mergedAt: data.mergedAt ?? null,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.pr.error('Failed to check PR', { prUrl, error: message })
    return null
  }
}

// Poll and update task statuses
async function pollPRs(): Promise<void> {
  // Get all tasks with prUrl that are not DONE or CANCELED.
  // The isNull(prAutoClosedAt) clause guarantees we never auto-close the same
  // task twice — once stamped, the user can reopen the task to keep working
  // without the monitor re-closing it on the next poll.
  const tasksWithPR = db
    .select()
    .from(tasks)
    .where(
      and(
        isNotNull(tasks.prUrl),
        notInArray(tasks.status, ['DONE', 'CANCELED']),
        isNull(tasks.prAutoClosedAt)
      )
    )
    .all()

  for (const task of tasksWithPR) {
    if (!task.prUrl) continue

    const status = checkPrStatus(task.prUrl)
    if (!status) continue

    const isMerged = status.state === 'MERGED' || !!status.mergedAt
    const isClosedNotMerged = status.state === 'CLOSED' && !status.mergedAt

    if (!isMerged && !isClosedNotMerged) continue

    const newStatus = isMerged ? 'DONE' : 'CANCELED'
    await updateTaskStatus(task.id, newStatus)
    log.pr.info(
      isMerged
        ? 'Task marked as DONE (PR merged)'
        : 'Task marked as CANCELED (PR closed without merging)',
      { taskId: task.id, taskTitle: task.title }
    )

    // Stamp the auto-close marker so the next poll skips this task even if
    // the user moves it back out of DONE/CANCELED.
    db.update(tasks)
      .set({ prAutoClosedAt: new Date().toISOString() })
      .where(eq(tasks.id, task.id))
      .run()

    // Best-effort: pull the merged commits into the main repo checkout.
    // Failure must not prevent task closure (already done above).
    if (isMerged) {
      pullAfterMerge(task)
    }
  }
}

// Skip when the task is bound to a remote host: `gitPull` runs `git -C <path>`
// in the server process, so a remote `repoPath` would always fail locally and
// produce a noisy `Git pull failed` notification. Remote-host git pull is a
// separate concern.
type PullAfterMergeTask = {
  id: string
  title: string
  repoPath: string | null
  hostId: string | null
}

type PullAfterMergeDeps = {
  gitPull: (repoPath: string) => { success: boolean; error?: string }
  sendNotification: (payload: {
    title: string
    message: string
    type: string
    taskId?: string
    taskTitle?: string
  }) => Promise<unknown>
}

const defaultPullAfterMergeDeps: PullAfterMergeDeps = {
  gitPull,
  sendNotification: sendNotification as PullAfterMergeDeps['sendNotification'],
}

export function pullAfterMerge(
  task: PullAfterMergeTask,
  deps: PullAfterMergeDeps = defaultPullAfterMergeDeps
): void {
  if (task.hostId != null) {
    log.pr.info('Skipped post-merge git pull for remote-host task', {
      taskId: task.id,
      hostId: task.hostId,
    })
    return
  }

  if (!task.repoPath) return

  const result = deps.gitPull(task.repoPath)
  if (!result.success) {
    log.pr.warn('git pull failed after PR-merge auto-close', {
      taskId: task.id,
      repoPath: task.repoPath,
      error: result.error,
    })
    deps
      .sendNotification({
        title: 'Git pull failed',
        message: `Could not pull merged changes into ${task.repoPath}: ${result.error ?? 'unknown error'}`,
        type: 'deployment_failed',
        taskId: task.id,
        taskTitle: task.title,
      })
      .catch((err) =>
        log.pr.error('Failed to send git-pull-failed notification', { error: String(err) })
      )
  } else {
    log.pr.info('Pulled merged changes into main repo', {
      taskId: task.id,
      repoPath: task.repoPath,
    })
  }
}

let intervalId: ReturnType<typeof setInterval> | null = null

export function startPRMonitor(): void {
  if (intervalId) return // Already running

  log.pr.info('PR Monitor started (60s interval)')

  // Run immediately on start
  pollPRs().catch((err) => log.pr.error('Poll failed', { error: String(err) }))

  // Then poll every 60 seconds
  intervalId = setInterval(() => {
    pollPRs().catch((err) => log.pr.error('Poll failed', { error: String(err) }))
  }, POLL_INTERVAL)
}

export function stopPRMonitor(): void {
  if (intervalId) {
    clearInterval(intervalId)
    intervalId = null
    log.pr.info('PR Monitor stopped')
  }
}
