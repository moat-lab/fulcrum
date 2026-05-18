import { existsSync, mkdirSync, statSync } from 'fs'
import * as path from 'path'
import { execSync } from 'child_process'
import { getFulcrumDir } from '../lib/settings'
import { log } from '../lib/logger'
import type {
  DtachMultiplexer,
  MultiplexerKind,
  MultiplexerService,
  RemoteSessionOptions,
} from './multiplexer-service'
import { findProcessesByArg, getDescendantPids, isAgentProcess, killProcessTree } from './process-utils'
import { getTmuxService, resetTmuxService } from './tmux-service'

export { killProcessTree } from './process-utils'

export class DtachService implements DtachMultiplexer {
  readonly kind = 'dtach' as const
  private socketsDir: string

  constructor() {
    this.socketsDir = path.join(getFulcrumDir(), 'sockets')
    // Ensure sockets directory exists
    if (!existsSync(this.socketsDir)) {
      mkdirSync(this.socketsDir, { recursive: true })
    }
  }

  getSessionIdentifier(terminalId: string): string {
    return path.join(this.socketsDir, `terminal-${terminalId}.sock`)
  }

  hasSession(terminalId: string): boolean {
    return existsSync(this.getSessionIdentifier(terminalId))
  }

  validateSession(terminalId: string): boolean {
    const socketPath = this.getSessionIdentifier(terminalId)

    if (!existsSync(socketPath)) {
      log.pty.debug('validateSession: socket file does not exist', { terminalId, socketPath })
      return false
    }

    try {
      const stats = statSync(socketPath)
      if (!stats.isSocket()) {
        log.pty.warn('validateSession: path exists but is not a socket', {
          terminalId,
          socketPath,
          mode: stats.mode,
        })
        return false
      }
    } catch (err) {
      log.pty.warn('validateSession: failed to stat socket', {
        terminalId,
        socketPath,
        error: String(err),
      })
      return false
    }

    try {
      const dtachPids = findProcessesByArg(socketPath)
      if (dtachPids.length === 0) {
        log.pty.warn('validateSession: no dtach process found for socket', {
          terminalId,
          socketPath,
        })
        return false
      }

      log.pty.debug('validateSession: dtach process found', {
        terminalId,
        socketPath,
        pids: dtachPids,
      })
      return true
    } catch (err) {
      log.pty.warn('validateSession: failed to find dtach process', {
        terminalId,
        socketPath,
        error: String(err),
      })
      return false
    }
  }

  getLocalCreateCommand(terminalId: string): string[] {
    const socketPath = this.getSessionIdentifier(terminalId)
    const shell = process.env.SHELL || '/bin/bash'
    return ['dtach', '-n', socketPath, '-z', shell, '-li']
  }

  getRemoteCreateCommand(terminalId: string, options: RemoteSessionOptions): string {
    const remoteSocketPath = `${options.remoteDir}/terminal-${terminalId}.sock`
    const envExports = options.env
      ? Object.entries(options.env).map(([k, v]) => `export ${k}=${v}`).join(' && ')
      : ''
    const envPrefix = envExports ? `${envExports} && ` : ''
    return [
      `mkdir -p ${options.remoteDir}`,
      `cd ${options.cwd}`,
      `${envPrefix}dtach -n ${remoteSocketPath} -z bash -li`,
    ].join(' && ')
  }

  getLocalAttachCommand(terminalId: string): string[] {
    const socketPath = this.getSessionIdentifier(terminalId)
    return ['bash', '-c', `stty -echoctl && exec dtach -a ${socketPath} -z`]
  }

  getRemoteAttachCommand(terminalId: string, remoteDir: string): string {
    const remoteSocketPath = `${remoteDir}/terminal-${terminalId}.sock`
    return `stty -echoctl && exec dtach -a ${remoteSocketPath} -z`
  }

  killSession(terminalId: string): void {
    const socketPath = this.getSessionIdentifier(terminalId)
    const dtachPids = findProcessesByArg(socketPath)

    for (const pid of dtachPids) {
      killProcessTree(pid)
    }
  }

  killAgentInSession(terminalId: string): boolean {
    const socketPath = this.getSessionIdentifier(terminalId)
    const dtachPids = findProcessesByArg(socketPath)

    let killedAny = false
    for (const dtachPid of dtachPids) {
      const descendants = getDescendantPids(dtachPid)
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
      execSync('which dtach', { encoding: 'utf-8' })
      return true
    } catch {
      return false
    }
  }
}

// Singleton
let dtachService: DtachService | null = null

export function getDtachService(): DtachService {
  if (!dtachService) {
    dtachService = new DtachService()
  }
  return dtachService
}

export function getMultiplexerService(kind: MultiplexerKind): MultiplexerService {
  switch (kind) {
    case 'dtach':
      return getDtachService()
    case 'tmux':
      return getTmuxService()
  }
}

export function resetMultiplexerService(): void {
  dtachService = null
  resetTmuxService()
}

/**
 * @deprecated Use resetMultiplexerService instead
 */
export const resetDtachService = resetMultiplexerService
