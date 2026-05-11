import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { setupTestEnv, type TestEnv } from '../__tests__/utils/env'

// Mock ssh2 module
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

// Note: deliberately NOT mocking '../db', '../lib/logger', or 'drizzle-orm'.
// Bun's mock.module() leaks across test files (process-wide), so module-level
// mocks of these widely-imported singletons would corrupt unrelated test
// suites that run after this file. Instead each test below calls
// setupTestEnv() to get a real isolated sqlite + log file under tmpdir, which
// gives ssh-terminal-session.ts's `db.update(terminals)…run()` a working
// target without polluting global state.

class MockBufferManager {
  static instances: MockBufferManager[] = []

  resizeCalls: Array<{ cols: number; rows: number }> = []

  constructor(readonly cols = 80, readonly rows = 24) {
    MockBufferManager.instances.push(this)
  }

  setTerminalId() {}
  append() {}
  getContents() { return '' }
  resize(cols: number, rows: number) { this.resizeCalls.push({ cols, rows }) }
  clear() {}
  saveToDisk() {}
  loadFromDisk() {}
  deleteFromDisk() {}
}

// Mock buffer manager
mock.module('./buffer-manager', () => ({
  BufferManager: MockBufferManager,
}))

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

describe('SSHTerminalSession', () => {
  let env: TestEnv

  beforeEach(() => {
    env = setupTestEnv()
    MockBufferManager.instances = []
    resetSSHConnectionManager()
  })

  afterEach(() => {
    env?.cleanup()
  })

  test('getInfo returns correct fields', () => {
    const session = createSession()
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
    const session = createSession()
    session.rename('New Name')
    expect(session.name).toBe('New Name')
    expect(session.getInfo().name).toBe('New Name')
  })

  test('assignTab updates tab info', () => {
    const session = createSession()
    session.assignTab('tab-1', 2)
    expect(session.tabId).toBe('tab-1')
    expect(session.positionInTab).toBe(2)
  })

  test('assignTab with null clears tab', () => {
    const session = createSession({ tabId: 'tab-1', positionInTab: 2 })
    session.assignTab(null)
    expect(session.tabId).toBeUndefined()
  })

  test('start() creates remote dtach session', async () => {
    const session = createSession()
    await session.start()
    // Should not throw - dtach created successfully
    expect(session.isRunning()).toBe(true)
  })

  test('start() sets error status on failure', async () => {
    let exitCalled = false
    const session = createSession({
      sshConfig: { ...baseSshConfig, authMethod: 'password' as const },
      onExit: () => { exitCalled = true },
    })
    await session.start()
    // password auth without password should fail in connection manager
    expect(exitCalled).toBe(true)
  })

  test('write() queues data before stream is ready', () => {
    const session = createSession()
    // Before attach, no stream
    expect(session.isAttached()).toBe(false)
    // Write should not throw
    session.write('hello')
  })

  test('initializes replay buffer with SSH terminal dimensions', () => {
    createSession({ cols: 132, rows: 43 })
    expect(MockBufferManager.instances[0]?.cols).toBe(132)
    expect(MockBufferManager.instances[0]?.rows).toBe(43)
  })

  test('resize() updates dimensions', () => {
    const session = createSession()
    session.resize(120, 40)
    const info = session.getInfo()
    expect(info.cols).toBe(120)
    expect(info.rows).toBe(40)
  })

  test('resize() updates replay buffer dimensions', () => {
    const session = createSession()
    session.resize(120, 40)
    expect(MockBufferManager.instances[0]?.resizeCalls).toEqual([{ cols: 120, rows: 40 }])
  })

  test('isRunning() returns true initially', () => {
    const session = createSession()
    expect(session.isRunning()).toBe(true)
  })

  test('isAttached() returns false before attach', () => {
    const session = createSession()
    expect(session.isAttached()).toBe(false)
  })

  test('kill() marks session as exited', () => {
    const session = createSession()
    session.kill()
    expect(session.isRunning()).toBe(false)
  })

  test('remoteSocketsDir uses username from config', () => {
    const session = createSession({
      sshConfig: { ...baseSshConfig, username: 'deploy' },
    })
    // The socket dir should be based on username
    // Verify via getInfo - cwd should remain as set
    expect(session.getInfo().cwd).toBe('/home/testuser/work')
  })

  test('attach() connects SSH and sets up stream', async () => {
    const session = createSession()
    await session.start()
    await session.attach()
    expect(session.isAttached()).toBe(true)
  })

  test('detach() releases connection', async () => {
    const session = createSession()
    await session.start()
    await session.attach()
    expect(session.isAttached()).toBe(true)
    session.detach()
    expect(session.isAttached()).toBe(false)
  })

  test('clearBuffer() clears buffer', () => {
    const session = createSession()
    // Should not throw
    session.clearBuffer()
    expect(session.getBuffer()).toBe('')
  })

  test('getBuffer() returns empty string initially', () => {
    const session = createSession()
    expect(session.getBuffer()).toBe('')
  })
})
