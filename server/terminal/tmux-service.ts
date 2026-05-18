import { execSync } from 'child_process'
import { log } from '../lib/logger'
import type {
  MultiplexerSessionInfo,
  RemoteSessionOptions,
  TmuxMultiplexer,
} from './multiplexer-service'
import { getDescendantPids, isAgentProcess, killProcessTree } from './process-utils'

const SESSION_PREFIX = 'fulcrum-'

export class TmuxService implements TmuxMultiplexer {
  readonly kind = 'tmux' as const

  getSessionIdentifier(terminalId: string): string {
    return `${SESSION_PREFIX}${terminalId}`
  }

  hasSession(terminalId: string): boolean {
    const sessionName = this.getSessionIdentifier(terminalId)
    try {
      execSync(`tmux has-session -t ${sessionName} 2>/dev/null`, { encoding: 'utf-8' })
      return true
    } catch {
      return false
    }
  }

  validateSession(terminalId: string): boolean {
    const sessionName = this.getSessionIdentifier(terminalId)

    if (!this.hasSession(terminalId)) {
      log.pty.debug('validateSession: tmux session does not exist', { terminalId, sessionName })
      return false
    }

    try {
      const pids = this.getSessionPanePids(sessionName)
      if (pids.length === 0) {
        log.pty.warn('validateSession: tmux session has no pane processes', {
          terminalId,
          sessionName,
        })
        return false
      }

      log.pty.debug('validateSession: tmux session valid', {
        terminalId,
        sessionName,
        panePids: pids,
      })
      return true
    } catch (err) {
      log.pty.warn('validateSession: failed to validate tmux session', {
        terminalId,
        sessionName,
        error: String(err),
      })
      return false
    }
  }

  getLocalCreateCommand(terminalId: string): string[] {
    const sessionName = this.getSessionIdentifier(terminalId)
    const shell = process.env.SHELL || '/bin/bash'
    return ['tmux', 'new-session', '-d', '-s', sessionName, shell, '-li']
  }

  getRemoteCreateCommand(terminalId: string, options: RemoteSessionOptions): string {
    const sessionName = this.getSessionIdentifier(terminalId)
    const envExports = options.env
      ? Object.entries(options.env).map(([k, v]) => `export ${k}=${v}`).join(' && ')
      : ''
    const envPrefix = envExports ? `${envExports} && ` : ''
    return [
      `cd ${options.cwd}`,
      `${envPrefix}tmux new-session -d -s ${sessionName} bash -li`,
    ].join(' && ')
  }

  getLocalAttachCommand(terminalId: string): string[] {
    const sessionName = this.getSessionIdentifier(terminalId)
    return ['tmux', 'attach-session', '-t', sessionName]
  }

  getRemoteAttachCommand(terminalId: string, _remoteDir: string): string {
    const sessionName = this.getSessionIdentifier(terminalId)
    return `tmux attach-session -t ${sessionName}`
  }

  killSession(terminalId: string): void {
    const sessionName = this.getSessionIdentifier(terminalId)
    try {
      execSync(`tmux kill-session -t ${sessionName} 2>/dev/null`, { encoding: 'utf-8' })
    } catch {
      // Session may not exist
    }
  }

  killAgentInSession(terminalId: string): boolean {
    const sessionName = this.getSessionIdentifier(terminalId)

    if (!this.hasSession(terminalId)) {
      return false
    }

    const panePids = this.getSessionPanePids(sessionName)
    let killedAny = false

    for (const panePid of panePids) {
      const descendants = getDescendantPids(panePid)
      for (const pid of descendants) {
        if (isAgentProcess(pid)) {
          killProcessTree(pid)
          killedAny = true
        }
      }
    }

    return killedAny
  }

  isAvailable(): boolean {
    try {
      execSync('which tmux', { encoding: 'utf-8' })
      return true
    } catch {
      return false
    }
  }

  capturePaneContent(sessionId: string): string {
    try {
      return execSync(`tmux capture-pane -t ${sessionId} -p`, { encoding: 'utf-8' })
    } catch (err) {
      log.pty.warn('capturePaneContent: failed', { sessionId, error: String(err) })
      return ''
    }
  }

  sendKeys(sessionId: string, keys: string): void {
    try {
      execSync(`tmux send-keys -t ${sessionId} ${JSON.stringify(keys)} Enter`, {
        encoding: 'utf-8',
      })
    } catch (err) {
      log.pty.warn('sendKeys: failed', { sessionId, error: String(err) })
    }
  }

  listManagedSessions(): MultiplexerSessionInfo[] {
    try {
      const output = execSync(
        `tmux list-sessions -F '#{session_name}|#{session_created}|#{session_attached}' 2>/dev/null`,
        { encoding: 'utf-8' },
      )

      const sessions: MultiplexerSessionInfo[] = []
      for (const line of output.trim().split('\n')) {
        if (!line) continue
        const [name, createdStr, attachedStr] = line.split('|')
        if (!name?.startsWith(SESSION_PREFIX)) continue

        const id = name.slice(SESSION_PREFIX.length)
        const createdAt = createdStr ? parseInt(createdStr, 10) * 1000 : null
        const attached = attachedStr === '1'

        sessions.push({ id, name, createdAt, attached })
      }

      return sessions
    } catch {
      return []
    }
  }

  getSessionPanePids(sessionName: string): number[] {
    try {
      const output = execSync(
        `tmux list-panes -t ${sessionName} -F '#{pane_pid}' 2>/dev/null`,
        { encoding: 'utf-8' },
      )
      const pids: number[] = []
      for (const line of output.trim().split('\n')) {
        const pid = parseInt(line.trim(), 10)
        if (!isNaN(pid)) pids.push(pid)
      }
      return pids
    } catch {
      return []
    }
  }
}

let tmuxService: TmuxService | null = null

export function getTmuxService(): TmuxService {
  if (!tmuxService) {
    tmuxService = new TmuxService()
  }
  return tmuxService
}

export function resetTmuxService(): void {
  tmuxService = null
}
