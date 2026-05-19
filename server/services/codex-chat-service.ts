/**
 * Codex chat service for the built-in assistant.
 *
 * Codex has no streaming SDK comparable to @anthropic-ai/claude-agent-sdk or
 * @opencode-ai/sdk, so we spawn `codex exec` for each user message and stream
 * its stdout back as content deltas. The response arrives as a single block
 * (no incremental tokens) — acceptable for v1.
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { homedir } from 'node:os'
import { log } from '../lib/logger'
import { getSettings } from '../lib/settings'
import { db, tasks, projects, repositories, apps, projectRepositories } from '../db'
import { eq } from 'drizzle-orm'
import type { PageContext, AttachmentData } from '../../shared/types'

/**
 * Build the system prompt for the chat assistant with page context.
 * Mirrors opencode-chat-service.buildContextMessage but trimmed to essentials.
 */
async function buildContextMessage(context?: PageContext): Promise<string | null> {
  if (!context) return null

  const parts: string[] = [`Current page: ${context.path}`]
  switch (context.pageType) {
    case 'task': {
      if (context.taskId) {
        const task = db.select().from(tasks).where(eq(tasks.id, context.taskId)).get()
        if (task) {
          parts.push(`Viewing task: "${task.title}"`)
          parts.push(`Status: ${task.status}`)
          if (task.branch) parts.push(`Branch: ${task.branch}`)
          if (task.repoName) parts.push(`Repository: ${task.repoName}`)
          if (task.description) parts.push(`Description: ${task.description}`)
        }
      }
      break
    }
    case 'project': {
      if (context.projectId) {
        const project = db.select().from(projects).where(eq(projects.id, context.projectId)).get()
        if (project) {
          parts.push(`Viewing project: "${project.name}"`)
          if (project.description) parts.push(`Description: ${project.description}`)
          const links = db.select().from(projectRepositories).where(eq(projectRepositories.projectId, project.id)).all()
          if (links.length > 0) {
            parts.push(`Repositories: ${links.length}`)
          }
        }
      }
      break
    }
    case 'repository': {
      if (context.repositoryId) {
        const repo = db.select().from(repositories).where(eq(repositories.id, context.repositoryId)).get()
        if (repo) parts.push(`Viewing repository: "${repo.displayName}" (${repo.path})`)
      }
      break
    }
    case 'app': {
      if (context.appId) {
        const appRow = db.select().from(apps).where(eq(apps.id, context.appId)).get()
        if (appRow) parts.push(`Viewing app: "${appRow.name}"`)
      }
      break
    }
  }
  return parts.join('\n')
}

/**
 * Stream a chat message through `codex exec`.
 *
 * Yields:
 *  - `content:delta` events with text chunks (Codex emits in a single block; we still split on newlines for UX)
 *  - `done` when complete
 *  - `error` on failure
 */
export async function* streamCodexMessage(
  _sessionId: string,
  message: string,
  model: string | undefined,
  context?: PageContext,
  _attachments?: AttachmentData[],
): AsyncGenerator<{ type: string; data: unknown }> {
  const settings = getSettings()
  const codexModel = model || settings.agent.codexModel || null

  const contextMsg = await buildContextMessage(context)
  const prompt = contextMsg ? `[Page context]\n${contextMsg}\n\n[User]\n${message}` : message

  const args = [
    'exec',
    '--ephemeral',
    '--skip-git-repo-check',
    '--dangerously-bypass-approvals-and-sandbox',
    '-C', homedir(),
  ]
  if (codexModel) args.push('-m', codexModel)
  args.push('--', prompt)

  let child: ChildProcessByStdio<null, Readable, Readable>
  try {
    child = spawn('codex', args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.chat.error('Failed to spawn codex exec', { error: msg })
    yield { type: 'error', data: { message: msg } }
    return
  }

  // Codex exec streams partial reasoning + final answer to stdout. We forward chunks
  // verbatim — the UI can render them as a single growing message.
  const queue: string[] = []
  let done = false
  let errorMessage: string | null = null
  let stderrBuf = ''
  let resolveNext: (() => void) | null = null
  const notify = () => {
    if (resolveNext) {
      const r = resolveNext
      resolveNext = null
      r()
    }
  }

  child.stdout.on('data', (chunk: Buffer) => {
    queue.push(chunk.toString('utf-8'))
    notify()
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString('utf-8')
  })
  child.on('error', (err) => {
    errorMessage = err.message
    done = true
    notify()
  })
  child.on('close', (code) => {
    if (code !== 0 && !errorMessage) {
      errorMessage = `codex exec exited with code ${code}${stderrBuf ? `\n${stderrBuf.slice(0, 500)}` : ''}`
    }
    done = true
    notify()
  })

  try {
    while (!done || queue.length > 0) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          resolveNext = resolve
        })
        continue
      }
      const text = queue.shift()!
      yield { type: 'content:delta', data: { text } }
    }

    if (errorMessage) {
      yield { type: 'error', data: { message: errorMessage } }
      return
    }

    yield { type: 'done', data: {} }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.chat.error('Codex chat stream error', { error: msg })
    yield { type: 'error', data: { message: msg } }
  }
}
