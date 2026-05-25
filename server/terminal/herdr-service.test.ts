import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import * as net from 'node:net'
import * as fs from 'node:fs'
import * as os from 'os'
import * as path from 'path'
import { HerdrService } from './herdr-service'

/**
 * Fake herdr API server: accepts one newline-delimited JSON request per
 * connection, looks the method up in a handler map, writes a response, and
 * closes the socket — matching what real herdr 0.6.x does.
 */
class FakeHerdrServer {
  readonly socketPath: string
  private server: net.Server | null = null
  private handlers = new Map<string, (params: Record<string, unknown>) => Record<string, unknown>>()
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = []

  constructor() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-test-'))
    this.socketPath = path.join(dir, 'herdr.sock')
  }

  on(method: string, handler: (params: Record<string, unknown>) => Record<string, unknown>) {
    this.handlers.set(method, handler)
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = net.createServer((sock) => {
        let buf = ''
        sock.on('data', (chunk: Buffer) => {
          buf += chunk.toString('utf8')
          const nl = buf.indexOf('\n')
          if (nl < 0) return
          const line = buf.slice(0, nl)
          let req: { id: string; method: string; params: Record<string, unknown> }
          try {
            req = JSON.parse(line)
          } catch {
            sock.end()
            return
          }
          this.calls.push({ method: req.method, params: req.params ?? {} })
          const handler = this.handlers.get(req.method)
          if (!handler) {
            sock.write(
              JSON.stringify({ id: req.id, error: { code: 'unknown', message: req.method } }) +
                '\n'
            )
          } else {
            const result = handler(req.params ?? {})
            sock.write(JSON.stringify({ id: req.id, result }) + '\n')
          }
          // Mimic real herdr: close after one response per connection.
          sock.end()
        })
      })
      this.server.listen(this.socketPath, () => resolve())
    })
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server?.close(() => {
        try {
          fs.rmSync(path.dirname(this.socketPath), { recursive: true, force: true })
        } catch {
          // best-effort
        }
        resolve()
      })
    })
  }
}

// Construct a HerdrService whose getApiSocketPath() is overridden to point at
// the fake server. Avoids having to fake out ~/.config/herdr.
function serviceFor(fake: FakeHerdrServer): HerdrService {
  const svc = new HerdrService('test-session', 'herdr')
  svc.getApiSocketPath = () => fake.socketPath
  return svc
}

describe('HerdrService', () => {
  let fake: FakeHerdrServer

  beforeEach(async () => {
    fake = new FakeHerdrServer()
    await fake.start()
  })

  afterEach(async () => {
    await fake.stop()
  })

  test('ping returns version info', async () => {
    fake.on('ping', () => ({ type: 'pong', version: '0.6.2', protocol: 10 }))
    const svc = serviceFor(fake)
    const r = await svc.ping()
    expect(r.version).toBe('0.6.2')
    expect(r.protocol).toBe(10)
  })

  test('listWorkspaces returns empty array', async () => {
    fake.on('workspace.list', () => ({ type: 'workspace_list', workspaces: [] }))
    const svc = serviceFor(fake)
    const ws = await svc.listWorkspaces()
    expect(ws).toEqual([])
  })

  test('ensureWorkspace creates one when absent', async () => {
    fake.on('workspace.list', () => ({ workspaces: [] }))
    fake.on('workspace.create', (params) => ({
      type: 'workspace_created',
      workspace: {
        workspace_id: 'w1',
        label: params.label as string,
        number: 1,
        focused: true,
        pane_count: 1,
        tab_count: 1,
      },
      tab: {
        tab_id: 'w1:1',
        workspace_id: 'w1',
        number: 1,
        label: '1',
        focused: true,
        pane_count: 1,
      },
      root_pane: {
        pane_id: 'w1-1',
        terminal_id: 'term_1',
        workspace_id: 'w1',
        tab_id: 'w1:1',
        focused: true,
      },
    }))
    const svc = serviceFor(fake)
    const r = await svc.ensureWorkspace({ label: 'Foo', cwd: '/tmp' })
    expect(r.workspace.workspace_id).toBe('w1')
    expect(r.workspace.label).toBe('Foo')
    expect(r.created?.root_pane.pane_id).toBe('w1-1')
    expect(fake.calls.map((c) => c.method)).toEqual(['workspace.list', 'workspace.create'])
  })

  test('ensureWorkspace returns existing match without creating', async () => {
    fake.on('workspace.list', () => ({
      workspaces: [
        {
          workspace_id: 'wA',
          label: 'Foo',
          number: 1,
          focused: false,
          pane_count: 2,
          tab_count: 2,
        },
      ],
    }))
    fake.on('workspace.create', () => {
      throw new Error('should not be called')
    })
    const svc = serviceFor(fake)
    const r = await svc.ensureWorkspace({ label: 'Foo', cwd: '/tmp' })
    expect(r.workspace.workspace_id).toBe('wA')
    expect(r.created).toBeUndefined()
    expect(fake.calls).toHaveLength(1)
  })

  test('createTab returns tab + root_pane', async () => {
    fake.on('tab.create', (params) => ({
      type: 'tab_created',
      tab: {
        tab_id: 'wA:2',
        workspace_id: params.workspace_id as string,
        number: 2,
        label: params.label as string,
        focused: true,
        pane_count: 1,
      },
      root_pane: {
        pane_id: 'wA-2',
        terminal_id: 'term_2',
        workspace_id: params.workspace_id as string,
        tab_id: 'wA:2',
        focused: true,
        cwd: params.cwd as string,
      },
    }))
    const svc = serviceFor(fake)
    const r = await svc.createTab({ workspaceId: 'wA', label: 'task-x', cwd: '/work' })
    expect(r.tab.tab_id).toBe('wA:2')
    expect(r.root_pane.pane_id).toBe('wA-2')
    expect(r.root_pane.terminal_id).toBe('term_2')
    expect(fake.calls[0].params).toEqual({ workspace_id: 'wA', label: 'task-x', cwd: '/work' })
  })

  test('runInPane sends the command via pane.send_text with trailing newline', async () => {
    fake.on('pane.send_text', () => ({ type: 'ok' }))
    const svc = serviceFor(fake)
    await svc.runInPane('wA-2', 'dtach -a /tmp/foo.sock')
    expect(fake.calls[0]).toEqual({
      method: 'pane.send_text',
      params: { pane_id: 'wA-2', text: 'dtach -a /tmp/foo.sock\r' },
    })
  })

  test('closeTab sends tab_id param', async () => {
    fake.on('tab.close', () => ({ type: 'ok' }))
    const svc = serviceFor(fake)
    await svc.closeTab('wA:2')
    expect(fake.calls[0]).toEqual({ method: 'tab.close', params: { tab_id: 'wA:2' } })
  })

  test('paneExists returns true on pane.get success', async () => {
    fake.on('pane.get', () => ({ type: 'pane_info', pane: { pane_id: 'wA-2' } }))
    const svc = serviceFor(fake)
    expect(await svc.paneExists('wA-2')).toBe(true)
  })

  test('paneExists returns false on error response', async () => {
    // No handler registered → server returns an error → call() rejects → paneExists swallows
    const svc = serviceFor(fake)
    expect(await svc.paneExists('missing')).toBe(false)
  })

  test('call rejects on server-side error', async () => {
    fake.on('workspace.list', () => {
      throw new Error('handler explosion')
    })
    const svc = serviceFor(fake)
    let err: unknown = null
    try {
      await svc.listWorkspaces()
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(Error)
  })
})
