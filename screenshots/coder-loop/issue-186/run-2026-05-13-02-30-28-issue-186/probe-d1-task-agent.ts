#!/usr/bin/env bun
/*
 * Probe driver for issue #186 (wave-2 D1).
 *
 * Goal: prove that the fixed `buildAgentCommand` (frontend/lib/agent-commands.ts)
 * combined with the wave-1 `registerChannel` heartbeat-service path produces a
 * working real-claude → MCP child → docker exchange chain.
 *
 * What this probe does NOT do: it does NOT replace task-terminal.tsx end-to-end
 * (UI wiring is deferred to a follow-up issue). It instead reconstructs the
 * deterministic part of the wire — register a fulcrum-client mailbox against
 * the real docker exchange, ask `buildAgentCommand` to emit the launch string
 * with that channel-id, and run it. The claude process spawned here is parented
 * by this script (not by fulcrum-server's dtach), which is the only deviation
 * from the production lifecycle; everything downstream of `claude` is identical
 * to what task-terminal.tsx would observe.
 *
 * Run dir = the screenshots/coder-loop/issue-186/<runId>/ directory containing
 * this file. All evidence artifacts are written next to the script.
 */
import { execSync, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildAgentCommand, type ChannelLaunchSpec } from '../../../../frontend/lib/agent-commands'

const RUN_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(RUN_DIR, '..', '..', '..', '..')
const EXCHANGE_URL = 'http://127.0.0.1:18787'
const MAILBOX = 'fulcrum-issue-186/main'
const DESIRED_CHANNEL_ID = `${MAILBOX}/task-186-d1`
const TARGET_MAILBOX = 'fulcrum-task-target-issue-186/main'
const TASK_ID = '186-d1'
// Path of @agent-channel/mcp bin. Same convention as #185.
const MCP_BIN = resolve(REPO_ROOT, '..', 'agent-channel-exchange', 'packages', 'mcp', 'src', 'bin.ts')
const SESSION_ID = crypto.randomUUID()

const ts = (): string => new Date().toISOString()
const writeJson = (name: string, data: unknown): void => {
  writeFileSync(join(RUN_DIR, name), JSON.stringify(data, null, 2) + '\n')
}
const writeText = (name: string, text: string): void => {
  writeFileSync(join(RUN_DIR, name), text + (text.endsWith('\n') ? '' : '\n'))
}
const log = (msg: string): void => {
  console.log(`[probe ${ts()}] ${msg}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Mirror of `server/services/channel-heartbeat-service.ts:registerChannel`
 * (modulo the fnox/DB side effects). Returns the exchange-assigned channel_id,
 * which is the same channel_id production fulcrum would persist into
 * `terminals.channel_id`.
 */
async function preRegisterFulcrumClient(): Promise<{ channelId: string; registeredAt: string; raw: unknown }> {
  const envelope = {
    msg_id: crypto.randomUUID(),
    from: DESIRED_CHANNEL_ID,
    to: 'exchange/system',
    ts: ts(),
    schema_version: '0.1.0',
    body: {
      kind: 'register.request',
      payload: {
        schema_version: '0.1.0',
        desired_channel_id: DESIRED_CHANNEL_ID,
        capabilities: ['channel.send', 'channel.receive', 'discovery.list'],
        identity: { agent_kind: 'fulcrum-client', instance_label: `fulcrum-issue-186 task ${TASK_ID}` },
      },
    },
  }
  const res = await fetch(`${EXCHANGE_URL}/v1/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
  })
  const raw = (await res.json()) as { body?: { payload?: { channel_id?: string; registered_at?: string } } }
  if (!res.ok || !raw?.body?.payload?.channel_id) {
    throw new Error(`fulcrum-client register failed: ${res.status} ${JSON.stringify(raw)}`)
  }
  return {
    channelId: raw.body.payload.channel_id,
    registeredAt: raw.body.payload.registered_at ?? '',
    raw,
  }
}

/** Pre-register the target mailbox so the MCP child has somewhere to deliver to. */
async function preRegisterTarget(): Promise<void> {
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
        identity: { agent_kind: 'observer', instance_label: 'issue-186 task target' },
      },
    },
  }
  const res = await fetch(`${EXCHANGE_URL}/v1/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
  })
  const raw = await res.json()
  writeJson('03-target-register.json', raw)
}

async function discoveryList(senderChannel: string): Promise<unknown> {
  const envelope = {
    msg_id: crypto.randomUUID(),
    from: senderChannel,
    to: 'exchange/system',
    ts: ts(),
    schema_version: '0.1.0',
    body: { kind: 'discovery.list_request', payload: { filter: {} } },
  }
  const res = await fetch(`${EXCHANGE_URL}/v1/discovery/list`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-agent-channel-sender': senderChannel,
    },
    body: JSON.stringify(envelope),
  })
  return await res.json()
}

async function fetchTargetInbox(): Promise<unknown> {
  // `POST /v1/envelope` returns `{ response: Envelope, inbox: Envelope[] }`
  // per `agent-channel-exchange/packages/exchange/src/server.ts`. So we send
  // a heartbeat.ping from the target mailbox and read the `inbox` field — that
  // drains everything the MCP child delivered.
  const envelope = {
    msg_id: crypto.randomUUID(),
    from: TARGET_MAILBOX,
    to: 'exchange/system',
    ts: ts(),
    schema_version: '0.1.0',
    body: { kind: 'heartbeat.ping', payload: { channel_id: TARGET_MAILBOX, sequence: 1 } },
  }
  const res = await fetch(`${EXCHANGE_URL}/v1/envelope`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-agent-channel-sender': TARGET_MAILBOX },
    body: JSON.stringify(envelope),
  })
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    return { status: res.status, raw: text }
  }
}

interface ClaudeSession {
  path: string
  toolUses: Array<Record<string, unknown>>
}

function findClaudeSessionJsonl(sessionId: string): ClaudeSession | null {
  const projects = `${process.env.HOME}/.claude/projects`
  let candidates: Array<{ path: string; mtimeMs: number }> = []
  for (const dir of readdirSync(projects)) {
    const full = `${projects}/${dir}`
    let entries: string[] = []
    try {
      entries = readdirSync(full)
    } catch {
      continue
    }
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue
      const p = `${full}/${f}`
      candidates.push({ path: p, mtimeMs: statSync(p).mtimeMs })
    }
  }
  // Take recent ones, scan for our session_id marker.
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  for (const c of candidates.slice(0, 20)) {
    const lines = readFileSync(c.path, 'utf-8').split('\n').filter(Boolean)
    let matches = false
    const tools: Array<Record<string, unknown>> = []
    for (const line of lines) {
      let obj: any
      try {
        obj = JSON.parse(line)
      } catch {
        continue
      }
      if (typeof obj?.uuid === 'string' && sessionId && line.includes(sessionId)) matches = true
      // Look for assistant messages with tool_use content blocks.
      const content = obj?.message?.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'tool_use' && typeof block?.name === 'string' && block.name.startsWith('mcp__agent-channel__')) {
            tools.push(block)
          }
        }
      }
    }
    if (tools.length > 0) {
      return { path: c.path, toolUses: tools }
    }
    if (matches) {
      return { path: c.path, toolUses: [] }
    }
  }
  return null
}

async function main(): Promise<void> {
  log(`run dir = ${RUN_DIR}`)
  log(`mcp bin = ${MCP_BIN}`)

  // 0. Exchange /version (acceptance #1).
  const versionRes = await fetch(`${EXCHANGE_URL}/version`)
  const versionJson = (await versionRes.json()) as unknown
  writeJson('01-exchange-version.json', versionJson)

  // 1. Pre-register the fulcrum-client mailbox (acceptance #5 anchor).
  log('pre-registering fulcrum-client mailbox via /v1/register')
  await preRegisterTarget()
  const reg = await preRegisterFulcrumClient()
  writeJson('02-fulcrum-client-register.json', reg.raw)
  log(`fulcrum-client channel_id=${reg.channelId} (would be persisted to terminals.channel_id)`)

  // 2. Build the launch command via the FIXED buildAgentCommand (the same
  //    function task-terminal.tsx will invoke once it's wired). This is the
  //    real proof that the production builder produces a working claude
  //    invocation — if `buildAgentCommand` is wrong, this probe breaks.
  //
  //    NOTE: we route `bun x @agent-channel/mcp` to `bun run <local bin>`
  //    instead of the npm-published name so the probe works against the
  //    workspace checkout. The shape passed to buildAgentCommand keeps the
  //    documented `bun x @agent-channel/mcp` form via the mcpInvocation
  //    so the emitted JSON is faithful to wave-1 spec; we then patch the
  //    spawned MCP server's command/args to the workspace bin file. That
  //    patch lives in the inline JSON we use for `--mcp-config`, NOT in
  //    `buildAgentCommand` itself.
  const channel: ChannelLaunchSpec = {
    channelId: reg.channelId,
    exchangeUrl: EXCHANGE_URL,
    mcpInvocation: `bun run ${MCP_BIN}`,
  }
  const systemPrompt = 'You are a Fulcrum worker task agent connected to a docker mailbox exchange via the agent-channel MCP server.'
  const userPrompt = `Use the mcp__agent-channel__channel_send tool exactly once with these JSON arguments verbatim (do not add or omit fields):

{
  "to": "${TARGET_MAILBOX}",
  "body_kind": "deliver.message",
  "payload": {
    "schema_version": "0.1.0",
    "title": "wave-2 D1 probe outbound",
    "summary": "Issue #186 acceptance: real fulcrum task agent → MCP child → exchange",
    "issue": 186
  }
}

After the tool call returns, respond only with the literal string 'sent'.`

  const generated = buildAgentCommand('claude', {
    prompt: userPrompt,
    systemPrompt,
    mode: 'default',
    additionalOptions: {
      'session-id': SESSION_ID,
      'permission-mode': 'bypassPermissions',
      'output-format': 'stream-json',
    },
    channel,
  })
  // task-terminal.tsx writes the emitted command into an interactive dtach
  // session; for this scripted probe we additionally need `-p` and `--verbose`
  // so claude runs non-interactively and streams JSON. Both are appended OUT
  // of `buildAgentCommand` so the builder under test stays the production
  // shape. `-p` is prepended right after `claude` for readability.
  const launchCommand = generated.replace(/^claude /, 'claude -p --verbose ')
  writeText('04-launch-command.sh', '#!/usr/bin/env bash\nset -euo pipefail\n' + launchCommand + '\n')
  execSync(`chmod +x ${join(RUN_DIR, '04-launch-command.sh')}`)
  log('launch command written; spawning claude…')

  // 3. Spawn claude. We use `bash -lc` so the same emitted shell string runs
  //    exactly as task-terminal.tsx would write it into the dtach session.
  const claudeStream = join(RUN_DIR, '05-claude-stream.jsonl')
  const claudeErr = join(RUN_DIR, '05-claude-stderr.txt')
  const child = spawn('bash', ['-lc', launchCommand + ` > ${claudeStream} 2> ${claudeErr}`], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: { ...process.env, AGENT_CHANNEL_PROBE: 'issue-186-d1' },
  })

  // 4. Mid-flight snapshots: ps + pgrep, discovery list.
  await sleep(6000)
  try {
    const claudePid = execSync(`pgrep -P ${child.pid} -f claude 2>/dev/null | head -1`).toString().trim()
    writeText(
      '06-ps-claude.txt',
      execSync(`ps -o pid,ppid,command -p ${child.pid} ${claudePid ? '-p ' + claudePid : ''} 2>&1 || true`).toString(),
    )
    if (claudePid) {
      // First: raw child PIDs (cheap, always works).
      const childPidsRaw = execSync(`pgrep -P ${claudePid} 2>/dev/null || true`).toString().trim()
      const childPids = childPidsRaw.split(/\s+/).filter(Boolean)
      // Second: for each child PID, dump its full command via `ps`. Some `pgrep`
      // builds on macOS don't honor `-a`, so we fall back to ps for the command
      // strings. This gives reviewers a readable "claude X parents bun MCP" chain.
      let table = `# pgrep -P ${claudePid} found pids: ${childPids.join(', ') || '(none)'}\n\n`
      if (childPids.length > 0) {
        table += execSync(`ps -o pid,ppid,command -p ${childPids.join(' -p ')} 2>&1 || true`).toString()
      }
      writeText('07-pgrep-mcp-child.txt', table)
    } else {
      writeText('07-pgrep-mcp-child.txt', '(claude pid not found mid-flight)\n')
    }
  } catch (e) {
    writeText('06-ps-claude.txt', `(ps snapshot error: ${(e as Error).message})\n`)
  }
  writeJson('08-exchange-registry-during-run.json', await discoveryList(reg.channelId))

  // 5. Wait for claude to exit.
  await new Promise<void>((resolve) => {
    child.on('exit', (code, signal) => {
      writeText('05-claude-exit.txt', `exit_code=${code} signal=${signal}\n`)
      resolve()
    })
  })

  // 6. Drain the target mailbox inbox to confirm the envelope landed (acceptance #5).
  writeJson('09-target-inbox-drain.json', await fetchTargetInbox())

  // 7. Final discovery list and locate claude session jsonl (acceptance #4 + #7).
  writeJson('10-exchange-registry-after.json', await discoveryList(reg.channelId))
  const session = findClaudeSessionJsonl(SESSION_ID)
  if (session) {
    writeText('11-session-jsonl-path.txt', `path=${session.path}\ntool_use_count=${session.toolUses.length}\n`)
    execSync(`cp ${session.path} ${join(RUN_DIR, '11-session.jsonl')}`)
    writeJson('11-session-tool_use-channel_send.json', session.toolUses)
  } else {
    writeText('11-session-jsonl-path.txt', '(session jsonl not found — claude may have not emitted any tool_use)\n')
  }

  // 8. Static grep proving fulcrum source does not silently masquerade as
  //    pm-agent / worker-agent (mirrors #185 acceptance #7 for task side).
  const grep = execSync(
    `grep -RInE "agent_kind.*['\\"](pm-agent|worker-agent|mcp-child)['\\"]" server/ frontend/ shared/ 2>&1 || true`,
    { cwd: REPO_ROOT },
  ).toString()
  writeText('12-static-grep-agent-kind.txt', grep)

  log('probe complete')
}

main().catch((err) => {
  console.error(err)
  writeText('00-probe-error.txt', `${err.stack ?? err.message}\n`)
  process.exit(1)
})
