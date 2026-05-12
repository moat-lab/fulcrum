import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Wire-contract tests for #180 / #153. The exchange protocol package
 * (`@agent-channel/protocol`) ships a typebox JSON Schema; the shapes asserted
 * here mirror that schema. If these drift, the exchange will reject fulcrum's
 * envelopes with `envelope_invalid` / `schema_version_incompatible` at runtime
 * (see acceptance #6 e2e in the PR comment).
 */
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

  test('testExchangeConnection reports ok for the exchange schema_version (0.1.0)', async () => {
    const { _setFetchForTests, testExchangeConnection, EXCHANGE_SCHEMA_VERSION } = await import(
      './channel-heartbeat-service'
    )

    _setFetchForTests((async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      expect(url).toContain('/version')
      return new Response(
        JSON.stringify({ schema_version: EXCHANGE_SCHEMA_VERSION, server_version: '0.1.0' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }) as typeof fetch)

    const result = await testExchangeConnection({ url: 'https://exchange.example.com' })
    expect(result.ok).toBe(true)
    expect(result.schemaVersion).toBe(EXCHANGE_SCHEMA_VERSION)
  })

  test('testExchangeConnection surfaces schema incompatibility instead of silently continuing', async () => {
    const { _setFetchForTests, testExchangeConnection } = await import('./channel-heartbeat-service')

    _setFetchForTests((async () =>
      new Response(JSON.stringify({ schema_version: '99.0.0' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch)

    const result = await testExchangeConnection({ url: 'https://exchange.example.com' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('incompatible')
  })

  test('testExchangeConnection fails fast when URL is empty', async () => {
    const { testExchangeConnection } = await import('./channel-heartbeat-service')
    const result = await testExchangeConnection({ url: '' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('not configured')
  })

  test('registerChannel posts a register.request envelope and parses register.response envelope', async () => {
    const { _setFetchForTests, registerChannel, EXCHANGE_SCHEMA_VERSION } = await import(
      './channel-heartbeat-service'
    )
    const { setFnoxValue, db, terminals } = await Promise.all([
      import('../lib/settings'),
      import('../db'),
      import('../db/schema'),
    ]).then(([s, d, sch]) => ({ setFnoxValue: s.setFnoxValue, db: d.db, terminals: sch.terminals }))

    setFnoxValue('channels.exchange.enabled', true)
    setFnoxValue('channels.exchange.url', 'https://exchange.example.com')
    setFnoxValue('channels.exchange.mailbox', 'fulcrum-test')

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

    const calls: Array<{ url: string; body?: unknown }> = []
    _setFetchForTests((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ url, body })
      if (url.endsWith('/version')) {
        return new Response(JSON.stringify({ schema_version: EXCHANGE_SCHEMA_VERSION }), {
          status: 200,
        })
      }
      if (url.endsWith('/v1/register')) {
        // Spec-correct register.response envelope (snake_case + wrapped body).
        return new Response(
          JSON.stringify({
            msg_id: 'srv-1',
            from: 'exchange/system',
            to: 'fulcrum-test/task-42',
            in_reply_to: body?.msg_id,
            ts: '2026-05-13T05:30:00.000Z',
            schema_version: EXCHANGE_SCHEMA_VERSION,
            body: {
              kind: 'register.response',
              payload: {
                channel_id: 'fulcrum-test/task-42',
                registered_at: '2026-05-13T05:30:00.000Z',
                heartbeat: { interval_seconds: 30, timeout_seconds: 90 },
                delivery_endpoint: 'http://exchange.example.com/v1/envelope',
                schema_version: EXCHANGE_SCHEMA_VERSION,
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response('not found', { status: 404 })
    }) as typeof fetch)

    const result = await registerChannel({ taskId: '42', terminalId })
    expect(result.channelId).toBe('fulcrum-test/task-42')
    expect(result.heartbeat.intervalSeconds).toBe(30)

    // Probe ordering and request envelope shape.
    expect(calls[0]?.url).toContain('/version')
    expect(calls[1]?.url).toContain('/v1/register')
    const registerBody = calls[1]?.body as Record<string, unknown>
    expect(registerBody.schema_version).toBe(EXCHANGE_SCHEMA_VERSION)
    expect(registerBody.from).toBe('fulcrum-test/task-42')
    expect(registerBody.to).toBe('exchange/system')
    expect((registerBody.body as { kind: string }).kind).toBe('register.request')
    const payload = (registerBody.body as { payload: Record<string, unknown> }).payload
    expect(payload.desired_channel_id).toBe('fulcrum-test/task-42')
    expect(payload.capabilities).toEqual(['channel.send', 'channel.receive', 'discovery.list'])
    expect((payload.identity as { agent_kind: string }).agent_kind).toBe('fulcrum-client')
    expect((payload.identity as { instance_label: string }).instance_label).toBe('fulcrum-test')

    // DB row must be updated with the assigned channel_id + timestamp.
    const { eq } = await import('drizzle-orm')
    const row = db.select().from(terminals).where(eq(terminals.id, terminalId)).all()[0]
    expect(row?.channelId).toBe('fulcrum-test/task-42')
    expect(row?.channelRegisteredAt).toBe('2026-05-13T05:30:00.000Z')

    db.delete(terminals).where(eq(terminals.id, terminalId)).run()
  })

  test('registerChannel surfaces incompatible schema_version before issuing /v1/register', async () => {
    const { _setFetchForTests, registerChannel } = await import('./channel-heartbeat-service')
    const { setFnoxValue } = await import('../lib/settings')

    setFnoxValue('channels.exchange.url', 'https://exchange.example.com')
    setFnoxValue('channels.exchange.mailbox', 'fulcrum-test')

    let registerHit = false
    _setFetchForTests((async (input: RequestInfo | URL) => {
      const u = typeof input === 'string' ? input : input.toString()
      if (u.endsWith('/version')) {
        return new Response(JSON.stringify({ schema_version: '99.0.0' }), { status: 200 })
      }
      registerHit = true
      return new Response('{}', { status: 200 })
    }) as typeof fetch)

    await expect(registerChannel({ taskId: '7', terminalId: 'nonexistent' })).rejects.toThrow(
      /incompatible/,
    )
    expect(registerHit).toBe(false)
  })
})
