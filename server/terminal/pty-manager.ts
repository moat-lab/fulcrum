import { TerminalSession } from './terminal-session'
import { SSHTerminalSession } from './ssh-terminal-session'
import { getDtachService, DtachService } from './dtach-service'
import { destroyTerminalAndBroadcast } from './pty-instance'
import { db, terminals, hosts } from '../db'
import { eq, ne } from 'drizzle-orm'
import * as os from 'os'
import type { TerminalInfo } from '../types'
import type { ITerminalSession } from './session-interface'
import { log } from '../lib/logger'
import { getFulcrumDir, getSettingByKey } from '../lib/settings'
import { getSSHConnectionManager } from './ssh-connection-manager'

import type { TerminalStatus } from '../types'

export interface PTYManagerCallbacks {
  onData: (terminalId: string, data: string) => void
  onExit: (terminalId: string, exitCode: number, status: TerminalStatus) => void
}

export class PTYManager {
  private sessions = new Map<string, ITerminalSession>()
  private callbacks: PTYManagerCallbacks

  constructor(callbacks: PTYManagerCallbacks) {
    this.callbacks = callbacks
  }

  // Called on server startup to restore terminals from DB
  async restoreFromDatabase(): Promise<void> {
    // Check if dtach is available
    if (!DtachService.isAvailable()) {
      log.pty.error('dtach is not installed, terminal persistence disabled')
      return
    }

    const dtach = getDtachService()
    const storedTerminals = db
      .select()
      .from(terminals)
      .where(ne(terminals.status, 'exited'))
      .all()

    log.pty.info('Restoring terminals from database', {
      count: storedTerminals.length,
      ids: storedTerminals.map((t) => t.id),
      cwds: storedTerminals.map((t) => t.cwd),
    })

    const MAX_RETRIES = 3
    const RETRY_DELAY_MS = 100
    let restoredCount = 0
    let skippedCount = 0

    for (const record of storedTerminals) {
      // Remote SSH terminals - try to reconnect to remote dtach
      if (record.hostId) {
        const host = db.select().from(hosts).where(eq(hosts.id, record.hostId)).get()
        if (!host) {
          log.pty.warn('Host not found for remote terminal, marking exited', {
            terminalId: record.id,
            hostId: record.hostId,
          })
          db.update(terminals)
            .set({ status: 'exited', updatedAt: new Date().toISOString() })
            .where(eq(terminals.id, record.id))
            .run()
          skippedCount++
          continue
        }

        // Create SSH session object (will check remote dtach on attach)
        const sshConfig = {
          host: host.hostname,
          port: host.port,
          username: host.username,
          authMethod: host.authMethod as 'key' | 'password',
          privateKeyPath: host.privateKeyPath ?? undefined,
          password: host.password ?? undefined,
          hostFingerprint: host.hostFingerprint ?? undefined,
        }
        const fulcrumUrl = host.fulcrumUrl
        if (!fulcrumUrl) {
          log.pty.warn('Host has no fulcrumUrl configured, remote agent CLI will not work', { hostId: host.id, hostName: host.name })
        }
        const effectiveFulcrumUrl = fulcrumUrl || `http://localhost:${getSettingByKey('port')}`

        const session = new SSHTerminalSession({
          id: record.id,
          name: record.name,
          cols: record.cols,
          rows: record.rows,
          cwd: record.cwd,
          createdAt: new Date(record.createdAt).getTime(),
          tabId: record.tabId ?? undefined,
          positionInTab: record.positionInTab ?? 0,
          hostId: host.id,
          sshConfig,
          fulcrumUrl: effectiveFulcrumUrl,
          onData: (data) => this.callbacks.onData(record.id, data),
          onExit: (exitCode, status) => this.callbacks.onExit(record.id, exitCode, status),
          onShouldDestroy: () => {
            queueMicrotask(() => destroyTerminalAndBroadcast(record.id))
          },
        })
        this.sessions.set(record.id, session)

        // Background health check for remote terminals
        const manager = getSSHConnectionManager()
        queueMicrotask(async () => {
          try {
            const remoteSocketPath = `/home/${sshConfig.username}/.fulcrum/sockets/terminal-${record.id}.sock`
            await manager.execCommand(sshConfig, `test -S '${remoteSocketPath}'`, 10000)
          } catch {
            log.pty.warn('Remote dtach session not found, marking exited', { terminalId: record.id })
            db.update(terminals).set({ status: 'exited', updatedAt: new Date().toISOString() }).where(eq(terminals.id, record.id)).run()
            this.sessions.delete(record.id)
          }
        })

        log.pty.info('Remote terminal restored (will attach on demand)', {
          terminalId: record.id,
          host: host.hostname,
        })
        restoredCount++
        continue
      }

      // Local terminals - existing dtach logic
      const socketPath = dtach.getSocketPath(record.id)

      // Retry socket check a few times with small delays to handle timing issues
      let socketFound = false
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        if (dtach.hasSession(record.id)) {
          socketFound = true
          break
        }
        if (attempt < MAX_RETRIES - 1) {
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
        }
      }

      if (socketFound) {
        // Validate the socket is actually functional
        const socketValid = dtach.validateSocket(record.id)
        if (!socketValid) {
          log.pty.warn('Socket exists but validation failed (stale)', {
            terminalId: record.id,
            name: record.name,
            socketPath,
          })
          // Mark as exited since socket is stale
          db.update(terminals)
            .set({ status: 'exited', updatedAt: new Date().toISOString() })
            .where(eq(terminals.id, record.id))
            .run()
          skippedCount++
          continue
        }

        // Session exists and is valid - create TerminalSession object (but don't attach yet)
        const session = new TerminalSession({
          id: record.id,
          name: record.name,
          cols: record.cols,
          rows: record.rows,
          cwd: record.cwd,
          createdAt: new Date(record.createdAt).getTime(),
          tabId: record.tabId ?? undefined,
          positionInTab: record.positionInTab ?? 0,
          onData: (data) => this.callbacks.onData(record.id, data),
          onExit: (exitCode, status) => this.callbacks.onExit(record.id, exitCode, status),
          onShouldDestroy: () => {
            // Use queueMicrotask to avoid destroying while in exit handler
            queueMicrotask(() => destroyTerminalAndBroadcast(record.id))
          },
        })
        this.sessions.set(record.id, session)
        log.pty.info('Socket found and valid for terminal', {
          terminalId: record.id,
          name: record.name,
          cwd: record.cwd,
          socketPath,
        })
        restoredCount++
      } else {
        // Session is gone after retries - mark as exited
        db.update(terminals)
          .set({ status: 'exited', updatedAt: new Date().toISOString() })
          .where(eq(terminals.id, record.id))
          .run()
        log.pty.warn('Socket NOT found for terminal', {
          terminalId: record.id,
          name: record.name,
          cwd: record.cwd,
          expectedPath: socketPath,
          fulcrumDir: getFulcrumDir(),
        })
        skippedCount++
      }
    }

    log.pty.info('Terminal restore complete', {
      restored: restoredCount,
      skipped: skippedCount,
      total: storedTerminals.length,
      restoredIds: Array.from(this.sessions.keys()),
    })
  }

  async create(options: {
    name: string
    cols: number
    rows: number
    cwd?: string
    tabId?: string
    positionInTab?: number
    taskId?: string
    hostId?: string
  }): Promise<TerminalInfo> {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()

    // Remote SSH terminal
    if (options.hostId) {
      const host = db.select().from(hosts).where(eq(hosts.id, options.hostId)).get()
      if (!host) {
        throw new Error(`Host not found: ${options.hostId}`)
      }

      const cwd = options.cwd || host.defaultDirectory || `/home/${host.username}`
      const sshConfig = {
        host: host.hostname,
        port: host.port,
        username: host.username,
        authMethod: host.authMethod as 'key' | 'password',
        privateKeyPath: host.privateKeyPath ?? undefined,
        password: host.password ?? undefined,
        hostFingerprint: host.hostFingerprint ?? undefined,
      }
      const fulcrumUrl = host.fulcrumUrl
      if (!fulcrumUrl) {
        log.pty.warn('Host has no fulcrumUrl configured, remote agent CLI will not work', { hostId: host.id, hostName: host.name })
      }
      const effectiveFulcrumUrl = fulcrumUrl || `http://localhost:${getSettingByKey('port')}`

      // Persist to database
      db.insert(terminals)
        .values({
          id,
          name: options.name,
          cwd,
          cols: options.cols,
          rows: options.rows,
          tmuxSession: '',
          status: 'running',
          tabId: options.tabId,
          positionInTab: options.positionInTab ?? 0,
          hostId: options.hostId,
          createdAt: now,
          updatedAt: now,
        })
        .run()

      const session = new SSHTerminalSession({
        id,
        name: options.name,
        cols: options.cols,
        rows: options.rows,
        cwd,
        createdAt: Date.now(),
        tabId: options.tabId,
        positionInTab: options.positionInTab,
        taskId: options.taskId,
        hostId: host.id,
        sshConfig,
        fulcrumUrl: effectiveFulcrumUrl,
        onData: (data) => this.callbacks.onData(id, data),
        onExit: (exitCode, status) => this.callbacks.onExit(id, exitCode, status),
        onShouldDestroy: () => {
          queueMicrotask(() => destroyTerminalAndBroadcast(id))
        },
      })

      this.sessions.set(id, session)
      await session.start()
      return session.getInfo()
    }

    // Local terminal (existing behavior)
    if (!DtachService.isAvailable()) {
      throw new Error('dtach is not installed')
    }

    const cwd = options.cwd || os.homedir()

    // Persist to database first
    db.insert(terminals)
      .values({
        id,
        name: options.name,
        cwd,
        cols: options.cols,
        rows: options.rows,
        tmuxSession: '', // Not used with dtach but required by schema
        status: 'running',
        tabId: options.tabId,
        positionInTab: options.positionInTab ?? 0,
        createdAt: now,
        updatedAt: now,
      })
      .run()

    // Create session object
    const session = new TerminalSession({
      id,
      name: options.name,
      cols: options.cols,
      rows: options.rows,
      cwd,
      createdAt: Date.now(),
      tabId: options.tabId,
      positionInTab: options.positionInTab,
      taskId: options.taskId,
      onData: (data) => this.callbacks.onData(id, data),
      onExit: (exitCode, status) => this.callbacks.onExit(id, exitCode, status),
      onShouldDestroy: () => {
        // Use queueMicrotask to avoid destroying while in exit handler
        queueMicrotask(() => destroyTerminalAndBroadcast(id))
      },
    })

    this.sessions.set(id, session)

    // Start the dtach session (creates and attaches)
    session.start()

    return session.getInfo()
  }

  // Called when client attaches - ensures PTY is connected
  async attach(terminalId: string): Promise<boolean> {
    const session = this.sessions.get(terminalId)
    if (!session) return false
    if (!session.isAttached()) {
      await session.attach()
    }
    return true
  }

  destroy(terminalId: string): boolean {
    const session = this.sessions.get(terminalId)
    if (!session) {
      log.pty.warn('destroy called for non-existent terminal', { terminalId })
      return false
    }

    const info = session.getInfo()
    log.pty.info('Destroying terminal', {
      terminalId,
      name: info.name,
      cwd: info.cwd,
      tabId: info.tabId,
      stack: new Error().stack?.split('\n').slice(1, 6).join('\n'),
    })

    session.kill()
    this.sessions.delete(terminalId)

    // Remove from database
    db.delete(terminals).where(eq(terminals.id, terminalId)).run()

    return true
  }

  write(terminalId: string, data: string): boolean {
    const session = this.sessions.get(terminalId)
    if (!session) {
      return false
    }

    session.write(data)
    return true
  }

  resize(terminalId: string, cols: number, rows: number): boolean {
    const session = this.sessions.get(terminalId)
    if (!session) {
      return false
    }

    session.resize(cols, rows)
    return true
  }

  rename(terminalId: string, name: string): boolean {
    const session = this.sessions.get(terminalId)
    if (!session) {
      return false
    }

    session.rename(name)
    return true
  }

  assignTab(terminalId: string, tabId: string | null, positionInTab?: number): boolean {
    const session = this.sessions.get(terminalId)
    if (!session) {
      return false
    }

    session.assignTab(tabId, positionInTab)
    return true
  }

  getBuffer(terminalId: string): string | null {
    const session = this.sessions.get(terminalId)
    if (!session) {
      return null
    }

    return session.getBuffer()
  }

  async flushPending(terminalId: string): Promise<void> {
    const session = this.sessions.get(terminalId)
    if (!session) return
    await session.flushPending()
  }

  clearBuffer(terminalId: string): boolean {
    const session = this.sessions.get(terminalId)
    if (!session) {
      return false
    }

    session.clearBuffer()
    return true
  }

  getInfo(terminalId: string): TerminalInfo | null {
    const session = this.sessions.get(terminalId)
    if (!session) {
      return null
    }

    return session.getInfo()
  }

  listTerminals(): TerminalInfo[] {
    const terminals = Array.from(this.sessions.values()).map((s) => s.getInfo())
    log.pty.debug('listTerminals called', {
      count: terminals.length,
      terminals: terminals.map((t) => ({ id: t.id, name: t.name, cwd: t.cwd, tabId: t.tabId })),
    })
    return terminals
  }

  // Kill Claude processes in a specific terminal (but keep terminal running)
  killClaudeInTerminal(terminalId: string): boolean {
    const session = this.sessions.get(terminalId)
    if (!session) {
      return false
    }

    // SSH sessions handle agent killing via remote exec
    if (session instanceof SSHTerminalSession) {
      session.killAgentInSession().catch((err) => {
        log.pty.warn('Failed to kill agent in SSH session', { terminalId, error: String(err) })
      })
      return true
    }

    const dtach = getDtachService()
    return dtach.killClaudeInSession(terminalId)
  }

  // Detach all PTYs but keep dtach sessions running
  detachAll(): void {
    for (const session of this.sessions.values()) {
      session.detach()
    }
  }

  // Kill all terminals and their dtach sessions
  destroyAll(): void {
    for (const session of this.sessions.values()) {
      session.kill()
      db.delete(terminals).where(eq(terminals.id, session.id)).run()
    }
    this.sessions.clear()
  }
}
