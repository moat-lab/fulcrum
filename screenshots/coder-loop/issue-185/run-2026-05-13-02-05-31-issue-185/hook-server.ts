/**
 * Long-running Hono server that mounts production `channelRoutes` exactly as
 * fulcrum does, so external launchers (and curl probes) can hit
 * `GET /api/channels/pm/mode` against the real handler. This complements
 * `probe-pm-mode-hook.ts` (which is a single-shot smoke that exits after one
 * curl); this server stays up for the entire D2 E2E run.
 *
 * Mounted scope is intentionally narrow (only `channelRoutes`) so the boot
 * surface is small and the response can only come from the production
 * `readPmModeHook()` path under test.
 */

import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'fulcrum-185-hook-'))
process.env.FULCRUM_DIR = dir
console.log(`[hook-server] FULCRUM_DIR=${dir}`)

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
serve({ fetch: app.fetch, port })
console.log(`[hook-server] listening on http://127.0.0.1:${port}/api/channels/pm/mode`)
