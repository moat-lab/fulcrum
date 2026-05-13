#!/usr/bin/env bun
/*
 * Acceptance #6 probe — server-stamp `from` field.
 *
 * Picks up where probe-d1-task-agent.ts left off: the MCP child has registered
 * `fulcrum-issue-186/main/task-186-d1:mcp` and the exchange is still warm. We
 * try to POST an envelope claiming a fake `from`, with `x-agent-channel-sender`
 * pointing at the MCP child's real registration. Per #153 §Authorization
 * baseline, the exchange must overwrite/reject so that envelopes carry a
 * verifiable `from`. We don't go through claude here — we go straight at the
 * exchange HTTP surface to isolate the server-stamp invariant.
 */
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const RUN_DIR = dirname(fileURLToPath(import.meta.url))
const EXCHANGE_URL = 'http://127.0.0.1:18787'
// The MCP child only lives while claude lives; by the time this probe runs
// the child has been heartbeat-deregistered. Register a fresh stand-in
// mailbox with the same agent_kind=mcp-child so the server-stamp invariant
// can be tested in isolation.
const STAMP_SENDER = `fulcrum-issue-186/main/stamp-probe-${Date.now()}`
const FAKE_FROM = 'fake-attacker-mailbox/main'
const TARGET_MAILBOX = 'fulcrum-task-target-issue-186/main'

const ts = (): string => new Date().toISOString()

async function registerStampSender(): Promise<void> {
  const envelope = {
    msg_id: crypto.randomUUID(),
    from: STAMP_SENDER,
    to: 'exchange/system',
    ts: ts(),
    schema_version: '0.1.0',
    body: {
      kind: 'register.request',
      payload: {
        schema_version: '0.1.0',
        desired_channel_id: STAMP_SENDER,
        capabilities: ['channel.send', 'channel.receive'],
        identity: { agent_kind: 'mcp-child', instance_label: 'issue-186 stamp probe' },
      },
    },
  }
  const res = await fetch(`${EXCHANGE_URL}/v1/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
  })
  if (!res.ok) throw new Error(`stamp sender register failed: ${res.status} ${await res.text()}`)
}

async function attempt(): Promise<{ status: number; body: unknown }> {
  const envelope = {
    msg_id: crypto.randomUUID(),
    // Try to spoof from. Exchange should overwrite/reject.
    from: FAKE_FROM,
    to: TARGET_MAILBOX,
    ts: ts(),
    schema_version: '0.1.0',
    body: {
      kind: 'deliver.message',
      payload: { body_kind: 'spoof-test', payload: { note: 'probe acceptance #6' } },
    },
  }
  const res = await fetch(`${EXCHANGE_URL}/v1/envelope`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-agent-channel-sender': STAMP_SENDER },
    body: JSON.stringify(envelope),
  })
  const text = await res.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: res.status, body }
}

async function drainTarget(): Promise<unknown> {
  const envelope = {
    msg_id: crypto.randomUUID(),
    from: TARGET_MAILBOX,
    to: 'exchange/system',
    ts: ts(),
    schema_version: '0.1.0',
    body: { kind: 'heartbeat.ping', payload: { channel_id: TARGET_MAILBOX, sequence: 2 } },
  }
  const res = await fetch(`${EXCHANGE_URL}/v1/envelope`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-agent-channel-sender': TARGET_MAILBOX },
    body: JSON.stringify(envelope),
  })
  return JSON.parse(await res.text())
}

const writeJson = (name: string, data: unknown): void => {
  writeFileSync(join(RUN_DIR, name), JSON.stringify(data, null, 2) + '\n')
}

// Re-register the target mailbox in case it has been heartbeat-deregistered
// since the main probe ran.
async function reRegisterTarget(): Promise<void> {
  const envelope = {
    msg_id: crypto.randomUUID(),
    from: TARGET_MAILBOX,
    to: 'exchange/system',
    ts: ts(),
    schema_version: '0.1.0',
    body: {
      kind: 'register.request',
      payload: {
        schema_version: '0.1.0',
        desired_channel_id: TARGET_MAILBOX,
        capabilities: ['channel.send', 'channel.receive'],
        identity: { agent_kind: 'observer', instance_label: 'issue-186 stamp target' },
      },
    },
  }
  await fetch(`${EXCHANGE_URL}/v1/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
  })
}

await reRegisterTarget()
await registerStampSender()
console.log(`[probe] registered stamp sender=${STAMP_SENDER}`)
const result = await attempt()
writeJson('13-server-stamp-attempt.json', { stamp_sender: STAMP_SENDER, fake_from_in_envelope: FAKE_FROM, ...result })
console.log(`[probe] spoof attempt -> status=${result.status}`)
const drain = await drainTarget()
writeJson('14-server-stamp-target-drain.json', drain)
console.log('[probe] drain captured')
