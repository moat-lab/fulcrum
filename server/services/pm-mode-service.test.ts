import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Unit tests for PM Agent Mode hook + mailbox poller (#181 / #153 §Chat 启动 UX hook).
 *
 * Covers the two acceptance surfaces fulcrum owns:
 *
 *  1. `readPmModeHook()` shape parity with the spec — `enabled`, `clientForm`
 *     (default `claude-mcp` when unset / invalid), `mailbox`, `systemPromptRef`,
 *     `exchange.url`, `exchange.mailboxNamespace`, no token leak.
 *  2. `pollPmMailboxes()` discovery wire contract — envelope is
 *     `discovery.list_request` with `filter.agent_kind = ["pm-agent"]`, schema
 *     version matches the exchange, sender header is set, response envelope
 *     is decoded into the `PmMailboxDescriptor[]` snapshot, error states are
 *     surfaced through `lastError`.
 */
describe('pm-mode-service (#181)', () => {
  let tempDir: string
  let originalEnv: Record<string, string | undefined>

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'fulcrum-pm-mode-test-'))
    originalEnv = { FULCRUM_DIR: process.env.FULCRUM_DIR }
    process.env.FULCRUM_DIR = tempDir
    const { clearFnoxCache } = await import('../lib/settings')
    clearFnoxCache()
    const { _resetForTests, _setFetchForTests } = await import('./pm-mode-service')
    _resetForTests()
    _setFetchForTests(null)
  })

  afterEach(async () => {
    const { _setFetchForTests, _resetForTests } = await import('./pm-mode-service')
    _setFetchForTests(null)
    _resetForTests()
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('readPmModeHook returns spec-shaped defaults when no fnox values are set', async () => {
    const { readPmModeHook } = await import('./pm-mode-service')
    const hook = readPmModeHook()
    expect(hook.enabled).toBe(false)
    expect(hook.clientForm).toBe('claude-mcp')
    expect(hook.mailbox).toBe('')
    expect(hook.systemPromptRef).toBe('')
    expect(hook.exchange.url).toBe('')
    expect(hook.exchange.mailboxNamespace).toBe('')
    // Token is not in the shape per #153 §824 — guard against accidental leak.
    expect('token' in (hook.exchange as Record<string, unknown>)).toBe(false)
  })

  test('readPmModeHook reflects configured values and falls back to claude-mcp on invalid clientForm', async () => {
    const { setFnoxValue } = await import('../lib/settings')
    const { readPmModeHook } = await import('./pm-mode-service')

    setFnoxValue('channels.pm.enabled', true)
    setFnoxValue('channels.pm.clientForm', 'external-http')
    setFnoxValue('channels.pm.mailbox', 'pm-mouriya/main')
    setFnoxValue('channels.pm.systemPromptRef', 'fnox:pm.systemPrompt')
    setFnoxValue('channels.exchange.url', 'https://exchange.example.com')
    setFnoxValue('channels.exchange.mailbox', 'fulcrum-mouriya-laptop')

    const hook = readPmModeHook()
    expect(hook.enabled).toBe(true)
    expect(hook.clientForm).toBe('external-http')
    expect(hook.mailbox).toBe('pm-mouriya/main')
    expect(hook.systemPromptRef).toBe('fnox:pm.systemPrompt')
    expect(hook.exchange.url).toBe('https://exchange.example.com')
    expect(hook.exchange.mailboxNamespace).toBe('fulcrum-mouriya-laptop')

    // Invalid clientForm string must fall back; the chat surface depends on
    // exactly two literals, so any drift here would crash the consumer.
    setFnoxValue('channels.pm.clientForm', 'not-a-real-form')
    const hook2 = readPmModeHook()
    expect(hook2.clientForm).toBe('claude-mcp')
  })

  test('pollPmMailboxes posts a discovery.list_request envelope with filter agent_kind=["pm-agent"]', async () => {
    const { setFnoxValue } = await import('../lib/settings')
    const { _setFetchForTests, pollPmMailboxes } = await import('./pm-mode-service')
    const { EXCHANGE_SCHEMA_VERSION } = await import('./channel-heartbeat-service')

    setFnoxValue('channels.pm.enabled', true)
    setFnoxValue('channels.exchange.url', 'https://exchange.example.com')
    setFnoxValue('channels.exchange.mailbox', 'fulcrum-test')

    let capturedRequestBody: unknown = null
    let capturedSender: string | null = null
    let observedRegister = false

    _setFetchForTests((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/v1/register')) {
        // The poller registers itself once before the first discovery sweep.
        observedRegister = true
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      expect(url).toContain('/v1/discovery/list')
      capturedSender =
        init?.headers && typeof init.headers === 'object'
          ? ((init.headers as Record<string, string>)['x-agent-channel-sender'] ?? null)
          : null
      capturedRequestBody = init?.body ? JSON.parse(init.body as string) : null

      const responseEnvelope = {
        msg_id: 'msg-resp',
        from: 'exchange/system',
        to: 'fulcrum-test/pm-mode-poller',
        ts: new Date().toISOString(),
        schema_version: EXCHANGE_SCHEMA_VERSION,
        body: {
          kind: 'discovery.list_response',
          payload: {
            schema_version: EXCHANGE_SCHEMA_VERSION,
            generated_at: '2026-05-13T00:00:00.000Z',
            channels: [
              {
                channel_id: 'pm-mouriya/main',
                agent_kind: 'pm-agent',
                instance_label: 'Mouriya PM',
                registered_at: '2026-05-13T00:00:00.000Z',
                capabilities: ['channel.send'],
              },
            ],
          },
        },
      }
      return new Response(JSON.stringify(responseEnvelope), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch)

    const snap = await pollPmMailboxes()
    expect(snap.lastError).toBeNull()
    expect(snap.channels.length).toBe(1)
    expect(snap.channels[0].channelId).toBe('pm-mouriya/main')
    expect(snap.channels[0].agentKind).toBe('pm-agent')
    expect(snap.channels[0].instanceLabel).toBe('Mouriya PM')
    expect(snap.generatedAt).toBe('2026-05-13T00:00:00.000Z')

    expect(observedRegister).toBe(true)
    expect(capturedSender).toBe('fulcrum-test/pm-mode-poller')
    expect(capturedRequestBody).toMatchObject({
      schema_version: EXCHANGE_SCHEMA_VERSION,
      body: {
        kind: 'discovery.list_request',
        payload: {
          filter: { agent_kind: ['pm-agent'] },
        },
      },
    })
  })

  test('pollPmMailboxes returns empty + null error when channels.pm.enabled is false', async () => {
    const { _setFetchForTests, pollPmMailboxes } = await import('./pm-mode-service')

    let fetchCalled = false
    _setFetchForTests((async () => {
      fetchCalled = true
      return new Response('', { status: 200 })
    }) as typeof fetch)

    const snap = await pollPmMailboxes()
    expect(fetchCalled).toBe(false)
    expect(snap.channels).toEqual([])
    expect(snap.lastError).toBeNull()
    expect(snap.generatedAt).toBeNull()
  })

  test('pollPmMailboxes surfaces HTTP failure via lastError without throwing', async () => {
    const { setFnoxValue } = await import('../lib/settings')
    const { _setFetchForTests, pollPmMailboxes } = await import('./pm-mode-service')

    setFnoxValue('channels.pm.enabled', true)
    setFnoxValue('channels.exchange.url', 'https://exchange.example.com')
    setFnoxValue('channels.exchange.mailbox', 'fulcrum-test')

    _setFetchForTests((async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      // The first call is the poller's self-register; succeed it so the
      // test focuses on discovery error surfacing.
      if (url.endsWith('/v1/register')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      return new Response('upstream gone', {
        status: 502,
        headers: { 'Content-Type': 'text/plain' },
      })
    }) as typeof fetch)

    const snap = await pollPmMailboxes()
    expect(snap.channels).toEqual([])
    expect(snap.lastError).toContain('discovery returned 502')
  })

  test('pollPmMailboxes flags missing exchange mailbox so Settings UI can point at the misconfig', async () => {
    const { setFnoxValue } = await import('../lib/settings')
    const { pollPmMailboxes } = await import('./pm-mode-service')

    setFnoxValue('channels.pm.enabled', true)
    setFnoxValue('channels.exchange.url', 'https://exchange.example.com')
    // intentionally no channels.exchange.mailbox — fulcrum has no sender identity
    // to use for discovery, so the poller must refuse instead of registering
    // an ad-hoc pm-named mailbox (would violate #153 §824 boundary).

    const snap = await pollPmMailboxes()
    expect(snap.channels).toEqual([])
    expect(snap.lastError).toContain('exchange mailbox not configured')
  })
})
