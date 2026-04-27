import { execSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { glob } from 'glob'
import { log } from './logger'

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
 * Run `git pull` in the given repository directory.
 * Best-effort: returns success/error rather than throwing.
 */
export function gitPull(repoPath: string): { success: boolean; error?: string } {
  try {
    execSync('git pull', {
      cwd: repoPath,
      encoding: 'utf-8',
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return { success: true }
  } catch (err) {
    const stderr = (err as { stderr?: Buffer | string })?.stderr
    const detail = stderr ? String(stderr).trim() : err instanceof Error ? err.message : String(err)
    return { success: false, error: detail || 'git pull failed' }
  }
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
