import { execSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { glob } from 'glob'
import { log } from './logger'
import { getSSHConnectionManager, type SSHConnectionConfig } from '../terminal/ssh-connection-manager'
import { shellEscape } from './shell-escape'

/**
 * Check if a string looks like a git URL
 */
export function isGitUrl(source: string): boolean {
  return (
    source.startsWith('git@') ||
    source.startsWith('https://') ||
    source.startsWith('http://') ||
    source.startsWith('gh:') ||
    source.startsWith('gl:') ||
    source.startsWith('bb:')
  )
}

/**
 * Extract repository name from a git URL
 *
 * Examples:
 * - https://github.com/user/repo.git -> repo
 * - https://github.com/user/repo -> repo
 * - git@github.com:user/repo.git -> repo
 * - gh:user/repo -> repo
 */
export function extractRepoNameFromUrl(url: string): string {
  // Remove .git suffix if present
  const cleaned = url.replace(/\.git$/, '')

  // Handle different URL formats
  if (cleaned.startsWith('git@')) {
    // git@github.com:user/repo -> repo
    const match = cleaned.match(/:([^/]+\/)?([^/]+)$/)
    if (match) return match[2]
  } else if (cleaned.startsWith('gh:') || cleaned.startsWith('gl:') || cleaned.startsWith('bb:')) {
    // gh:user/repo -> repo
    const parts = cleaned.split('/')
    if (parts.length > 0) return parts[parts.length - 1]
  } else {
    // https://github.com/user/repo -> repo
    const parts = cleaned.split('/')
    if (parts.length > 0) return parts[parts.length - 1]
  }

  // Fallback: use the whole URL as name (shouldn't happen)
  return cleaned
}

/**
 * If baseBranch looks like a remote ref (e.g. "origin/develop"),
 * fetch the branch from the remote so the local tracking ref is up-to-date.
 * Best-effort: silently catches all errors.
 */
export function fetchIfRemoteRef(repoPath: string, baseBranch: string): void {
  // Must contain at least one slash to be a potential remote ref
  const slashIndex = baseBranch.indexOf('/')
  if (slashIndex <= 0) return

  const remoteName = baseBranch.slice(0, slashIndex)
  const branchName = baseBranch.slice(slashIndex + 1)
  if (!branchName) return

  // Validate that remoteName is an actual configured remote
  try {
    const remotes = execSync('git remote', {
      cwd: repoPath,
      encoding: 'utf-8',
      timeout: 10_000,
    })
      .trim()
      .split('\n')
      .map((r) => r.trim())
      .filter(Boolean)

    if (!remotes.includes(remoteName)) return
  } catch {
    return
  }

  // Fetch the specific branch from the remote
  try {
    execSync(`git fetch ${remoteName} ${branchName}`, {
      cwd: repoPath,
      encoding: 'utf-8',
      timeout: 30_000,
    })
  } catch {
    // Best-effort: proceed with stale ref if fetch fails
  }
}

/**
 * Check the state of the source repo before creating a worktree.
 * Returns warnings and whether pull should be skipped.
 *
 * - Uncommitted changes: warning only (doesn't affect worktree pull)
 * - Unpushed commits: SKIP pull — local branch has diverged from remote,
 *   pulling would force a merge between two divergent histories
 */
export function checkRepoStateForWorktree(
  repoPath: string,
  baseBranch: string,
  remoteBranch?: string,
): { warnings: string[]; skipPull: boolean } {
  const warnings: string[] = []
  let skipPull = false

  try {
    const status = execSync('git status --porcelain', { cwd: repoPath, encoding: 'utf-8' }).trim()
    if (status) {
      warnings.push('Source repository has uncommitted changes that will not be included in the worktree')
    }
  } catch {
    // Ignore
  }

  try {
    if (remoteBranch) {
      execSync('git fetch --quiet', { cwd: repoPath, encoding: 'utf-8', timeout: 15_000, stdio: 'pipe' })

      const ahead = execSync(`git rev-list --count ${remoteBranch}..${baseBranch}`, {
        cwd: repoPath, encoding: 'utf-8', stdio: 'pipe',
      }).trim()
      const aheadCount = parseInt(ahead, 10) || 0
      if (aheadCount > 0) {
        skipPull = true
        warnings.push(`Pull skipped: "${baseBranch}" has ${aheadCount} unpushed commit${aheadCount > 1 ? 's' : ''} not on ${remoteBranch}. Push first, or pull manually after resolving.`)
      }
    }
  } catch {
    // Remote unreachable — don't block, let pull attempt handle the error
  }

  return { warnings, skipPull }
}

/**
 * Create a git worktree with a new branch based on baseBranch.
 * Fetches the remote ref first if baseBranch is a remote tracking branch.
 */
export function createGitWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
  baseBranch: string,
): { success: boolean; error?: string } {
  try {
    // Ensure parent directory exists
    const worktreeParent = path.dirname(worktreePath)
    if (!fs.existsSync(worktreeParent)) {
      fs.mkdirSync(worktreeParent, { recursive: true })
    }

    // Fetch remote ref if baseBranch looks like one (e.g. origin/develop)
    fetchIfRemoteRef(repoPath, baseBranch)

    // Create the worktree with a new branch based on baseBranch
    try {
      execSync(`git worktree add -b "${branch}" "${worktreePath}" "${baseBranch}"`, {
        cwd: repoPath,
        encoding: 'utf-8',
      })
    } catch {
      // Branch might already exist, try without -b
      execSync(`git worktree add "${worktreePath}" "${branch}"`, {
        cwd: repoPath,
        encoding: 'utf-8',
      })
    }
    return { success: true }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to create worktree' }
  }
}

/**
 * Create a git worktree on a remote host via SSH.
 */
export async function createRemoteGitWorktree(
  sshConfig: SSHConnectionConfig,
  repoPath: string,
  worktreePath: string,
  branch: string,
  baseBranch: string,
): Promise<{ success: boolean; error?: string }> {
  const manager = getSSHConnectionManager()
  try {
    // Verify remote repo path exists
    try {
      await manager.execCommand(sshConfig, `test -d ${shellEscape(repoPath)}`, 10000)
    } catch {
      return { success: false, error: `Remote repo path not found: ${repoPath}` }
    }

    const cmd = [
      `mkdir -p "$(dirname ${shellEscape(worktreePath)})"`,
      `cd ${shellEscape(repoPath)}`,
      `git fetch origin ${shellEscape(baseBranch)} 2>/dev/null || true`,
      `git worktree add -b ${shellEscape(branch)} ${shellEscape(worktreePath)} ${shellEscape(baseBranch)} 2>&1 || git worktree add ${shellEscape(worktreePath)} ${shellEscape(branch)} 2>&1`,
    ].join(' && ')

    await manager.execCommand(sshConfig, cmd, 120000)
    return { success: true }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to create remote worktree' }
  }
}

/**
 * Pull latest changes from a remote branch into a worktree.
 * Runs `git pull <remote> <branch>` inside the worktree directory.
 * Best-effort: returns error string on failure but does not throw.
 * On merge conflict, automatically aborts to leave the worktree clean.
 */
export function pullLatestInWorktree(
  worktreePath: string,
  remoteBranch?: string,
): { success: boolean; error?: string; commitsPulled?: number } {
  // Skip pull if no remote branch specified — caller should be warned
  if (remoteBranch !== undefined && !remoteBranch) {
    return { success: false, error: 'No remote branch specified' }
  }

  try {
    // Count commits before pull for reporting
    const headBefore = execSync('git rev-parse HEAD', { cwd: worktreePath, encoding: 'utf-8' }).trim()

    // Build pull args: split "origin/main" into "origin main", handle nested branches like "origin/feature/login"
    let args = ''
    if (remoteBranch) {
      const slashIdx = remoteBranch.indexOf('/')
      if (slashIdx !== -1) {
        const remote = remoteBranch.slice(0, slashIdx)
        const branch = remoteBranch.slice(slashIdx + 1)
        args = ` ${remote} ${branch}`
      } else {
        args = ` ${remoteBranch}`
      }
    }

    execSync(`git pull${args}`, {
      cwd: worktreePath,
      encoding: 'utf-8',
      timeout: 60_000,
    })

    // Count commits pulled
    const headAfter = execSync('git rev-parse HEAD', { cwd: worktreePath, encoding: 'utf-8' }).trim()
    let commitsPulled = 0
    if (headBefore !== headAfter) {
      try {
        const count = execSync(`git rev-list --count ${headBefore}..${headAfter}`, { cwd: worktreePath, encoding: 'utf-8' }).trim()
        commitsPulled = parseInt(count, 10) || 0
      } catch {
        commitsPulled = 1 // at least one if HEAD changed
      }
    }

    return { success: true, commitsPulled }
  } catch (err) {
    // Check if the failure left a merge conflict — abort to keep worktree clean
    try {
      // For worktrees, .git is a file pointing to the real git dir; check MERGE_HEAD via git command
      execSync('git rev-parse MERGE_HEAD', { cwd: worktreePath, encoding: 'utf-8', stdio: 'pipe' })
      // MERGE_HEAD exists → conflict. Abort the merge to restore clean state.
      execSync('git merge --abort', { cwd: worktreePath, encoding: 'utf-8' })
      const msg = 'Pull aborted due to merge conflict — worktree reverted to pre-pull state'
      log.api.error(msg, { worktreePath, remoteBranch })
      return { success: false, error: msg }
    } catch {
      // No MERGE_HEAD → not a conflict, just a regular pull failure
    }

    const msg = err instanceof Error ? err.message : 'Failed to pull latest'
    log.api.error('Failed to pull latest in worktree', { worktreePath, remoteBranch, error: msg })
    return { success: false, error: msg }
  }
}

export function gitPull(worktreePath: string): { success: boolean; error?: string; commitsPulled?: number } {
  return pullLatestInWorktree(worktreePath)
}

/**
 * Copy files to worktree based on glob patterns (comma-separated).
 */
export function copyFilesToWorktree(repoPath: string, worktreePath: string, patterns: string): void {
  const patternList = patterns
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)

  for (const pattern of patternList) {
    try {
      const files = glob.sync(pattern, { cwd: repoPath, nodir: true })
      for (const file of files) {
        const srcPath = path.join(repoPath, file)
        const destPath = path.join(worktreePath, file)
        const destDir = path.dirname(destPath)

        // Skip if file already exists (don't overwrite)
        if (fs.existsSync(destPath)) continue

        // Create destination directory if needed
        if (!fs.existsSync(destDir)) {
          fs.mkdirSync(destDir, { recursive: true })
        }

        fs.copyFileSync(srcPath, destPath)
      }
    } catch (err) {
      log.api.error('Failed to copy files matching pattern', { pattern, error: String(err) })
    }
  }
}
