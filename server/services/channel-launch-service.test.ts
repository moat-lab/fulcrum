import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Wire-contract tests for the issue #193 task-launch path.
 *
 * The env keys asserted here must match
 * `agent-channel-exchange/packages/mcp/src/config.ts` (loadMcpChildConfig).
 * Any drift surfaces at MCP child boot as `[mcp] config error` and would fail
 * the #193 acceptance #3 e2e (MCP child must be the spawned claude's PID
 * child).
 */
describe('channel-launch-service (#193)', () => {
  // The Drizzle db handle is memoized at module-import time against the
  // `FULCRUM_DIR` set on that import. We use a single tempDir for the whole
  // file so the db handle stays valid across tests; only the fnox cache is
  // cleared per test to give each one a clean settings view.
  let tempDir: string
  let originalEnv: Record<string, string | undefined>

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'fulcrum-channel-launch-test-'))
    originalEnv = { FULCRUM_DIR: process.env.FULCRUM_DIR }
    process.env.FULCRUM_DIR = tempDir
  })

  beforeEach(async () => {
    const { clearFnoxCache } = await import('../lib/settings')
    clearFnoxCache()
  })

  afterAll(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('buildMcpConfigJson emits the env contract loadMcpChildConfig expects', async () => {
    const { buildMcpConfigJson, MCP_SERVER_NAME } = await import('./channel-launch-service')
    const json = buildMcpConfigJson({
      exchangeUrl: 'http://127.0.0.1:18787',
      bearerToken: 'bearer-secret-xyz',
      desiredChannelId: 'fulcrum-test/task-42',
      instanceLabel: 'fulcrum-test/task-42',
      mcp: { command: 'bun', args: ['run', '/abs/path/to/bin.ts'] },
    })
    const parsed = JSON.parse(json) as {
      mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>
    }
    const server = parsed.mcpServers[MCP_SERVER_NAME]
    expect(server).toBeDefined()
    expect(server!.command).toBe('bun')
    expect(server!.args).toEqual(['run', '/abs/path/to/bin.ts'])
    expect(server!.env.AGENT_CHANNEL_EXCHANGE_URL).toBe('http://127.0.0.1:18787')
    expect(server!.env.AGENT_CHANNEL_AGENT_KIND).toBe('fulcrum-client')
    expect(server!.env.AGENT_CHANNEL_INSTANCE_LABEL).toBe('fulcrum-test/task-42')
    expect(server!.env.AGENT_CHANNEL_DESIRED_ID).toBe('fulcrum-test/task-42')
    expect(server!.env.AGENT_CHANNEL_CAPABILITIES).toBe(
      'channel.send,channel.receive,discovery.list',
    )
    expect(server!.env.AGENT_CHANNEL_TOKEN).toBe('bearer-secret-xyz')
  })

  test('buildMcpConfigJson omits AGENT_CHANNEL_TOKEN when bearer is empty', async () => {
    const { buildMcpConfigJson } = await import('./channel-launch-service')
    const json = buildMcpConfigJson({
      exchangeUrl: 'http://127.0.0.1:18787',
      bearerToken: '',
      desiredChannelId: 'fulcrum-test/task-42',
      instanceLabel: 'fulcrum-test/task-42',
      mcp: { command: 'bun', args: ['run', '/abs/path/to/bin.ts'] },
    })
    const parsed = JSON.parse(json) as {
      mcpServers: Record<string, { env: Record<string, string> }>
    }
    expect('AGENT_CHANNEL_TOKEN' in parsed.mcpServers['agent-channel']!.env).toBe(false)
  })

  test('resolveMcpCommand accepts absolute bin.ts path and rejects empty/non-absolute', async () => {
    const { resolveMcpCommand } = await import('./channel-launch-service')
    expect(resolveMcpCommand('/abs/path/to/bin.ts')).toEqual({
      command: 'bun',
      args: ['run', '/abs/path/to/bin.ts'],
    })
    expect(() => resolveMcpCommand('')).toThrow(/empty/)
    expect(() => resolveMcpCommand('relative/path/bin.ts')).toThrow(/absolute/)
    expect(() => resolveMcpCommand('main')).toThrow(/absolute/)
  })

  test('prepareTaskLaunch writes a 0600 JSON file with the full env contract and stamps terminals.channel_id', async () => {
    const { prepareTaskLaunch } = await import('./channel-launch-service')
    const { setFnoxValue, db, terminals } = await Promise.all([
      import('../lib/settings'),
      import('../db'),
      import('../db/schema'),
    ]).then(([s, d, sch]) => ({ setFnoxValue: s.setFnoxValue, db: d.db, terminals: sch.terminals }))

    setFnoxValue('channels.exchange.enabled', true)
    setFnoxValue('channels.exchange.url', 'http://127.0.0.1:18787')
    setFnoxValue('channels.exchange.token', 'bearer-secret-xyz')
    setFnoxValue('channels.exchange.mailbox', 'fulcrum-test')
    setFnoxValue(
      'channels.exchange.mcpGitRef',
      '/Users/mouriya/Ext/code/agent-channel-exchange/packages/mcp/src/bin.ts',
    )

    const terminalId = 'term-193-test'
    const now = new Date().toISOString()
    db.insert(terminals)
      .values({
        id: terminalId,
        name: 'task-99',
        cwd: '/tmp',
        tmuxSession: 'fulcrum-test',
        status: 'running',
        createdAt: now,
        updatedAt: now,
      })
      .run()

    const result = prepareTaskLaunch({ taskId: '99', terminalId })
    expect(result.channelId).toBe('fulcrum-test/task-99')
    expect(result.mcpConfigPath).toContain('runtime/mcp-configs/term-193-test.json')

    const stat = statSync(result.mcpConfigPath)
    // 0600 = rw------- (owner-only); mask of perm bits.
    expect(stat.mode & 0o777).toBe(0o600)

    const parsed = JSON.parse(readFileSync(result.mcpConfigPath, 'utf8')) as {
      mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>
    }
    const server = parsed.mcpServers['agent-channel']
    expect(server).toBeDefined()
    expect(server!.command).toBe('bun')
    expect(server!.args[0]).toBe('run')
    expect(server!.args[1]).toContain('agent-channel-exchange/packages/mcp/src/bin.ts')
    expect(server!.env.AGENT_CHANNEL_EXCHANGE_URL).toBe('http://127.0.0.1:18787')
    expect(server!.env.AGENT_CHANNEL_DESIRED_ID).toBe('fulcrum-test/task-99')
    expect(server!.env.AGENT_CHANNEL_INSTANCE_LABEL).toBe('fulcrum-test/task-99')
    expect(server!.env.AGENT_CHANNEL_AGENT_KIND).toBe('fulcrum-client')
    expect(server!.env.AGENT_CHANNEL_CAPABILITIES).toBe(
      'channel.send,channel.receive,discovery.list',
    )
    expect(server!.env.AGENT_CHANNEL_TOKEN).toBe('bearer-secret-xyz')

    const { eq } = await import('drizzle-orm')
    const row = db.select().from(terminals).where(eq(terminals.id, terminalId)).all()[0]
    // Acceptance #5: envelope `from` = `terminals.channel_id`. Optimistic
    // write here is what makes that hold without a round-trip register.
    expect(row?.channelId).toBe('fulcrum-test/task-99')

    db.delete(terminals).where(eq(terminals.id, terminalId)).run()
  })

  test('prepareTaskLaunch strips a trailing slash on the exchange URL', async () => {
    const { prepareTaskLaunch } = await import('./channel-launch-service')
    const { setFnoxValue, db, terminals } = await Promise.all([
      import('../lib/settings'),
      import('../db'),
      import('../db/schema'),
    ]).then(([s, d, sch]) => ({ setFnoxValue: s.setFnoxValue, db: d.db, terminals: sch.terminals }))

    setFnoxValue('channels.exchange.enabled', true)
    setFnoxValue('channels.exchange.url', 'https://exchange.example.com/')
    setFnoxValue('channels.exchange.mailbox', 'fulcrum-test')
    setFnoxValue('channels.exchange.mcpGitRef', '/abs/path/bin.ts')

    const terminalId = 'term-193-test-slash'
    const now = new Date().toISOString()
    db.insert(terminals)
      .values({
        id: terminalId,
        name: 'task-1',
        cwd: '/tmp',
        tmuxSession: 'fulcrum-test',
        status: 'running',
        createdAt: now,
        updatedAt: now,
      })
      .run()

    const result = prepareTaskLaunch({ taskId: '1', terminalId })
    const parsed = JSON.parse(readFileSync(result.mcpConfigPath, 'utf8')) as {
      mcpServers: Record<string, { env: Record<string, string> }>
    }
    expect(parsed.mcpServers['agent-channel']!.env.AGENT_CHANNEL_EXCHANGE_URL).toBe(
      'https://exchange.example.com',
    )

    const { eq } = await import('drizzle-orm')
    db.delete(terminals).where(eq(terminals.id, terminalId)).run()
  })

  test('prepareTaskLaunch fails fast when exchange is disabled / unconfigured', async () => {
    const { prepareTaskLaunch } = await import('./channel-launch-service')
    const { setFnoxValue } = await import('../lib/settings')

    setFnoxValue('channels.exchange.enabled', false)
    expect(() => prepareTaskLaunch({ taskId: '1', terminalId: 'x' })).toThrow(/enabled is false/)

    setFnoxValue('channels.exchange.enabled', true)
    expect(() => prepareTaskLaunch({ taskId: '1', terminalId: 'x' })).toThrow(/url is empty/)

    setFnoxValue('channels.exchange.url', 'http://127.0.0.1:18787')
    expect(() => prepareTaskLaunch({ taskId: '1', terminalId: 'x' })).toThrow(/mailbox is empty/)

    setFnoxValue('channels.exchange.mailbox', 'fulcrum-test')
    expect(() => prepareTaskLaunch({ taskId: '1', terminalId: 'x' })).toThrow(/mcpGitRef is empty/)
  })
})
