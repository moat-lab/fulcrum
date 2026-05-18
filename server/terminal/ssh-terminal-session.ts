import type { Client as ClientType, ClientChannel } from 'ssh2'
import { BufferManager } from './buffer-manager'
import { db, terminals } from '../db'
import { eq } from 'drizzle-orm'
import type { TerminalInfo, TerminalStatus } from '../types'
import type { ITerminalSession } from './session-interface'
import { getSSHConnectionManager, type SSHConnectionConfig } from './ssh-connection-manager'
import { log } from '../lib/logger'
import { shellEscape } from '../lib/shell-escape'
import { getMultiplexerService } from './dtach-service'
import type { MultiplexerKind } from './multiplexer-service'

export interface SSHTerminalSessionOptions {
  id: string
  name: string
  cols: number
  rows: number
  cwd: string
  createdAt: number
  tabId?: string
  positionInTab?: number
  taskId?: string
  multiplexerKind?: MultiplexerKind
  // SSH-specific
  hostId: string
  sshConfig: SSHConnectionConfig
  fulcrumUrl: string
  // Callbacks
  onData: (data: string) => void
  onExit: (exitCode: number, status: TerminalStatus) => void
  onShouldDestroy?: () => void
}

export class SSHTerminalSession implements ITerminalSession {
  readonly id: string
  private _name: string
  readonly cwd: string
  readonly createdAt: number

  private cols: number
  private rows: number
  private status: TerminalStatus = 'running'
  private exitCode?: number
  private stream: ClientChannel | null = null
  private sshClient: ClientType | null = null
  private buffer: BufferManager
  private onData: (data: string) => void
  private onExit: (exitCode: number, status: TerminalStatus) => void
  private onShouldDestroy?: () => void

  private _tabId?: string
  private _positionInTab: number
  private _taskId?: string
  private _hostId: string
  private _multiplexerKind: MultiplexerKind
  private sshConfig: SSHConnectionConfig
  private fulcrumUrl: string
  private remoteSocketsDir: string

  // Input queue for data sent before stream is ready
  private inputQueue: string[] = []

  // Auto-dismiss Claude workspace trust prompt
  private trustPromptHandled = false
  private recentOutput = ''

  constructor(options: SSHTerminalSessionOptions) {
    this.id = options.id
    this._name = options.name
    this.cols = options.cols
    this.rows = options.rows
    this.cwd = options.cwd
    this.createdAt = options.createdAt
    this._tabId = options.tabId
    this._positionInTab = options.positionInTab ?? 0
    this._taskId = options.taskId
    this._hostId = options.hostId
    this._multiplexerKind = options.multiplexerKind ?? 'dtach'
    this.sshConfig = options.sshConfig
    this.fulcrumUrl = options.fulcrumUrl
    this.buffer = new BufferManager(this.cols, this.rows)
    this.buffer.setTerminalId(this.id)
    this.remoteSocketsDir = '$HOME/.fulcrum/sockets'
    this.onData = options.onData
    this.onExit = options.onExit
    this.onShouldDestroy = options.onShouldDestroy
  }

  get name(): string {
    return this._name
  }

  get tabId(): string | undefined {
    return this._tabId
  }

  get positionInTab(): number {
    return this._positionInTab
  }

  rename(newName: string): void {
    this._name = newName
    this.updateDb({ name: newName })
  }

  assignTab(tabId: string | null, positionInTab?: number): void {
    this._tabId = tabId ?? undefined
    if (positionInTab !== undefined) {
      this._positionInTab = positionInTab
    }
    this.updateDb({ tabId, positionInTab: this._positionInTab })
  }

  // Create a dtach session on the remote host via SSH exec
  async start(): Promise<void> {
    const manager = getSSHConnectionManager()

    try {
      const multiplexer = getMultiplexerService(this._multiplexerKind)
      const env: Record<string, string> = {
        FULCRUM_URL: shellEscape(this.fulcrumUrl),
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        ...(this._taskId ? { FULCRUM_TASK_ID: shellEscape(this._taskId) } : {}),
      }

      const createCmd = multiplexer.getRemoteCreateCommand(this.id, {
        remoteDir: this.remoteSocketsDir,
        cwd: shellEscape(this.cwd),
        env,
      })

      await manager.execCommand(this.sshConfig, createCmd)
      log.terminal.info('Remote dtach session created', { terminalId: this.id, host: this.sshConfig.host })

      // Verify remote agent can reach Fulcrum server
      if (this.fulcrumUrl) {
        try {
          await manager.execCommand(this.sshConfig, `curl -sf --max-time 5 ${shellEscape(this.fulcrumUrl)}/health >/dev/null 2>&1`, 10000)
          log.terminal.info('Remote FULCRUM_URL reachable', { terminalId: this.id, fulcrumUrl: this.fulcrumUrl })
        } catch {
          log.terminal.warn('Remote host cannot reach Fulcrum server', {
            terminalId: this.id,
            fulcrumUrl: this.fulcrumUrl,
            hint: 'Agent CLI commands will not work. Check host fulcrumUrl setting.',
          })
        }
      }
    } catch (err) {
      log.terminal.error('Failed to create remote dtach session', { terminalId: this.id, error: String(err) })
      this.status = 'error'
      this.updateDb({ status: 'error' })
      this.onExit(1, 'error')
    }
  }

  // Attach to the remote dtach session via SSH shell
  async attach(): Promise<void> {
    if (this.stream) {
      log.terminal.debug('SSH attach called but already attached', { terminalId: this.id })
      return
    }

    const manager = getSSHConnectionManager()

    try {
      // Get a dedicated SSH connection for this terminal stream
      this.sshClient = await manager.getConnection(this.sshConfig)

      // Open interactive shell
      this.stream = await new Promise<ClientChannel>((resolve, reject) => {
        this.sshClient!.shell(
          {
            term: 'xterm-256color',
            cols: this.cols,
            rows: this.rows,
          },
          (err, stream) => {
            if (err) reject(err)
            else resolve(stream)
          },
        )
      })

      // Load saved buffer from disk before attaching
      this.buffer.loadFromDisk()

      // Attach to the remote dtach session
      const multiplexer = getMultiplexerService(this._multiplexerKind)
      this.stream.write(`${multiplexer.getRemoteAttachCommand(this.id, this.remoteSocketsDir)}\n`)

      this.setupStreamHandlers()
      this.flushInputQueue()

      log.terminal.info('SSH attach succeeded', {
        terminalId: this.id,
        host: this.sshConfig.host,
      })
    } catch (err) {
      log.terminal.error('SSH attach failed', { terminalId: this.id, error: String(err) })
      // Release SSH connection to prevent pool leak
      if (this.sshClient) {
        const manager = getSSHConnectionManager()
        manager.releaseConnection(this.sshConfig, this.sshClient)
        this.sshClient = null
      }
      this.status = 'error'
      this.updateDb({ status: 'error' })
      this.onExit(1, 'error')
    }
  }

  private setupStreamHandlers(): void {
    if (!this.stream) return

    this.stream.on('data', (data: Buffer) => {
      const text = data.toString('utf-8')

      // Auto-dismiss Claude workspace trust prompt
      if (!this.trustPromptHandled) {
        // eslint-disable-next-line no-control-regex, no-useless-escape
        const stripped = text.replace(/\x1b[\[\]()#?]*[0-9;]*[a-zA-Z~]/g, '').replace(/[\x00-\x09\x0b\x0c\x0e-\x1f]/g, '')
        this.recentOutput += stripped
        if (this.recentOutput.length > 4096) {
          this.recentOutput = this.recentOutput.slice(-4096)
        }
        if (/Yes,?\s*I\s*trust\s*this\s*folder/.test(this.recentOutput)) {
          this.trustPromptHandled = true
          this.recentOutput = ''
          log.terminal.info('Auto-dismissing workspace trust prompt (SSH)', { terminalId: this.id })
          setTimeout(() => {
            this.stream?.write('\r')
          }, 200)
        }
      }

      this.buffer.append(text)
      this.onData(text)
    })

    this.stream.on('close', () => {
      this.stream = null
      log.terminal.info('SSH stream closed', { terminalId: this.id })

      // Check if remote dtach session still exists
      this.checkRemoteSession().then((alive) => {
        if (!alive) {
          log.terminal.info('Remote dtach session gone, marking exited', { terminalId: this.id })
          this.status = 'exited'
          this.exitCode = 0
          this.updateDb({ status: 'exited', exitCode: 0 })
          this.onExit(0, 'exited')
          this.onShouldDestroy?.()
        } else {
          // Just detached from stream, dtach still running
          log.terminal.debug('SSH stream closed but remote dtach still alive', { terminalId: this.id })
        }
      }).catch(() => {
        // Can't check, assume exited
        this.status = 'exited'
        this.updateDb({ status: 'exited' })
        this.onExit(1, 'exited')
        this.onShouldDestroy?.()
      })
    })

    this.stream.stderr.on('data', (data: Buffer) => {
      const text = data.toString('utf-8')
      this.buffer.append(text)
      this.onData(text)
    })
  }

  private async checkRemoteSession(): Promise<boolean> {
    try {
      const manager = getSSHConnectionManager()
      const cmd = this._multiplexerKind === 'tmux'
        ? `tmux has-session -t ${shellEscape(`fulcrum-${this.id}`)} 2>/dev/null`
        : `test -S "$HOME/.fulcrum/sockets/terminal-${this.id}.sock"`
      await manager.execCommand(this.sshConfig, cmd)
      return true
    } catch {
      return false
    }
  }

  private flushInputQueue(): void {
    if (this.stream && this.inputQueue.length > 0) {
      for (const data of this.inputQueue) {
        this.stream.write(data)
      }
      this.inputQueue = []
    }
  }

  detach(): void {
    log.terminal.info('Detaching SSH terminal', { terminalId: this.id })
    this.buffer.saveToDisk()

    if (this.stream) {
      this.stream.close()
      this.stream = null
    }
    if (this.sshClient) {
      const manager = getSSHConnectionManager()
      manager.releaseConnection(this.sshConfig, this.sshClient)
      this.sshClient = null
    }
  }

  write(data: string): void {
    if (this.stream && this.status === 'running') {
      this.stream.write(data)
    } else if (this.status === 'running') {
      this.inputQueue.push(data)
    }
  }

  resize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
    if (this.stream) {
      this.stream.setWindow(rows, cols, rows * 16, cols * 8)
    }
    this.buffer.resize(cols, rows)
    this.updateDb({ cols, rows })
  }

  getBuffer(): string {
    return this.buffer.getContents()
  }

  clearBuffer(): void {
    this.buffer.clear()
    this.buffer.saveToDisk()
  }

  getInfo(): TerminalInfo {
    return {
      id: this.id,
      name: this.name,
      cwd: this.cwd,
      status: this.status,
      exitCode: this.exitCode,
      cols: this.cols,
      rows: this.rows,
      createdAt: this.createdAt,
      tabId: this._tabId,
      positionInTab: this._positionInTab,
      hostId: this._hostId,
      multiplexerKind: this._multiplexerKind,
    }
  }

  kill(): void {
    log.terminal.info('Killing SSH terminal', { terminalId: this.id })

    // Close local stream
    if (this.stream) {
      this.stream.close()
      this.stream = null
    }

    // Kill remote session (dtach or tmux)
    const manager = getSSHConnectionManager()
    const killCmd = this._multiplexerKind === 'tmux'
      ? `tmux kill-session -t ${shellEscape(`fulcrum-${this.id}`)} 2>/dev/null || true`
      : (() => {
          const remoteSocketPath = `$HOME/.fulcrum/sockets/terminal-${this.id}.sock`
          return [
            `pkill -f "dtach.*$HOME/.fulcrum/sockets/terminal-${this.id}.sock" 2>/dev/null || true`,
            `rm -f "${remoteSocketPath}"`,
          ].join(' && ')
        })()
    manager.execCommand(this.sshConfig, killCmd).catch((err) => {
      log.terminal.warn('Failed to kill remote session', { terminalId: this.id, multiplexerKind: this._multiplexerKind, error: String(err) })
    })

    // Release SSH connection
    if (this.sshClient) {
      manager.releaseConnection(this.sshConfig, this.sshClient)
      this.sshClient = null
    }

    this.buffer.deleteFromDisk()
    this.status = 'exited'
    log.terminal.info('SSH terminal killed', { terminalId: this.id })
  }

  async killAgentInSession(): Promise<boolean> {
    try {
      const manager = getSSHConnectionManager()
      const cmd = this._multiplexerKind === 'tmux'
        ? [
            `for PPID in $(tmux list-panes -t ${shellEscape(`fulcrum-${this.id}`)} -F '#{pane_pid}' 2>/dev/null); do`,
            `  for PID in $(pgrep -P $PPID 2>/dev/null); do`,
            `    CMDLINE=$(cat /proc/$PID/cmdline 2>/dev/null || ps -p $PID -o args= 2>/dev/null)`,
            `    if echo "$CMDLINE" | grep -qiE '(^|/)claude(\\s|$)|(^|/)opencode(\\s|$)'; then`,
            `      kill -9 $PID 2>/dev/null || true`,
            `    fi`,
            `  done`,
            `done`,
          ].join('\n')
        : (() => {
            return [
              `DTACH_PID=$(pgrep -f "dtach.*$HOME/.fulcrum/sockets/terminal-${this.id}.sock" 2>/dev/null | head -1)`,
              `if [ -n "$DTACH_PID" ]; then`,
              `  for PID in $(pgrep -P $DTACH_PID 2>/dev/null); do`,
              `    CMDLINE=$(cat /proc/$PID/cmdline 2>/dev/null || ps -p $PID -o args= 2>/dev/null)`,
              `    if echo "$CMDLINE" | grep -qiE '(^|/)claude(\\s|$)|(^|/)opencode(\\s|$)'; then`,
              `      kill -9 $PID 2>/dev/null || true`,
              `    fi`,
              `  done`,
              `fi`,
            ].join('\n')
          })()
      await manager.execCommand(this.sshConfig, cmd)
      return true
    } catch {
      return false
    }
  }

  isRunning(): boolean {
    return this.status === 'running'
  }

  isAttached(): boolean {
    return this.stream !== null
  }

  private updateDb(
    updates: Partial<{
      name: string
      cols: number
      rows: number
      status: string
      exitCode: number
      tabId: string | null
      positionInTab: number
    }>,
  ): void {
    const now = new Date().toISOString()
    db.update(terminals)
      .set({ ...updates, updatedAt: now })
      .where(eq(terminals.id, this.id))
      .run()
  }
}
