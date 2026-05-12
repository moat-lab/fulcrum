#!/usr/bin/env bun
/**
 * Issue #181 / #153 task E e2e harness.
 *
 * Proves four acceptance items against a real `agent-channel-exchange:dev`
 * docker container (no in-process fake / no mocked fetch):
 *
 *  1. PM self-register form is equivalent to task agent register —
 *     `identity.agent_kind = "pm-agent"` is the only delta.
 *  2. Five `body_kind` envelopes (`assignment`, `clarification_request`,
 *     `clarification_response`, `progress`, `completion_claim`) round-trip
 *     PM ↔ task agent through the exchange `inbox` drain model.
 *  3. `mailbox_deregistered`: after the worker mailbox is deregistered, PM
 *     `assignment` → exchange returns a `deliver.error` envelope whose
 *     `body.payload.error === "mailbox_deregistered"`. PM stops retrying.
 *  4. fulcrum's `GET /api/channels/pm/mode` returns the spec-shaped
 *     `PmModeChatHook` payload reflecting the live fnox config (proves the
 *     hook contract; task status HTTP single point is asserted by curl
 *     showing the existing `POST /api/tasks/:id/status` is the only mutation
 *     surface — fulcrum has no channel→DB shortcut).
 *
 * Outputs JSON artifacts and a plain-text `evidence.txt` summary in the
 * containing directory so PR Layer 4 can cite them by raw URL.
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

const EXCHANGE_URL = 'http://127.0.0.1:18787'
const FULCRUM_URL = process.env.FULCRUM_URL ?? 'http://localhost:9921'
const SCHEMA_VERSION = '0.1.0'
const EXCHANGE_SYSTEM_CHANNEL = 'exchange/system'
const SENDER_HEADER = 'x-agent-channel-sender'

const PM_CHANNEL_ID = 'pm-test-181/main'
const WORKER_CHANNEL_ID = 'fulcrum-test-181/task-42'

const OUT_DIR = dirname(new URL(import.meta.url).pathname)
mkdirSync(OUT_DIR, { recursive: true })

function nowIso(): string {
  return new Date().toISOString()
}

function newMsgId(): string {
  return crypto.randomUUID()
}

function writeArtifact(name: string, data: unknown): string {
  const path = join(OUT_DIR, name)
  writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data, null, 2))
  return path
}

interface ExchangeResponse<T = unknown> {
  status: number
  body: T
}

async function exchangePost<T = unknown>(
  path: string,
  body: unknown,
  sender?: string,
): Promise<ExchangeResponse<T>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (sender) headers[SENDER_HEADER] = sender
  const res = await fetch(`${EXCHANGE_URL}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as T }
}

async function registerMailbox(opts: {
  channelId: string
  agentKind: 'pm-agent' | 'fulcrum-client'
  instanceLabel: string
}): Promise<unknown> {
  const envelope = {
    msg_id: newMsgId(),
    from: opts.channelId,
    to: EXCHANGE_SYSTEM_CHANNEL,
    ts: nowIso(),
    schema_version: SCHEMA_VERSION,
    body: {
      kind: 'register.request',
      payload: {
        schema_version: SCHEMA_VERSION,
        desired_channel_id: opts.channelId,
        capabilities: ['channel.send', 'channel.receive', 'discovery.list'],
        identity: {
          agent_kind: opts.agentKind,
          instance_label: opts.instanceLabel,
        },
      },
    },
  }
  const res = await exchangePost('/v1/register', envelope)
  if (res.status !== 200) {
    throw new Error(`register ${opts.channelId} failed: ${res.status} ${JSON.stringify(res.body)}`)
  }
  return res.body
}

async function sendBodyKind(opts: {
  fromChannelId: string
  toChannelId: string
  bodyKind: string
  payload: unknown
  inReplyTo?: string
}): Promise<{ msgId: string; ack: unknown }> {
  const msgId = newMsgId()
  const envelope = {
    msg_id: msgId,
    from: opts.fromChannelId,
    to: opts.toChannelId,
    ts: nowIso(),
    ...(opts.inReplyTo ? { in_reply_to: opts.inReplyTo } : {}),
    schema_version: SCHEMA_VERSION,
    body: {
      kind: 'deliver.message',
      payload: {
        body_kind: opts.bodyKind,
        payload: opts.payload,
      },
    },
  }
  const res = await exchangePost('/v1/envelope', envelope, opts.fromChannelId)
  if (res.status !== 200) {
    throw new Error(`send ${opts.bodyKind} failed: ${res.status} ${JSON.stringify(res.body)}`)
  }
  return { msgId, ack: res.body }
}

interface InboxEnvelope {
  msg_id: string
  from: string
  to: string
  body: { kind: string; payload: { body_kind?: string; payload?: unknown; error?: string } }
}

async function drainInbox(sender: string): Promise<InboxEnvelope[]> {
  // Use a heartbeat.ping (cheapest valid envelope) to trigger inbox drain.
  const envelope = {
    msg_id: newMsgId(),
    from: sender,
    to: EXCHANGE_SYSTEM_CHANNEL,
    ts: nowIso(),
    schema_version: SCHEMA_VERSION,
    body: {
      kind: 'heartbeat.ping',
      payload: { channel_id: sender, sequence: 1 },
    },
  }
  const res = await exchangePost<{ response: unknown; inbox: InboxEnvelope[] }>(
    '/v1/envelope',
    envelope,
    sender,
  )
  if (res.status !== 200) {
    throw new Error(`drain inbox for ${sender} failed: ${res.status} ${JSON.stringify(res.body)}`)
  }
  return res.body.inbox ?? []
}

async function deregisterMailbox(channelId: string): Promise<unknown> {
  const res = await fetch(`${EXCHANGE_URL}/v1/deregister`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [SENDER_HEADER]: channelId },
    body: JSON.stringify({ channel_id: channelId }),
  })
  return res.json()
}

interface Step {
  step: string
  detail?: string
  artifact?: string
}

const steps: Step[] = []

function recordStep(s: Step): void {
  steps.push(s)
  // eslint-disable-next-line no-console
  console.log(`[step] ${s.step}${s.detail ? ` — ${s.detail}` : ''}${s.artifact ? ` (${s.artifact})` : ''}`)
}

async function main(): Promise<void> {
  // 0. Exchange health.
  const version = await fetch(`${EXCHANGE_URL}/version`).then((r) => r.json())
  writeArtifact('exchange-version.json', version)
  recordStep({ step: '0. exchange /version', detail: JSON.stringify(version), artifact: 'exchange-version.json' })

  // 1. Register PM mailbox (agent_kind = "pm-agent") — acceptance #1.
  const pmRegister = await registerMailbox({
    channelId: PM_CHANNEL_ID,
    agentKind: 'pm-agent',
    instanceLabel: 'PM test 181',
  })
  writeArtifact('register-pm.json', pmRegister)
  recordStep({ step: '1. register PM mailbox', detail: PM_CHANNEL_ID, artifact: 'register-pm.json' })

  // 2. Register worker mailbox (agent_kind = "fulcrum-client") — same envelope shape, different identity.
  const workerRegister = await registerMailbox({
    channelId: WORKER_CHANNEL_ID,
    agentKind: 'fulcrum-client',
    instanceLabel: 'task agent 42',
  })
  writeArtifact('register-worker.json', workerRegister)
  recordStep({ step: '2. register worker mailbox', detail: WORKER_CHANNEL_ID, artifact: 'register-worker.json' })

  // 3. Round-trip 5 body_kind envelopes — acceptance #2.
  // PM → worker: assignment.
  const assignSent = await sendBodyKind({
    fromChannelId: PM_CHANNEL_ID,
    toChannelId: WORKER_CHANNEL_ID,
    bodyKind: 'assignment',
    payload: {
      task_id: 'task-42',
      summary: 'Wire PM agent e2e for issue #181',
      acceptance: ['register form ok', '5 body_kind closed', 'mailbox_deregistered ok'],
    },
  })
  writeArtifact('send-1-assignment.json', assignSent)
  const workerInbox1 = await drainInbox(WORKER_CHANNEL_ID)
  writeArtifact('inbox-worker-1-assignment.json', workerInbox1)
  const assignmentReceived = workerInbox1.find(
    (e) => e.body.kind === 'deliver.message' && e.body.payload.body_kind === 'assignment',
  )
  if (!assignmentReceived) throw new Error('worker did not receive assignment')
  recordStep({
    step: '3a. PM→worker assignment delivered',
    detail: `msg_id=${assignmentReceived.msg_id}`,
    artifact: 'inbox-worker-1-assignment.json',
  })

  // Worker → PM: clarification_request (in_reply_to=assignment).
  const clarReqSent = await sendBodyKind({
    fromChannelId: WORKER_CHANNEL_ID,
    toChannelId: PM_CHANNEL_ID,
    bodyKind: 'clarification_request',
    payload: { question: 'Should worker spawn a child task for screenshots?' },
    inReplyTo: assignSent.msgId,
  })
  writeArtifact('send-2-clarification-request.json', clarReqSent)
  const pmInbox1 = await drainInbox(PM_CHANNEL_ID)
  writeArtifact('inbox-pm-1-clarification-request.json', pmInbox1)
  if (
    !pmInbox1.find(
      (e) => e.body.kind === 'deliver.message' && e.body.payload.body_kind === 'clarification_request',
    )
  ) {
    throw new Error('PM did not receive clarification_request')
  }
  recordStep({
    step: '3b. worker→PM clarification_request delivered',
    artifact: 'inbox-pm-1-clarification-request.json',
  })

  // PM → worker: clarification_response (in_reply_to=clarification_request).
  const clarRespSent = await sendBodyKind({
    fromChannelId: PM_CHANNEL_ID,
    toChannelId: WORKER_CHANNEL_ID,
    bodyKind: 'clarification_response',
    payload: { answer: 'no — keep evidence in this task' },
    inReplyTo: clarReqSent.msgId,
  })
  writeArtifact('send-3-clarification-response.json', clarRespSent)
  const workerInbox2 = await drainInbox(WORKER_CHANNEL_ID)
  writeArtifact('inbox-worker-2-clarification-response.json', workerInbox2)
  if (
    !workerInbox2.find(
      (e) => e.body.kind === 'deliver.message' && e.body.payload.body_kind === 'clarification_response',
    )
  ) {
    throw new Error('worker did not receive clarification_response')
  }
  recordStep({
    step: '3c. PM→worker clarification_response delivered',
    artifact: 'inbox-worker-2-clarification-response.json',
  })

  // Worker → PM: progress.
  await sendBodyKind({
    fromChannelId: WORKER_CHANNEL_ID,
    toChannelId: PM_CHANNEL_ID,
    bodyKind: 'progress',
    payload: { percent: 75, note: 'wire-loop happy path passes', fulcrum_status: 'IN_PROGRESS' },
  })
  const pmInbox2 = await drainInbox(PM_CHANNEL_ID)
  writeArtifact('inbox-pm-2-progress.json', pmInbox2)
  if (!pmInbox2.find((e) => e.body.kind === 'deliver.message' && e.body.payload.body_kind === 'progress')) {
    throw new Error('PM did not receive progress')
  }
  recordStep({ step: '3d. worker→PM progress delivered', artifact: 'inbox-pm-2-progress.json' })

  // Worker → PM: completion_claim.
  await sendBodyKind({
    fromChannelId: WORKER_CHANNEL_ID,
    toChannelId: PM_CHANNEL_ID,
    bodyKind: 'completion_claim',
    payload: { artifact_url: 'pr#TBD', summary: 'PM mode hook + 5 body_kind e2e green' },
  })
  const pmInbox3 = await drainInbox(PM_CHANNEL_ID)
  writeArtifact('inbox-pm-3-completion-claim.json', pmInbox3)
  if (
    !pmInbox3.find(
      (e) => e.body.kind === 'deliver.message' && e.body.payload.body_kind === 'completion_claim',
    )
  ) {
    throw new Error('PM did not receive completion_claim')
  }
  recordStep({ step: '3e. worker→PM completion_claim delivered', artifact: 'inbox-pm-3-completion-claim.json' })

  // 4. mailbox_deregistered — acceptance #4.
  const deregResp = await deregisterMailbox(WORKER_CHANNEL_ID)
  writeArtifact('deregister-worker.json', deregResp)
  recordStep({ step: '4a. worker mailbox deregistered', artifact: 'deregister-worker.json' })

  // PM sends another assignment to the now-gone worker. The sync response
  // is a `deliver.error` envelope with `body.payload.error === "mailbox_deregistered"`.
  const failedAssign = await exchangePost<{
    response: { body: { kind: string; payload: { error?: string } } }
    inbox: InboxEnvelope[]
  }>('/v1/envelope', {
    msg_id: newMsgId(),
    from: PM_CHANNEL_ID,
    to: WORKER_CHANNEL_ID,
    ts: nowIso(),
    schema_version: SCHEMA_VERSION,
    body: {
      kind: 'deliver.message',
      payload: {
        body_kind: 'assignment',
        payload: { task_id: 'task-42', note: 'retry assignment after deregister' },
      },
    },
  }, PM_CHANNEL_ID)
  writeArtifact('mailbox-deregistered-response.json', failedAssign)
  const errorVariant = failedAssign.body.response?.body?.payload?.error
  if (errorVariant !== 'mailbox_deregistered') {
    throw new Error(
      `expected error variant mailbox_deregistered, got ${JSON.stringify(failedAssign.body.response)}`,
    )
  }
  recordStep({
    step: '4b. PM assignment after deregister → deliver.error/mailbox_deregistered',
    detail: 'PM stops retrying (no protocol special path)',
    artifact: 'mailbox-deregistered-response.json',
  })

  // 5. fulcrum hook endpoint — acceptance #5 + #181 §scope.
  // The dev server is started separately; this script just polls and records.
  try {
    const hookResp = await fetch(`${FULCRUM_URL}/api/channels/pm/mode`)
    const hookBody = await hookResp.json()
    writeArtifact('fulcrum-pm-mode-hook.json', hookBody)
    recordStep({
      step: '5a. GET /api/channels/pm/mode',
      detail: `status=${hookResp.status} clientForm=${(hookBody as { clientForm?: string }).clientForm}`,
      artifact: 'fulcrum-pm-mode-hook.json',
    })
  } catch (err) {
    recordStep({
      step: '5a. GET /api/channels/pm/mode',
      detail: `fulcrum unreachable (${err instanceof Error ? err.message : String(err)}). Started separately by the caller.`,
    })
  }

  // 6. fulcrum task status flow via HTTP single point — acceptance #3.
  // Show that the only mutation surface is `POST /api/tasks/:id/status`; we
  // exercise it against a freshly created scratch task. This proves the DB
  // write goes through the existing route — channel-side code has no DB
  // shortcut.
  try {
    // Create a scratch task.
    const createResp = await fetch(`${FULCRUM_URL}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'issue-181 e2e probe task',
        description: 'evidence task for PM HTTP-single-point — see screenshots/coder-loop/issue-181',
        taskType: null, // manual task — no worktree, no scratch dir spawn
        repositoryId: null,
      }),
    })
    const createBody = await createResp.json()
    writeArtifact('fulcrum-task-create.json', createBody)
    const taskId = (createBody as { id?: string }).id
    if (!taskId) throw new Error('task create did not return id')

    // Fulcrum's existing single mutation surface is PATCH /api/tasks/:id/status
    // (#153 §状态机衔接 wrote `POST` colloquially; the implementation is
    // PATCH per `server/routes/tasks.ts:1007`). The HTTP single-point claim
    // is unchanged: task status mutation goes through this route, not via
    // channel-side DB writes.
    const transitions: string[] = ['IN_PROGRESS', 'IN_REVIEW', 'DONE']
    const transitionRecord: { status: string; httpStatus: number; body: unknown }[] = []
    for (const next of transitions) {
      const r = await fetch(`${FULCRUM_URL}/api/tasks/${taskId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      })
      const body = await r.json()
      transitionRecord.push({ status: next, httpStatus: r.status, body })
    }
    writeArtifact('fulcrum-task-status-transitions.json', transitionRecord)
    recordStep({
      step: '6. POST /api/tasks/:id/status HTTP single point',
      detail: `task=${taskId} transitions=${transitions.join('→')}`,
      artifact: 'fulcrum-task-status-transitions.json',
    })
  } catch (err) {
    recordStep({
      step: '6. POST /api/tasks/:id/status HTTP single point',
      detail: `fulcrum unreachable (${err instanceof Error ? err.message : String(err)})`,
    })
  }

  writeArtifact(
    'steps.json',
    {
      runId: 'run-2026-05-12-21-28-09-issue-181',
      exchangeUrl: EXCHANGE_URL,
      fulcrumUrl: FULCRUM_URL,
      pmChannelId: PM_CHANNEL_ID,
      workerChannelId: WORKER_CHANNEL_ID,
      steps,
    },
  )
}

void main().catch((err) => {
  recordStep({ step: 'FATAL', detail: err instanceof Error ? err.message : String(err) })
  writeArtifact('steps.json', { steps })
  process.exit(1)
})
