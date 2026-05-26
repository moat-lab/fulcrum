import { existsSync } from 'fs'
import * as net from 'net'
import * as os from 'os'
import * as path from 'path'
import { spawn } from 'child_process'
import { execSync } from 'child_process'
import { log } from '../lib/logger'
import { getSetting } from '../lib/settings'

// --- Wire protocol types ---

interface HerdrRequest {
  id: string
  method: string
  params: Record<string, unknown>
}

interface HerdrResponse {
  id: string
  result?: Record<string, unknown>
  error?: { code: string; message: string }
}

// --- Returned shapes (subset of what herdr 0.6.x sends back) ---

export interface HerdrWorkspaceInfo {
  workspace_id: string
  label: string
  number: number
  focused: boolean
  pane_count: number
  tab_count: number
  active_tab_id?: string
  agent_status?: string
}

export interface HerdrTabInfo {
  tab_id: string
  workspace_id: string
  number: number
  label: string
  focused: boolean
  pane_count: number
  agent_status?: string
}

export interface HerdrPaneInfo {
  pane_id: string
  terminal_id: string
  workspace_id: string
  tab_id: string
  focused: boolean
  cwd?: string
  agent_status?: string
  revision?: number
}

export interface CreatedWorkspace {
  workspace: HerdrWorkspaceInfo
  tab: HerdrTabInfo
  root_pane: HerdrPaneInfo
}

export interface CreatedTab {
  tab: HerdrTabInfo
  root_pane: HerdrPaneInfo
}

export interface CreatedPane {
  pane: HerdrPaneInfo
}

const CONFIG_DIR = path.join(os.homedir(), '.config', 'herdr')
const RESPONSE_TIMEOUT_MS = 4000
const START_POLL_MS = 100
const START_POLL_ATTEMPTS = 30 // 3s total

// herdr's "default" session is unnamed: its socket lives at the config root,
// not under sessions/<name>/. Spawning it also takes no --session flag. Treat
// this name as a sentinel for "the unnamed session".
const DEFAULT_SESSION = 'default'

export class HerdrService {
  private requestSeq = 0
  // Per-label in-flight ensureWorkspace dedupe. Without this, parallel
  // ensureWorkspace('scratch', ...) callers (e.g. reconcileMirrorOnRestore
  // firing concurrently for many task terminals on server startup) all see
  // an empty list before any of them creates, and each goes on to create a
  // duplicate. Coalescing on label keeps the create() call single-flight.
  private inflightEnsure = new Map<
    string,
    Promise<{ workspace: HerdrWorkspaceInfo; created?: CreatedWorkspace }>
  >()

  constructor(
    private readonly session: string,
    private readonly binary: string
  ) {}

  /** Path to the herdr API socket for the current session. */
  getApiSocketPath(): string {
    if (this.session === DEFAULT_SESSION) {
      return path.join(CONFIG_DIR, 'herdr.sock')
    }
    return path.join(CONFIG_DIR, 'sessions', this.session, 'herdr.sock')
  }

  /** Is herdr's API socket present (server already running)? */
  isServerRunning(): boolean {
    return existsSync(this.getApiSocketPath())
  }

  /**
   * Make sure the herdr server for this session is running.
   * Spawns `herdr --session <name> server` detached if absent (or
   * `herdr server` for the unnamed default session), then polls for the
   * socket to appear. Returns true if reachable when we finish.
   */
  async ensureServerRunning(): Promise<boolean> {
    if (this.isServerRunning()) return true

    log.terminal.info('herdr server not running; starting it', { session: this.session })
    try {
      const args =
        this.session === DEFAULT_SESSION
          ? ['server']
          : ['--session', this.session, 'server']
      const child = spawn(this.binary, args, {
        stdio: 'ignore',
        detached: true,
      })
      child.unref()
    } catch (err) {
      log.terminal.error('failed to spawn herdr server', { session: this.session, error: String(err) })
      return false
    }

    for (let i = 0; i < START_POLL_ATTEMPTS; i++) {
      if (this.isServerRunning()) return true
      await new Promise((r) => setTimeout(r, START_POLL_MS))
    }
    log.terminal.error('herdr server did not appear after spawn', { session: this.session })
    return false
  }

  /**
   * Send one JSON request and read one JSON response.
   * The herdr API server closes the connection after each response, so we
   * open a fresh socket per call. Simple, predictable, no multiplexing.
   */
  private call<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {}
  ): Promise<T> {
    const id = `fulcrum_${++this.requestSeq}`
    const req: HerdrRequest = { id, method, params }
    const line = JSON.stringify(req) + '\n'
    const socketPath = this.getApiSocketPath()

    return new Promise<T>((resolve, reject) => {
      const sock = net.connect(socketPath)
      let buf = ''
      let settled = false

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        sock.destroy()
        reject(new Error(`herdr call timed out: ${method}`))
      }, RESPONSE_TIMEOUT_MS)

      const finish = (err: Error | null, value?: T) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        sock.destroy()
        if (err) reject(err)
        else resolve(value as T)
      }

      sock.on('error', (err) => finish(err))

      sock.on('connect', () => sock.write(line))

      sock.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8')
        const nl = buf.indexOf('\n')
        if (nl < 0) return
        const lineOut = buf.slice(0, nl)
        try {
          const resp = JSON.parse(lineOut) as HerdrResponse
          if (resp.error) {
            finish(new Error(`herdr ${method}: ${resp.error.code}: ${resp.error.message}`))
          } else {
            finish(null, (resp.result ?? {}) as T)
          }
        } catch (err) {
          finish(new Error(`herdr ${method}: malformed JSON: ${String(err)}`))
        }
      })

      sock.on('close', () => {
        if (settled) return
        // Server closed without sending a complete response line.
        finish(new Error(`herdr ${method}: socket closed before response`))
      })
    })
  }

  // --- Public API ---

  async ping(): Promise<{ type: string; version: string; protocol: number }> {
    return this.call('ping') as Promise<{ type: string; version: string; protocol: number }>
  }

  async listWorkspaces(): Promise<HerdrWorkspaceInfo[]> {
    const r = await this.call<{ workspaces: HerdrWorkspaceInfo[] }>('workspace.list')
    return r.workspaces ?? []
  }

  async createWorkspace(opts: { cwd: string; label: string }): Promise<CreatedWorkspace> {
    return this.call<CreatedWorkspace>('workspace.create', opts)
  }

  /**
   * Return an existing workspace matching `label` (case-sensitive), or
   * create a new one with the given `cwd`/`label`. When created, also
   * returns the tab + root_pane that herdr makes alongside.
   */
  async ensureWorkspace(opts: {
    label: string
    cwd: string
  }): Promise<{ workspace: HerdrWorkspaceInfo; created?: CreatedWorkspace }> {
    const pending = this.inflightEnsure.get(opts.label)
    if (pending) return pending
    const work = this.doEnsureWorkspace(opts)
    this.inflightEnsure.set(opts.label, work)
    try {
      return await work
    } finally {
      this.inflightEnsure.delete(opts.label)
    }
  }

  private async doEnsureWorkspace(opts: {
    label: string
    cwd: string
  }): Promise<{ workspace: HerdrWorkspaceInfo; created?: CreatedWorkspace }> {
    const existing = await this.listWorkspaces()
    const hit = existing.find((w) => w.label === opts.label)
    if (hit) return { workspace: hit }
    const created = await this.createWorkspace(opts)
    return { workspace: created.workspace, created }
  }

  async createTab(opts: { workspaceId: string; label: string; cwd?: string }): Promise<CreatedTab> {
    return this.call<CreatedTab>('tab.create', {
      workspace_id: opts.workspaceId,
      label: opts.label,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    })
  }

  async closeTab(tabId: string): Promise<void> {
    await this.call('tab.close', { tab_id: tabId })
  }

  /**
   * Split an existing pane and get a fresh pane in the same tab.
   * `direction: 'right'` produces a vertical split (new pane to the right);
   * `direction: 'down'` produces a horizontal split (new pane below).
   * When the last pane in a tab is later closed via {@link closePane}, herdr
   * cleans up the tab itself.
   */
  async splitPane(opts: {
    targetPaneId: string
    direction: 'right' | 'down'
    cwd?: string
    focus?: boolean
  }): Promise<CreatedPane> {
    return this.call<CreatedPane>('pane.split', {
      target_pane_id: opts.targetPaneId,
      direction: opts.direction,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      focus: opts.focus ?? false,
    })
  }

  async closePane(paneId: string): Promise<void> {
    await this.call('pane.close', { pane_id: paneId })
  }

  async listPanes(workspaceId?: string): Promise<HerdrPaneInfo[]> {
    const r = await this.call<{ panes: HerdrPaneInfo[] }>(
      'pane.list',
      workspaceId ? { workspace_id: workspaceId } : {}
    )
    return r.panes ?? []
  }

  /**
   * Type a command into the pane's shell and execute it (appends a newline).
   *
   * The `pane.run` CLI subcommand maps to `pane.send_text` over the socket,
   * with the trailing `\r` we add here. There is no dedicated socket
   * method for "run a command".
   */
  async runInPane(paneId: string, command: string): Promise<void> {
    await this.call('pane.send_text', { pane_id: paneId, text: command + '\r' })
  }

  async paneExists(paneId: string): Promise<boolean> {
    try {
      await this.call('pane.get', { pane_id: paneId })
      return true
    } catch {
      return false
    }
  }

  /**
   * Tell herdr what agent is running inside a pane. Required when the pane
   * isn't directly hosting the agent process (e.g. our mirror panes run
   * `dtach -a` and the real agent lives on the other side of the socket,
   * so herdr's own process inspection can't see it).
   *
   * `source` is the reporter id — pass a stable string (we use "fulcrum")
   * so repeat reports update the existing record rather than accumulating.
   */
  async reportAgent(
    paneId: string,
    opts: {
      source: string
      agent: string
      state: 'idle' | 'working' | 'blocked' | 'unknown'
      message?: string
      customStatus?: string
    }
  ): Promise<void> {
    await this.call('pane.report_agent', {
      pane_id: paneId,
      source: opts.source,
      agent: opts.agent,
      state: opts.state,
      ...(opts.message ? { message: opts.message } : {}),
      ...(opts.customStatus ? { custom_status: opts.customStatus } : {}),
    })
  }

  static isAvailable(binary = 'herdr'): boolean {
    try {
      execSync(`${binary} --version`, { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }
}

// --- Singleton plumbing ---

let cached: HerdrService | null = null
let cachedKey = ''

/**
 * Get the herdr service for the configured session. Re-instantiates if the
 * settings have changed (session name / binary path).
 */
export function getHerdrService(): HerdrService {
  const session = (getSetting('terminal.herdr.session') as string) || 'fulcrum'
  const binary = (getSetting('terminal.herdr.binary') as string) || 'herdr'
  const key = `${session}::${binary}`
  if (!cached || cachedKey !== key) {
    cached = new HerdrService(session, binary)
    cachedKey = key
  }
  return cached
}

/** Reset the singleton (test cleanup, settings reload). */
export function resetHerdrService(): void {
  cached = null
  cachedKey = ''
}
