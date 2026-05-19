/**
 * Codex observer service for processing observe-only channel messages.
 *
 * Uses text-only processing with Fulcrum-mediated actions:
 * 1. Spawns `codex exec` with the message + structured-output JSON schema
 * 2. Parses the JSON response for actions (store_memory, ignore)
 * 3. Fulcrum executes the actions — the AI never directly invokes tools
 *
 * This ensures untrusted channel input cannot access filesystem, exec, or deploy tools.
 *
 * Codex has no SDK analog to @anthropic-ai/claude-agent-sdk or @opencode-ai/sdk, so
 * we shell out to `codex exec` for each observer invocation. The `--ephemeral` flag
 * skips session persistence, `--output-schema` constrains the final response shape,
 * and `--dangerously-bypass-approvals-and-sandbox` is safe here because we never
 * give Codex tools — it only emits JSON we parse and act on.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { log } from '../lib/logger'
import { getSettings } from '../lib/settings'
import { storeMemory } from './memory-service'
import type { ChannelHistoryMessage } from './channels/message-storage'

// JSON Schema for Codex's --output-schema flag, matching the observer action shape.
const OBSERVER_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['actions'],
  additionalProperties: false,
  properties: {
    actions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['type'],
        additionalProperties: true,
        properties: {
          type: { type: 'string', enum: ['create_task', 'update_task', 'move_task', 'store_memory'] },
          title: { type: 'string' },
          description: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          dueDate: { type: 'string' },
          taskId: { type: 'string' },
          status: { type: 'string', enum: ['TO_DO', 'IN_PROGRESS', 'CANCELED', 'DONE'] },
          content: { type: 'string' },
          source: { type: 'string' },
        },
      },
    },
  },
} as const

function getObserverSystemPrompt(recentTasks?: Array<{ id: string; title: string; status: string }>): string {
  const today = new Date()
  const todayStr = today.toISOString().split('T')[0]
  const exampleDate = new Date(today.getTime() + 10 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

  const recentTasksSection = recentTasks && recentTasks.length > 0
    ? `## Recent Open Tasks

${recentTasks.map(t => `- ${t.id}: ${t.title} [${t.status}]`).join('\n')}

IMPORTANT: Before creating a new task, check this list. If a task already covers the same topic,
use update_task to add new details or move_task to cancel duplicates. Only create_task if no
existing task covers the topic.

`
    : ''

  return `You are the user's observer. Only create a task when the user must take a specific action or fulfill a commitment they might otherwise forget. Default to storing a memory or doing nothing — only escalate to a task when doing nothing would cause the user to miss something important. A frivolous task is worse than no task: it wastes the user's time and erodes trust.

Today's date: ${todayStr}

${recentTasksSection}IMPORTANT: You have NO tools. Respond with a single JSON object matching the required output schema describing what actions to take. Do not run any commands.

Example response shape (only emit JSON matching the output schema):
{
  "actions": [
    {
      "type": "create_task",
      "title": "Clear action item title",
      "description": "Details including sender and context",
      "tags": ["from:whatsapp", "errand"],
      "dueDate": "${exampleDate}"
    },
    {
      "type": "store_memory",
      "content": "The fact or information to store",
      "tags": ["persistent"],
      "source": "channel:whatsapp"
    }
  ]
}

If the message contains nothing worth tracking (casual chat, greetings, spam, etc.), respond with:
{"actions": []}

## Action types

### create_task (only for genuine action items)
Use for: someone specifically asks the user to do something, the user must fulfill a commitment, a genuine deadline the user must meet.
Do NOT use for: automated notifications, FYI messages, event reminders, status updates, confirmations.
Fields: title (required, imperative action item), description, tags (array), dueDate (YYYY-MM-DD if mentioned).
Write titles as clear action items (e.g., "Send invoice to Alice" not "Email from Alice about invoice").

### update_task (update an existing task with new information)
Use for: a message adds new context to an existing task (new due date, updated details, additional info).
Fields: taskId (required), title, description, dueDate, tags.

### move_task (change task status)
Use for: canceling a duplicate task, marking a task complete because the message indicates it's been fulfilled, or changing task status based on new information.
Fields: taskId (required), status (required: "TO_DO" | "IN_PROGRESS" | "CANCELED" | "DONE").

### store_memory (for non-task observations)
Use for: learning someone's name, recurring patterns, key relationships, context updates, noteworthy information from notifications.
Fields: content (required), tags (array), source (e.g., "channel:whatsapp").

## Guidelines

Create a task ONLY when:
- Someone specifically asks the user to do something ("Can you send me X?", "Please review Y")
- The user made a commitment they might forget (promised to call someone, agreed to deliver something)
- A genuine deadline the user must personally meet (tax filing, contract deadline)

Store a memory for:
- Contact details, names, relationships
- Project context or status updates
- Patterns worth remembering
- Noteworthy information from notifications (without creating a task)

Do nothing for:
- Automated notifications (shipping updates, RSVP alerts, CI/CD results, social media)
- FYI/informational messages that don't require user action
- Event reminders for events already on the calendar
- Status updates and confirmations (order confirmations, booking confirmations)
- Newsletters, promotional emails, marketing content
- Casual greetings or small talk
- Messages you don't understand

## Decision test
Before creating a task, ask: "Is the user being asked to DO something specific, or would they miss a commitment without this?" If no, do nothing.`
}

interface ObserverAction {
  type: string
  content?: string
  tags?: string[]
  source?: string
  title?: string
  description?: string
  dueDate?: string
  taskId?: string
  status?: string
}

async function executeCreateTask(
  action: ObserverAction,
  options: { channelType: string },
  sessionId: string,
  fulcrumPort: number,
): Promise<void> {
  try {
    const resp = await fetch(`http://localhost:${fulcrumPort}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: action.title,
        description: action.description || null,
        status: 'TO_DO',
        tags: action.tags,
        dueDate: action.dueDate || null,
      }),
    })
    if (!resp.ok) {
      log.messaging.warn('Observer failed to create task via Codex', {
        sessionId, status: resp.status, title: action.title,
      })
      return
    }
    log.messaging.info('Observer created task via Codex', { sessionId, title: action.title })
    try {
      await fetch(`http://localhost:${fulcrumPort}/api/config/notifications/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: `New task from ${options.channelType}`, message: action.title }),
      })
    } catch {
      // Don't fail the flow
    }
  } catch (err) {
    log.messaging.warn('Observer task creation error via Codex', {
      sessionId, error: err instanceof Error ? err.message : String(err),
    })
  }
}

async function executeStoreMemory(
  action: ObserverAction,
  options: { channelType: string },
  sessionId: string,
): Promise<void> {
  const source = action.source || `channel:${options.channelType}`
  await storeMemory({ content: action.content!, tags: action.tags, source })
  log.messaging.info('Observer stored memory via Codex', {
    sessionId, source, contentPreview: action.content!.slice(0, 100),
  })
}

async function executeUpdateTask(
  action: ObserverAction,
  sessionId: string,
  fulcrumPort: number,
): Promise<void> {
  try {
    const updates: Record<string, unknown> = {}
    if (action.title) updates.title = action.title
    if (action.description) updates.description = action.description
    if (action.dueDate) updates.dueDate = action.dueDate

    const resp = await fetch(`http://localhost:${fulcrumPort}/api/tasks/${action.taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    })
    if (!resp.ok) {
      log.messaging.warn('Observer failed to update task via Codex', {
        sessionId, status: resp.status, taskId: action.taskId,
      })
      return
    }
    log.messaging.info('Observer updated task via Codex', { sessionId, taskId: action.taskId })
  } catch (err) {
    log.messaging.warn('Observer task update error via Codex', {
      sessionId, error: err instanceof Error ? err.message : String(err),
    })
  }
}

async function executeMoveTask(
  action: ObserverAction,
  sessionId: string,
  fulcrumPort: number,
): Promise<void> {
  try {
    const resp = await fetch(`http://localhost:${fulcrumPort}/api/tasks/${action.taskId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: action.status }),
    })
    if (!resp.ok) {
      log.messaging.warn('Observer failed to move task via Codex', {
        sessionId, status: resp.status, taskId: action.taskId, targetStatus: action.status,
      })
      return
    }
    log.messaging.info('Observer moved task via Codex', {
      sessionId, taskId: action.taskId, status: action.status,
    })
  } catch (err) {
    log.messaging.warn('Observer task move error via Codex', {
      sessionId, error: err instanceof Error ? err.message : String(err),
    })
  }
}

async function executeObserverActions(
  actions: ObserverAction[],
  options: { channelType: string },
  sessionId: string,
  fulcrumPort: number,
): Promise<void> {
  for (const action of actions) {
    if (action.type === 'create_task' && action.title) {
      await executeCreateTask(action, options, sessionId, fulcrumPort)
    } else if (action.type === 'update_task' && action.taskId) {
      await executeUpdateTask(action, sessionId, fulcrumPort)
    } else if (action.type === 'move_task' && action.taskId && action.status) {
      await executeMoveTask(action, sessionId, fulcrumPort)
    } else if (action.type === 'store_memory' && action.content) {
      await executeStoreMemory(action, options, sessionId)
    }
  }
}

function extractJsonFromResponse(text: string): unknown | null {
  let jsonText = text.trim()
  const fenced = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) {
    jsonText = fenced[1].trim()
  } else {
    // Codex exec sometimes prints status banners; try to isolate the last JSON object.
    const firstBrace = jsonText.indexOf('{')
    const lastBrace = jsonText.lastIndexOf('}')
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      jsonText = jsonText.slice(firstBrace, lastBrace + 1)
    }
  }
  try {
    return JSON.parse(jsonText)
  } catch {
    return null
  }
}

// Run `codex exec` with the observer prompt and return its final stdout.
function runCodexExec(opts: {
  prompt: string
  model: string | null
  timeoutMs: number
}): Promise<{ stdout: string; exitCode: number; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const schemaDir = mkdtempSync(join(tmpdir(), 'fulcrum-codex-observer-'))
    const schemaPath = join(schemaDir, 'observer-schema.json')
    writeFileSync(schemaPath, JSON.stringify(OBSERVER_OUTPUT_SCHEMA))

    const args = [
      'exec',
      '--ephemeral',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      '--output-schema', schemaPath,
      '-C', homedir(),
    ]
    if (opts.model) args.push('-m', opts.model)
    args.push('--', opts.prompt)

    const child = spawn('codex', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, opts.timeoutMs)

    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf-8') })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf-8') })

    child.on('error', (err) => {
      clearTimeout(timer)
      try { rmSync(schemaDir, { recursive: true, force: true }) } catch { /* ignore */ }
      reject(err)
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      try { rmSync(schemaDir, { recursive: true, force: true }) } catch { /* ignore */ }
      if (stderr.trim()) {
        log.messaging.debug('Codex observer stderr', { stderr: stderr.slice(0, 500) })
      }
      resolve({ stdout, exitCode: code ?? -1, timedOut })
    })
  })
}

/**
 * Process an observe-only channel message via Codex without direct tool access.
 */
export async function* streamCodexObserverMessage(
  sessionId: string,
  userMessage: string,
  options: {
    channelType: string
    senderId: string
    senderName?: string
    model?: string
    channelHistory?: ChannelHistoryMessage[]
    recentTasks?: Array<{ id: string; title: string; status: string }>
  }
): AsyncGenerator<{ type: string; data: unknown }> {
  try {
    const settings = getSettings()
    const model = options.model || settings.assistant.observerCodexModel || settings.agent.codexModel

    let contextualMessage = ''
    if (options.channelHistory && options.channelHistory.length > 0) {
      const historyLines = options.channelHistory.map((msg) => {
        const time = new Date(msg.messageTimestamp).toLocaleTimeString('en-US', {
          hour: '2-digit', minute: '2-digit', hour12: false,
        })
        const label = msg.direction === 'outgoing' ? 'You' : (msg.senderName || 'Unknown')
        const truncated = msg.content.length > 500 ? msg.content.slice(0, 500) + '...' : msg.content
        return `[${time}] ${label}: ${truncated}`
      })
      contextualMessage += `[Recent messages on this channel:\n${historyLines.join('\n')}]\n\n`
    }

    contextualMessage += `[${options.channelType.toUpperCase()} message from ${options.senderName || options.senderId}]

${userMessage}`

    const fullPrompt = `${getObserverSystemPrompt(options.recentTasks)}

---

${contextualMessage}`

    const result = await runCodexExec({
      prompt: fullPrompt,
      model: model ?? null,
      timeoutMs: 60_000,
    })

    if (result.timedOut) {
      log.messaging.warn('Codex observer timeout', { sessionId })
      yield { type: 'timeout', data: {} }
      return
    }

    if (result.exitCode !== 0) {
      throw new Error(`codex exec exited with code ${result.exitCode}`)
    }

    const parsed = extractJsonFromResponse(result.stdout) as { actions?: ObserverAction[] } | null
    const fulcrumPort = getSettings().server?.port ?? 7777
    let executedActions: ObserverAction[] = []
    if (parsed?.actions && Array.isArray(parsed.actions)) {
      await executeObserverActions(parsed.actions, options, sessionId, fulcrumPort)
      executedActions = parsed.actions
    } else {
      log.messaging.debug('Codex observer response was not valid JSON, skipping', {
        sessionId, responsePreview: result.stdout.slice(0, 200),
      })
    }

    yield { type: 'done', data: { actions: executedActions } }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    log.messaging.error('Codex observer error', { sessionId, error: errorMsg })
    yield { type: 'error', data: { message: errorMsg } }
  }
}
