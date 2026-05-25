import * as os from 'os'
import { eq } from 'drizzle-orm'
import { db, projects, projectRepositories, repositories, tasks } from '../db'
import { getSetting } from '../lib/settings'
import { log } from '../lib/logger'

/**
 * The herdr workspace + tab a task should live in. Used by HerdrMirrorService
 * to decide where to put the mirrored pane.
 */
export interface HerdrTaskTarget {
  workspaceLabel: string
  workspaceCwd: string
  tabLabel: string
}

const TAB_LABEL_MAX = 32

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…'
}

/**
 * Resolve the herdr workspace target for a task by id.
 *
 * Strategy:
 *   1. If the task has a direct projectId, the project name is the
 *      workspace label. Workspace cwd is the linked repository's path,
 *      falling back to the user's home if there is no repo (project
 *      without one).
 *   2. Otherwise, if the task has a repositoryId, look up the project via
 *      the projectRepositories join table. Same as above on hit.
 *   3. Otherwise (scratch / manual / orphan), fall back to the scratch
 *      workspace label from settings; cwd = $HOME.
 *
 * Tab label is always the task title, truncated.
 */
export function resolveWorkspaceForTaskId(taskId: string): HerdrTaskTarget | null {
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get()
  if (!task) {
    log.terminal.warn('resolveWorkspaceForTaskId: task not found', { taskId })
    return null
  }

  const tabLabel = truncate(task.title, TAB_LABEL_MAX)
  const scratchLabel =
    (getSetting('terminal.herdr.scratchWorkspaceLabel') as string) || 'scratch'

  // Branch 1: project FK on task
  if (task.projectId) {
    const project = db.select().from(projects).where(eq(projects.id, task.projectId)).get()
    if (project) {
      const repoCwd = task.repositoryId ? lookupRepoPath(task.repositoryId) : null
      return {
        workspaceLabel: project.name,
        workspaceCwd: repoCwd ?? os.homedir(),
        tabLabel,
      }
    }
  }

  // Branch 2: repository FK on task → project via projectRepositories
  if (task.repositoryId) {
    const link = db
      .select()
      .from(projectRepositories)
      .where(eq(projectRepositories.repositoryId, task.repositoryId))
      .get()
    if (link) {
      const project = db.select().from(projects).where(eq(projects.id, link.projectId)).get()
      if (project) {
        const repoCwd = lookupRepoPath(task.repositoryId)
        return {
          workspaceLabel: project.name,
          workspaceCwd: repoCwd ?? os.homedir(),
          tabLabel,
        }
      }
    }
    // Repo with no project → fall back to repo's displayName as workspace label
    const repo = db.select().from(repositories).where(eq(repositories.id, task.repositoryId)).get()
    if (repo) {
      return {
        workspaceLabel: repo.displayName,
        workspaceCwd: repo.path,
        tabLabel,
      }
    }
  }

  // Branch 3: scratch / manual / orphan
  return {
    workspaceLabel: scratchLabel,
    workspaceCwd: os.homedir(),
    tabLabel,
  }
}

function lookupRepoPath(repoId: string): string | null {
  const repo = db.select().from(repositories).where(eq(repositories.id, repoId)).get()
  return repo?.path ?? null
}
