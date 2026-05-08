import { Hono } from 'hono'
import { nanoid } from 'nanoid'
import { db, hosts, tasks, terminals } from '../db'
import { eq } from 'drizzle-orm'
import { broadcast } from '../websocket/terminal-ws'
import { getSSHConnectionManager } from '../terminal/ssh-connection-manager'
import type { Host } from '../../../shared/types'
import { isValidPath, isValidUrl } from '../lib/shell-escape'

const app = new Hono()

function toApiResponse(row: typeof hosts.$inferSelect): Host {
  return {
    id: row.id,
    name: row.name,
    hostname: row.hostname,
    port: row.port,
    username: row.username,
    authMethod: row.authMethod as 'key' | 'password',
    privateKeyPath: row.privateKeyPath,
    password: row.password ? '••••••••' : null,
    defaultDirectory: row.defaultDirectory,
    fulcrumUrl: row.fulcrumUrl,
    hostFingerprint: row.hostFingerprint,
    status: row.status as 'unknown' | 'connected' | 'error',
    lastConnectedAt: row.lastConnectedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

// GET /api/hosts - List all hosts
app.get('/', (c) => {
  const allHosts = db.select().from(hosts).all()
  return c.json(allHosts.map(toApiResponse))
})

// GET /api/hosts/:id - Get single host
app.get('/:id', (c) => {
  const host = db.select().from(hosts).where(eq(hosts.id, c.req.param('id'))).get()
  if (!host) {
    return c.json({ error: 'Host not found' }, 404)
  }
  return c.json(toApiResponse(host))
})

// Shared validation for host input fields (used by POST and PATCH)
function validateHostInput(body: {
  privateKeyPath?: string | null
  defaultDirectory?: string | null
  fulcrumUrl?: string | null
}): { ok: true } | { ok: false; error: string } {
  if (body.privateKeyPath) {
    const resolved = body.privateKeyPath.replace(/^~/, process.env.HOME || '')
    if (!resolved.startsWith(process.env.HOME || '') || resolved.includes('..')) {
      return { ok: false, error: 'Private key path must be within home directory' }
    }
    if (!isValidPath(body.privateKeyPath)) {
      return { ok: false, error: 'Private key path contains invalid characters' }
    }
  }
  if (body.defaultDirectory && !isValidPath(body.defaultDirectory)) {
    return { ok: false, error: 'Default directory path contains invalid characters' }
  }
  if (body.fulcrumUrl && !isValidUrl(body.fulcrumUrl)) {
    return { ok: false, error: 'Invalid Fulcrum URL format' }
  }
  return { ok: true }
}

// POST /api/hosts - Create host
app.post('/', async (c) => {
  const body = await c.req.json<{
    name: string
    hostname: string
    port?: number
    username: string
    authMethod?: 'key' | 'password'
    privateKeyPath?: string
    password?: string
    defaultDirectory?: string
    fulcrumUrl?: string
  }>()

  if (!body.name || !body.hostname || !body.username) {
    return c.json({ error: 'name, hostname, and username are required' }, 400)
  }
  if (body.authMethod === 'password' && !body.password) {
    return c.json({ error: 'password is required for password auth' }, 400)
  }

  const validation = validateHostInput(body)
  if (!validation.ok) {
    return c.json({ error: validation.error }, 400)
  }

  const now = new Date().toISOString()
  const id = nanoid()

  db.insert(hosts)
    .values({
      id,
      name: body.name,
      hostname: body.hostname,
      port: body.port ?? 22,
      username: body.username,
      authMethod: body.authMethod ?? 'key',
      privateKeyPath: body.authMethod === 'password' ? null : body.privateKeyPath ?? null,
      password: body.authMethod === 'password' ? body.password ?? null : null,
      defaultDirectory: body.defaultDirectory ?? null,
      fulcrumUrl: body.fulcrumUrl ?? null,
      status: 'unknown',
      createdAt: now,
      updatedAt: now,
    })
    .run()

  broadcast({ type: 'hosts:updated', payload: {} })

  const created = db.select().from(hosts).where(eq(hosts.id, id)).get()!
  return c.json(toApiResponse(created), 201)
})

// PATCH /api/hosts/:id - Update host
app.patch('/:id', async (c) => {
  const id = c.req.param('id')
  const existing = db.select().from(hosts).where(eq(hosts.id, id)).get()
  if (!existing) {
    return c.json({ error: 'Host not found' }, 404)
  }

  const body = await c.req.json<Partial<{
    name: string
    hostname: string
    port: number
    username: string
    authMethod: 'key' | 'password'
    privateKeyPath: string | null
    password: string | null
    defaultDirectory: string | null
    fulcrumUrl: string | null
  }>>()

  const validation = validateHostInput(body)
  if (!validation.ok) {
    return c.json({ error: validation.error }, 400)
  }

  const now = new Date().toISOString()
  const updates: Partial<typeof hosts.$inferInsert> = { updatedAt: now }
  if (body.name !== undefined) updates.name = body.name
  if (body.hostname !== undefined) updates.hostname = body.hostname
  if (body.port !== undefined) updates.port = body.port
  if (body.username !== undefined) updates.username = body.username
  if (body.authMethod !== undefined) updates.authMethod = body.authMethod
  if (body.privateKeyPath !== undefined) updates.privateKeyPath = body.privateKeyPath
  if (body.password !== undefined && body.password !== '••••••••') updates.password = body.password
  if (body.defaultDirectory !== undefined) updates.defaultDirectory = body.defaultDirectory
  if (body.fulcrumUrl !== undefined) updates.fulcrumUrl = body.fulcrumUrl

  if (updates.authMethod === 'key') updates.password = null
  if (updates.authMethod === 'password') updates.privateKeyPath = null

  db.update(hosts)
    .set(updates)
    .where(eq(hosts.id, id))
    .run()

  broadcast({ type: 'hosts:updated', payload: {} })

  const updated = db.select().from(hosts).where(eq(hosts.id, id)).get()!
  return c.json(toApiResponse(updated))
})

// DELETE /api/hosts/:id - Delete host
app.delete('/:id', (c) => {
  const id = c.req.param('id')
  const existing = db.select().from(hosts).where(eq(hosts.id, id)).get()
  if (!existing) {
    return c.json({ error: 'Host not found' }, 404)
  }

  // Clear hostId from associated tasks
  const now = new Date().toISOString()
  db.update(tasks)
    .set({ hostId: null, updatedAt: now })
    .where(eq(tasks.hostId, id))
    .run()

  // Clear hostId from associated terminals
  db.update(terminals)
    .set({ hostId: null, updatedAt: now })
    .where(eq(terminals.hostId, id))
    .run()

  db.delete(hosts).where(eq(hosts.id, id)).run()

  broadcast({ type: 'hosts:updated', payload: {} })

  return c.json({ success: true })
})

// POST /api/hosts/:id/test - Test SSH connection
app.post('/:id/test', async (c) => {
  const id = c.req.param('id')
  const host = db.select().from(hosts).where(eq(hosts.id, id)).get()
  if (!host) {
    return c.json({ error: 'Host not found' }, 404)
  }

  const manager = getSSHConnectionManager()
  let savedFingerprint: string | undefined
  const result = await manager.testConnection({
    host: host.hostname,
    port: host.port,
    username: host.username,
    authMethod: host.authMethod as 'key' | 'password',
    privateKeyPath: host.privateKeyPath ?? undefined,
    password: host.password ?? undefined,
    hostFingerprint: host.hostFingerprint ?? undefined,
    onFirstConnect: (fingerprint) => {
      savedFingerprint = fingerprint
    },
  })

  const now = new Date().toISOString()
  const updates: Record<string, unknown> = {
    status: result.success ? 'connected' : 'error',
    lastConnectedAt: result.success ? now : host.lastConnectedAt,
    updatedAt: now,
  }
  // Save fingerprint on first successful connection (TOFU)
  if (result.success && savedFingerprint && !host.hostFingerprint) {
    updates.hostFingerprint = savedFingerprint
  }
  db.update(hosts)
    .set(updates)
    .where(eq(hosts.id, id))
    .run()

  return c.json({ ...result, fingerprint: savedFingerprint || host.hostFingerprint || undefined })
})

// POST /api/hosts/:id/reset-fingerprint - Clear stored TOFU host key fingerprint
// AND tear down every pooled SSH connection currently attached to this host.
// Without the second step, existing terminals would keep talking to a server
// whose identity we just declared "no longer trusted" — defeats the security
// point of letting the operator reset.
app.post('/:id/reset-fingerprint', (c) => {
  const id = c.req.param('id')
  const host = db.select().from(hosts).where(eq(hosts.id, id)).get()
  if (!host) {
    return c.json({ error: 'Host not found' }, 404)
  }

  const now = new Date().toISOString()
  db.update(hosts)
    .set({ hostFingerprint: null, updatedAt: now })
    .where(eq(hosts.id, id))
    .run()

  const closed = getSSHConnectionManager().destroyForHost({
    host: host.hostname,
    port: host.port,
    username: host.username,
  })

  broadcast({ type: 'hosts:updated', payload: {} })

  return c.json({ success: true, closedConnections: closed })
})

// POST /api/hosts/:id/check-env - Check remote environment readiness
app.post('/:id/check-env', async (c) => {
  const id = c.req.param('id')
  const host = db.select().from(hosts).where(eq(hosts.id, id)).get()
  if (!host) {
    return c.json({ error: 'Host not found' }, 404)
  }

  const manager = getSSHConnectionManager()
  const sshConfig = {
    host: host.hostname,
    port: host.port,
    username: host.username,
    authMethod: host.authMethod as 'key' | 'password',
    privateKeyPath: host.privateKeyPath ?? undefined,
    password: host.password ?? undefined,
    hostFingerprint: host.hostFingerprint ?? undefined,
  }

  // Check each tool's availability via SSH
  const checks: Record<string, { installed: boolean; version?: string; error?: string }> = {}

  const toolChecks = [
    { name: 'dtach', cmd: 'dtach --version 2>&1 | head -1' },
    { name: 'fulcrum', cmd: 'fulcrum --version 2>&1 | head -1' },
    { name: 'claude', cmd: 'claude --version 2>&1 | head -1' },
    { name: 'opencode', cmd: 'opencode version 2>&1 | head -1' },
  ]

  for (const tool of toolChecks) {
    try {
      const output = await manager.execCommand(sshConfig, `which ${tool.name} >/dev/null 2>&1 && ${tool.cmd}`)
      checks[tool.name] = { installed: true, version: output.trim() }
    } catch {
      checks[tool.name] = { installed: false }
    }
  }

  // Check if default directory exists / is writable
  if (host.defaultDirectory) {
    const { shellEscape } = await import('../lib/shell-escape')
    try {
      await manager.execCommand(sshConfig, `test -d ${shellEscape(host.defaultDirectory)} && test -w ${shellEscape(host.defaultDirectory)}`)
      checks['directory'] = { installed: true }
    } catch {
      checks['directory'] = { installed: false, error: `${host.defaultDirectory} not found or not writable` }
    }
  }

  const ready = checks['dtach']?.installed && checks['fulcrum']?.installed &&
    (checks['claude']?.installed || checks['opencode']?.installed)

  return c.json({ checks, ready })
})

export default app
