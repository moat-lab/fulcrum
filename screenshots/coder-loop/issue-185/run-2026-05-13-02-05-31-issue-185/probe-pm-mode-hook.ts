/**
 * Probe `GET /api/channels/pm/mode` from a real Hono server mounting the
 * production `channelRoutes` (issue #185 acceptance #2).
 *
 * Why a focused script instead of `mise run up`: we want the curl path
 * (network request → Hono handler → `readPmModeHook()` → JSON response)
 * with deterministic fnox state, but the full fulcrum daemon would boot
 * PR monitor, metrics collector, message channels, etc. — all unrelated
 * to this acceptance row. This script mounts only `channelRoutes` so the
 * shape verification stays isolated.
 *
 * Output is captured to stdout (PR evidence).
 */

import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'fulcrum-185-probe-'))
process.env.FULCRUM_DIR = dir
console.log(`[probe] FULCRUM_DIR=${dir}`)

const settings = await import('../../../../server/lib/settings')
settings.ensureFnoxBootstrap()
settings.initFnoxConfig()
const { setFnoxValue } = settings

setFnoxValue('channels.exchange.enabled', true)
setFnoxValue('channels.exchange.url', 'http://127.0.0.1:18787')
setFnoxValue('channels.exchange.mailbox', 'fulcrum-issue-185-host')
setFnoxValue('channels.exchange.mcpGitRef', 'workspace-local')
setFnoxValue('channels.exchange.token', '')
setFnoxValue('channels.pm.enabled', true)
setFnoxValue('channels.pm.clientForm', 'claude-mcp')
setFnoxValue('channels.pm.mailbox', 'pm-issue-185/main')
setFnoxValue('channels.pm.systemPromptRef', 'fnox:pm.systemPrompt')

const { default: channelRoutes } = await import('../../../../server/routes/channels')

const app = new Hono()
app.route('/api/channels', channelRoutes)

const port = 19185
const server = serve({ fetch: app.fetch, port })
console.log(`[probe] listening on http://127.0.0.1:${port}`)

await new Promise((r) => setTimeout(r, 250))

const res = await fetch(`http://127.0.0.1:${port}/api/channels/pm/mode`)
const text = await res.text()
console.log('[probe] HTTP', res.status)
console.log('[probe] body:', text)

const json = JSON.parse(text)
const flat = JSON.stringify(json)
const tokenLeaked =
  /"token"\s*:/.test(flat) ||
  /"bearerToken"\s*:/.test(flat) ||
  /"bearer"\s*:/.test(flat)
console.log('[probe] token leak check:', tokenLeaked ? 'LEAKED' : 'clean')

console.log(
  '[probe] shape check:',
  JSON.stringify({
    enabled: typeof json.enabled === 'boolean',
    clientForm: json.clientForm === 'claude-mcp',
    mailbox: typeof json.mailbox === 'string' && json.mailbox.length > 0,
    systemPromptRef: typeof json.systemPromptRef === 'string',
    'exchange.url': typeof json.exchange?.url === 'string' && json.exchange.url.length > 0,
    'exchange.mailboxNamespace':
      typeof json.exchange?.mailboxNamespace === 'string' && json.exchange.mailboxNamespace.length > 0,
    'exchange.token absent': !('token' in (json.exchange ?? {})),
  }),
)

;(server as { close: () => void }).close()
process.exit(tokenLeaked ? 2 : 0)
