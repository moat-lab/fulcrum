import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Wire-contract tests for issue #194 PM launch helper.
 *
 * Verifies the env contract Alice's claude MCP child will see at boot:
 *   - AGENT_CHANNEL_AGENT_KIND must be 'pm-agent' (not 'fulcrum-client') so the
 *     exchange surfaces this mailbox under discovery.list_request{filter:pm-agent}.
 *   - The 0600 file permission keeps the bearer token off `ps auxe` and out of
 *     any shell history Alice might paste from.
 *   - No exchange register POST occurs — that responsibility belongs to the
 *     MCP child started by Alice's claude. Tested indirectly by the lack of
 *     any fetch / network code in the call path.
 */
describe('pm-launch-service (#194)', () => {
  let tempDir: string
  let originalEnv: Record<string, string | undefined>

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'fulcrum-pm-launch-test-'))
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

  test('buildPmMcpConfigJson emits AGENT_KIND=pm-agent and the env contract loadMcpChildConfig expects', async () => {
    const { buildPmMcpConfigJson } = await import('./pm-launch-service')
    const { MCP_SERVER_NAME } = await import('./channel-launch-service')
    const json = buildPmMcpConfigJson({
      exchangeUrl: 'http://127.0.0.1:18787',
      bearerToken: 'bearer-secret-xyz',
      pmMailbox: 'pm-mouriya/main',
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
    // The differentiator from the task-launch JSON: PM must register as
    // 'pm-agent' so it shows up in fulcrum's pm-mailboxes discovery filter.
    expect(server!.env.AGENT_CHANNEL_AGENT_KIND).toBe('pm-agent')
    expect(server!.env.AGENT_CHANNEL_INSTANCE_LABEL).toBe('pm-mouriya/main')
    expect(server!.env.AGENT_CHANNEL_DESIRED_ID).toBe('pm-mouriya/main')
    expect(server!.env.AGENT_CHANNEL_CAPABILITIES).toBe(
      'channel.send,channel.receive,discovery.list',
    )
    expect(server!.env.AGENT_CHANNEL_TOKEN).toBe('bearer-secret-xyz')
  })

  test('buildPmMcpConfigJson omits AGENT_CHANNEL_TOKEN when bearer is empty', async () => {
    const { buildPmMcpConfigJson } = await import('./pm-launch-service')
    const json = buildPmMcpConfigJson({
      exchangeUrl: 'http://127.0.0.1:18787',
      bearerToken: '',
      pmMailbox: 'pm-mouriya/main',
      mcp: { command: 'bun', args: ['run', '/abs/path/to/bin.ts'] },
    })
    const parsed = JSON.parse(json) as {
      mcpServers: Record<string, { env: Record<string, string> }>
    }
    expect('AGENT_CHANNEL_TOKEN' in parsed.mcpServers['agent-channel']!.env).toBe(false)
  })

  test('preparePmLaunch writes a 0600 JSON file and returns a copy-pasteable command', async () => {
    const { preparePmLaunch } = await import('./pm-launch-service')
    const { setFnoxValue } = await import('../lib/settings')

    setFnoxValue('channels.exchange.enabled', true)
    setFnoxValue('channels.exchange.url', 'http://127.0.0.1:18787')
    setFnoxValue('channels.exchange.token', 'bearer-secret-xyz')
    setFnoxValue('channels.exchange.mcpGitRef', '/abs/path/to/bin.ts')
    setFnoxValue('channels.pm.enabled', true)
    setFnoxValue('channels.pm.clientForm', 'claude-mcp')
    setFnoxValue('channels.pm.mailbox', 'pm-mouriya/main')

    const result = preparePmLaunch()
    expect(result.pmMailbox).toBe('pm-mouriya/main')
    expect(result.mcpConfigPath).toContain('runtime/mcp-configs/pm.json')
    // #195: command now embeds `--append-system-prompt '<addendum>'` so the
    // launched PM claude actually polls inbox + recognizes the five business
    // message kinds. We assert structure (flags present, mcpConfigPath
    // intact) rather than the exact byte string so the addendum text can
    // evolve without breaking the test, while still pinning the contract.
    expect(result.command).toContain(`--mcp-config ${result.mcpConfigPath}`)
    expect(result.command).toContain(`--append-system-prompt '`)
    expect(result.command).toMatch(/^claude /)
    expect(result.promptAddendum).toContain('`pm-mouriya/main`')
    expect(result.promptAddendum).toContain('completion_claim')
    expect(result.command).toContain(result.promptAddendum.replace(/'/g, `'\\''`))

    const stat = statSync(result.mcpConfigPath)
    expect(stat.mode & 0o777).toBe(0o600)

    const parsed = JSON.parse(readFileSync(result.mcpConfigPath, 'utf8')) as {
      mcpServers: Record<string, { env: Record<string, string> }>
    }
    expect(parsed.mcpServers['agent-channel']!.env.AGENT_CHANNEL_AGENT_KIND).toBe('pm-agent')
    expect(parsed.mcpServers['agent-channel']!.env.AGENT_CHANNEL_DESIRED_ID).toBe('pm-mouriya/main')
  })

  test('preparePmLaunch strips a trailing slash on the exchange URL', async () => {
    const { preparePmLaunch } = await import('./pm-launch-service')
    const { setFnoxValue } = await import('../lib/settings')

    setFnoxValue('channels.exchange.enabled', true)
    setFnoxValue('channels.exchange.url', 'https://exchange.example.com/')
    setFnoxValue('channels.exchange.mcpGitRef', '/abs/path/bin.ts')
    setFnoxValue('channels.pm.enabled', true)
    setFnoxValue('channels.pm.clientForm', 'claude-mcp')
    setFnoxValue('channels.pm.mailbox', 'pm-mouriya/main')

    const result = preparePmLaunch()
    const parsed = JSON.parse(readFileSync(result.mcpConfigPath, 'utf8')) as {
      mcpServers: Record<string, { env: Record<string, string> }>
    }
    expect(parsed.mcpServers['agent-channel']!.env.AGENT_CHANNEL_EXCHANGE_URL).toBe(
      'https://exchange.example.com',
    )
  })

  test('preparePmLaunch fails fast on each missing config dimension', async () => {
    const { preparePmLaunch } = await import('./pm-launch-service')
    const { setFnoxValue } = await import('../lib/settings')

    setFnoxValue('channels.exchange.enabled', false)
    expect(() => preparePmLaunch()).toThrow(/exchange.enabled is false/)

    setFnoxValue('channels.exchange.enabled', true)
    expect(() => preparePmLaunch()).toThrow(/exchange.url is empty/)

    setFnoxValue('channels.exchange.url', 'http://127.0.0.1:18787')
    setFnoxValue('channels.pm.enabled', false)
    expect(() => preparePmLaunch()).toThrow(/pm.enabled is false/)

    setFnoxValue('channels.pm.enabled', true)
    setFnoxValue('channels.pm.clientForm', 'external-http')
    expect(() => preparePmLaunch()).toThrow(/clientForm=external-http/)

    setFnoxValue('channels.pm.clientForm', 'claude-mcp')
    setFnoxValue('channels.pm.mailbox', '')
    expect(() => preparePmLaunch()).toThrow(/pm.mailbox is empty/)

    setFnoxValue('channels.pm.mailbox', 'pm-mouriya/main')
    setFnoxValue('channels.exchange.mcpGitRef', '')
    expect(() => preparePmLaunch()).toThrow(/mcpGitRef is empty/)
  })
})
