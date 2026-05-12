import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('channel-heartbeat-service (#180)', () => {
  let tempDir: string
  let originalEnv: Record<string, string | undefined>

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'fulcrum-channel-svc-test-'))
    originalEnv = { FULCRUM_DIR: process.env.FULCRUM_DIR }
    process.env.FULCRUM_DIR = tempDir
    const { clearFnoxCache } = await import('../lib/settings')
    clearFnoxCache()
    const { _resetForTests, _setFetchForTests } = await import('./channel-heartbeat-service')
    _resetForTests()
    _setFetchForTests(null)
  })

  afterEach(async () => {
    const { _setFetchForTests, _resetForTests } = await import('./channel-heartbeat-service')
    _setFetchForTests(null)
    _resetForTests()
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('testExchangeConnection reports ok for compatible schema_version', async () => {
    const { _setFetchForTests, testExchangeConnection } = await import('./channel-heartbeat-service')

    _setFetchForTests((async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      expect(url).toContain('/version')
      return new Response(JSON.stringify({ schemaVersion: '1.4' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch)

    const result = await testExchangeConnection({
      url: 'https://exchange.example.com',
      token: 'tok',
    })
    expect(result.ok).toBe(true)
    expect(result.schemaVersion).toBe('1.4')
  })

  test('testExchangeConnection surfaces schema incompatibility instead of silently continuing', async () => {
    const { _setFetchForTests, testExchangeConnection } = await import('./channel-heartbeat-service')

    _setFetchForTests((async () =>
      new Response(JSON.stringify({ schemaVersion: '2.0' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch)

    const result = await testExchangeConnection({
      url: 'https://exchange.example.com',
      token: '',
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('incompatible')
  })

  test('testExchangeConnection fails fast when URL is empty', async () => {
    const { testExchangeConnection } = await import('./channel-heartbeat-service')
    const result = await testExchangeConnection({ url: '', token: '' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('not configured')
  })

  test('registerChannel probes /version before POST /v1/register and writes channelId to DB', async () => {
    const { _setFetchForTests, registerChannel } = await import('./channel-heartbeat-service')
    const { setFnoxValue, db, terminals } = await Promise.all([
      import('../lib/settings'),
      import('../db'),
      import('../db/schema'),
    ]).then(([s, d, sch]) => ({ setFnoxValue: s.setFnoxValue, db: d.db, terminals: sch.terminals }))

    setFnoxValue('channels.exchange.enabled', true)
    setFnoxValue('channels.exchange.url', 'https://exchange.example.com')
    setFnoxValue('channels.exchange.token', 'tok')
    setFnoxValue('channels.exchange.mailbox', 'fulcrum-test')

    // Seed a terminal row so the channel id can be persisted onto it.
    const terminalId = 'term-180-test'
    const now = new Date().toISOString()
    db.insert(terminals)
      .values({
        id: terminalId,
        name: 'task-42',
        cwd: '/tmp',
        tmuxSession: 'fulcrum-test',
        status: 'running',
        createdAt: now,
        updatedAt: now,
      })
      .run()

    const calls: string[] = []
    _setFetchForTests((async (input: RequestInfo | URL) => {
      const u = typeof input === 'string' ? input : input.toString()
      calls.push(u)
      if (u.endsWith('/version')) {
        return new Response(JSON.stringify({ schemaVersion: '1.0' }), { status: 200 })
      }
      if (u.endsWith('/v1/register')) {
        return new Response(
          JSON.stringify({
            channelId: 'fulcrum-test/task-42',
            registeredAt: '2026-05-12T20:30:00Z',
            heartbeat: { intervalSeconds: 30, timeoutSeconds: 90 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response('not found', { status: 404 })
    }) as typeof fetch)

    const result = await registerChannel({ taskId: '42', terminalId })
    expect(result.channelId).toBe('fulcrum-test/task-42')
    expect(result.heartbeat.intervalSeconds).toBe(30)
    // Version probe must precede /v1/register
    expect(calls[0]).toContain('/version')
    expect(calls[1]).toContain('/v1/register')

    // DB row must be updated with the assigned channel_id + timestamp
    const { eq } = await import('drizzle-orm')
    const row = db.select().from(terminals).where(eq(terminals.id, terminalId)).all()[0]
    expect(row?.channelId).toBe('fulcrum-test/task-42')
    expect(row?.channelRegisteredAt).toBe('2026-05-12T20:30:00Z')

    // Clean up the row so test isolation holds.
    db.delete(terminals).where(eq(terminals.id, terminalId)).run()
  })

  test('registerChannel surfaces incompatible schema_version before issuing /v1/register', async () => {
    const { _setFetchForTests, registerChannel } = await import('./channel-heartbeat-service')
    const { setFnoxValue } = await import('../lib/settings')

    setFnoxValue('channels.exchange.url', 'https://exchange.example.com')
    setFnoxValue('channels.exchange.token', 'tok')
    setFnoxValue('channels.exchange.mailbox', 'fulcrum-test')

    let registerHit = false
    _setFetchForTests((async (input: RequestInfo | URL) => {
      const u = typeof input === 'string' ? input : input.toString()
      if (u.endsWith('/version')) {
        return new Response(JSON.stringify({ schemaVersion: '99.0' }), { status: 200 })
      }
      registerHit = true
      return new Response('{}', { status: 200 })
    }) as typeof fetch)

    await expect(registerChannel({ taskId: '7', terminalId: 'nonexistent' })).rejects.toThrow(/incompatible/)
    expect(registerHit).toBe(false)
  })
})
