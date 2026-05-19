/**
 * Codex chat service for the built-in assistant.
 *
 * Uses the @openai/codex-sdk TypeScript library to drive the local Codex CLI via
 * its app-server JSON-RPC protocol. Threads are created per Fulcrum session and
 * persisted in ~/.codex/sessions; we keep a Map of fulcrumSessionId → codexThreadId
 * so follow-up messages resume the same thread.
 *
 * Event stream:
 *  - reasoning items   → emitted as `content:delta` events tagged with reasoning style
 *  - agent_message     → final assistant text streamed as `content:delta`
 *  - command_execution → surfaced as a tool-call style status line
 *  - error / failure   → `error` event
 *  - turn.completed    → `done`
 */
import { Codex, type Thread, type ThreadEvent } from '@openai/codex-sdk'
import { homedir } from 'node:os'
import { log } from '../lib/logger'
import { getSettings } from '../lib/settings'
import { db, tasks, projects, repositories, apps, projectRepositories } from '../db'
import { eq } from 'drizzle-orm'
import type { PageContext, AttachmentData } from '../../shared/types'

// Maps Fulcrum session ID → Codex thread ID so follow-up turns resume the same thread.
const codexThreadIds = new Map<string, string>()

// Single shared Codex SDK client (Codex binary is launched per-thread by the SDK).
let codexClient: Codex | null = null

function getClient(): Codex {
  if (codexClient) return codexClient
  codexClient = new Codex({
    // Pass through process env so codex picks up OPENAI_API_KEY / auth tokens.
    env: process.env as Record<string, string>,
  })
  return codexClient
}

/**
 * Build context message for the assistant chat with page context.
 * Mirrors opencode-chat-service.buildContextMessage.
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

function getOrCreateThread(
  fulcrumSessionId: string,
  model: string | null,
): Thread {
  const codex = getClient()
  const existingThreadId = codexThreadIds.get(fulcrumSessionId)

  const threadOptions = {
    ...(model && { model }),
    sandboxMode: 'workspace-write' as const,
    skipGitRepoCheck: true,
    workingDirectory: homedir(),
    approvalPolicy: 'never' as const,
  }

  if (existingThreadId) {
    return codex.resumeThread(existingThreadId, threadOptions)
  }
  return codex.startThread(threadOptions)
}

/**
 * Stream a chat message through the Codex SDK.
 *
 * Yields content deltas as the agent emits text/reasoning, plus a final done event.
 */
export async function* streamCodexMessage(
  sessionId: string,
  message: string,
  model: string | undefined,
  context?: PageContext,
  _attachments?: AttachmentData[],
): AsyncGenerator<{ type: string; data: unknown }> {
  const settings = getSettings()
  const codexModel = model || settings.agent.codexModel || null

  const contextMsg = await buildContextMessage(context)
  const fullMessage = contextMsg ? `[Page context]\n${contextMsg}\n\n[User]\n${message}` : message

  try {
    const thread = getOrCreateThread(sessionId, codexModel)
    const { events } = await thread.runStreamed(fullMessage)

    // Track per-item text so we only yield the delta when an item updates.
    const itemText = new Map<string, string>()

    for await (const event of events as AsyncGenerator<ThreadEvent>) {
      switch (event.type) {
        case 'thread.started':
          codexThreadIds.set(sessionId, event.thread_id)
          break

        case 'item.started':
        case 'item.updated': {
          const item = event.item
          if (item.type === 'agent_message' || item.type === 'reasoning') {
            const prev = itemText.get(item.id) || ''
            const next = item.text || ''
            const delta = next.slice(prev.length)
            if (delta) {
              itemText.set(item.id, next)
              yield { type: 'content:delta', data: { text: delta } }
            }
          } else if (item.type === 'command_execution' && event.type === 'item.started') {
            yield {
              type: 'content:delta',
              data: { text: `\n\n\`\`\`bash\n$ ${item.command}\n\`\`\`\n\n` },
            }
          }
          break
        }

        case 'item.completed': {
          const item = event.item
          if (item.type === 'agent_message' || item.type === 'reasoning') {
            const prev = itemText.get(item.id) || ''
            const next = item.text || ''
            const delta = next.slice(prev.length)
            if (delta) {
              itemText.set(item.id, next)
              yield { type: 'content:delta', data: { text: delta } }
            }
          }
          break
        }

        case 'turn.failed':
          yield { type: 'error', data: { message: event.error.message } }
          return

        case 'error':
          yield { type: 'error', data: { message: event.message } }
          return

        case 'turn.completed':
          yield { type: 'done', data: { usage: event.usage } }
          return
      }
    }

    yield { type: 'done', data: {} }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    log.chat.error('Codex chat stream error', { sessionId, error: errorMsg })
    yield { type: 'error', data: { message: errorMsg } }
  }
}
