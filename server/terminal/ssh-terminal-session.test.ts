import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { setupTestEnv, type TestEnv } from '../__tests__/utils/env'
import type { BufferManager } from './buffer-manager'

// Mock ssh2 module — captures exec commands for assertion
const execedCommands: string[] = []

class MockClient {
  _sock = { destroyed: false, writable: true }
  _handlers = new Map<string, (...args: unknown[]) => void>()

  on(event: string, handler: (...args: unknown[]) => void) {
    this._handlers.set(event, handler)
    return this
  }

  connect(_config: unknown) {
    const readyHandler = this._handlers.get('ready')
    if (readyHandler) setTimeout(() => readyHandler(), 0)
  }

  end() {}

  exec(cmd: string, cb: (err: Error | null, stream: unknown) => void) {
    execedCommands.push(cmd)
    const stream = {
      on(event: string, handler: (...args: unknown[]) => void) {
        if (event === 'data') setTimeout(() => handler(Buffer.from('ok')), 0)
        if (event === 'close') setTimeout(() => handler(0), 5)
        return stream
      },
      stderr: { on() { return this } },
    }
    cb(null, stream)
  }

  shell(opts: unknown, cb: (err: Error | null, stream: unknown) => void) {
    const mockStream = {
      _handlers: new Map<string, (...args: unknown[]) => void>(),
      on(event: string, handler: (...args: unknown[]) => void) {
        mockStream._handlers.set(event, handler)
        return mockStream
      },
      write(_data: string) {},
      close() {
        const closeHandler = mockStream._handlers.get('close')
        if (closeHandler) closeHandler()
      },
      setWindow() {},
      stderr: {
        on(_event: string, _handler: (...args: unknown[]) => void) { return this },
      },
    }
    cb(null, mockStream)
  }
}

mock.module('ssh2', () => ({ Client: MockClient }))

// Note: deliberately NOT mocking './buffer-manager', '../db', '../lib/logger',
// or 'drizzle-orm'.
// Bun's mock.module() leaks across test files (process-wide), so module-level
// mocks of these widely-imported modules would corrupt unrelated test
// suites that run after this file. Instead each test below calls
// setupTestEnv() to get a real isolated sqlite + log file under tmpdir, which
// gives ssh-terminal-session.ts's `db.update(terminals)…run()` a working
// target without polluting global state.

import { SSHTerminalSession } from './ssh-terminal-session'
import { resetSSHConnectionManager } from './ssh-connection-manager'

const baseSshConfig = {
  host: '127.0.0.1',
  port: 22,
  username: 'testuser',
  authMethod: 'key' as const,
  privateKeyPath: '/dev/null',
}

function createSession(overrides?: Partial<ConstructorParameters<typeof SSHTerminalSession>[0]>) {
  return new SSHTerminalSession({
    id: 'test-session-1',
    name: 'Test Terminal',
    cols: 80,
    rows: 24,
    cwd: '/home/testuser/work',
    createdAt: Date.now(),
    hostId: 'host-1',
    sshConfig: baseSshConfig,
    fulcrumUrl: 'http://localhost:7777',
    onData: () => {},
    onExit: () => {},
    ...overrides,
  })
}

function getReplayBuffer(session: SSHTerminalSession): BufferManager {
  return (session as unknown as { buffer: BufferManager }).buffer
}

describe('SSHTerminalSession', () => {
  let env: TestEnv
  const sessions: SSHTerminalSession[] = []

  beforeEach(() => {
    env = setupTestEnv()
    execedCommands.length = 0
    sessions.length = 0
    resetSSHConnectionManager()
  })

  afterEach(() => {
    for (const session of sessions) {
      getReplayBuffer(session)._dispose()
    }
    sessions.length = 0
    env?.cleanup()
  })

  function createTrackedSession(overrides?: Partial<ConstructorParameters<typeof SSHTerminalSession>[0]>) {
    const session = createSession(overrides)
    sessions.push(session)
    return session
  }

  test('getInfo returns correct fields', () => {
    const session = createTrackedSession()
    const info = session.getInfo()

    expect(info.id).toBe('test-session-1')
    expect(info.name).toBe('Test Terminal')
    expect(info.cwd).toBe('/home/testuser/work')
    expect(info.hostId).toBe('host-1')
    expect(info.cols).toBe(80)
    expect(info.rows).toBe(24)
    expect(info.status).toBe('running')
  })

  test('rename updates name', () => {
    const session = createTrackedSession()
    session.rename('New Name')
    expect(session.name).toBe('New Name')
    expect(session.getInfo().name).toBe('New Name')
  })

  test('assignTab updates tab info', () => {
    const session = createTrackedSession()
    session.assignTab('tab-1', 2)
    expect(session.tabId).toBe('tab-1')
    expect(session.positionInTab).toBe(2)
  })

  test('assignTab with null clears tab', () => {
    const session = createTrackedSession({ tabId: 'tab-1', positionInTab: 2 })
    session.assignTab(null)
    expect(session.tabId).toBeUndefined()
  })

  test('start() creates remote dtach session', async () => {
    const session = createTrackedSession()
    await session.start()
    // Should not throw - dtach created successfully
    expect(session.isRunning()).toBe(true)
  })

  test('start() sets error status on failure', async () => {
    let exitCalled = false
    const session = createTrackedSession({
      sshConfig: { ...baseSshConfig, authMethod: 'password' as const },
      onExit: () => { exitCalled = true },
    })
    await session.start()
    // password auth without password should fail in connection manager
    expect(exitCalled).toBe(true)
  })

  test('write() queues data before stream is ready', () => {
    const session = createTrackedSession()
    // Before attach, no stream
    expect(session.isAttached()).toBe(false)
    // Write should not throw
    session.write('hello')
  })

  test('initializes replay buffer with SSH terminal dimensions', async () => {
    const session = createTrackedSession({ cols: 132, rows: 43 })
    const buffer = getReplayBuffer(session)

    expect(buffer.getLineCount()).toBe(43)
    buffer.append('a'.repeat(100))
    await buffer.flushPending()
    expect(buffer._visibleText().split('\n')[0]).toHaveLength(100)
  })

  test('resize() updates dimensions', () => {
    const session = createTrackedSession()
    session.resize(120, 40)
    const info = session.getInfo()
    expect(info.cols).toBe(120)
    expect(info.rows).toBe(40)
  })

  test('resize() updates replay buffer dimensions', async () => {
    const session = createTrackedSession()
    session.resize(120, 40)
    const buffer = getReplayBuffer(session)

    expect(buffer.getLineCount()).toBe(40)
    buffer.append('a'.repeat(100))
    await buffer.flushPending()
    expect(buffer._visibleText().split('\n')[0]).toHaveLength(100)
  })

  test('isRunning() returns true initially', () => {
    const session = createTrackedSession()
    expect(session.isRunning()).toBe(true)
  })

  test('isAttached() returns false before attach', () => {
    const session = createTrackedSession()
    expect(session.isAttached()).toBe(false)
  })

  test('kill() marks session as exited', () => {
    const session = createTrackedSession()
    session.kill()
    expect(session.isRunning()).toBe(false)
  })

  test('start() uses $HOME in SSH create command, not hardcoded /home/<user>/', async () => {
    const session = createTrackedSession({
      sshConfig: { ...baseSshConfig, username: 'deploy' },
      multiplexerKind: 'dtach',
    })
    await session.start()
    const createCmd = execedCommands.find(c => c.includes('dtach'))
    expect(createCmd).toBeDefined()
    expect(createCmd).toContain('$HOME/.fulcrum/sockets')
    expect(createCmd).not.toContain('/home/deploy/')
  })

  test('attach() connects SSH and sets up stream', async () => {
    const session = createTrackedSession()
    await session.start()
    await session.attach()
    expect(session.isAttached()).toBe(true)
  })

  test('detach() releases connection', async () => {
    const session = createTrackedSession()
    await session.start()
    await session.attach()
    expect(session.isAttached()).toBe(true)
    session.detach()
    expect(session.isAttached()).toBe(false)
  })

  test('clearBuffer() clears buffer', () => {
    const session = createTrackedSession()
    // Should not throw
    session.clearBuffer()
    expect(session.getBuffer()).toBe('')
  })

  test('getBuffer() returns empty string initially', () => {
    const session = createTrackedSession()
    expect(session.getBuffer()).toBe('')
  })
})
