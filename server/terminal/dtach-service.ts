import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'fs'
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

// Find process IDs by matching command line arguments
function findProcessesByArg(searchArg: string): number[] {
  const pids: number[] = []
  try {
    const procDirs = readdirSync('/proc').filter((d) => /^\d+$/.test(d))
    for (const pid of procDirs) {
      try {
        const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf-8')
        if (cmdline.includes(searchArg)) {
          pids.push(parseInt(pid, 10))
        }
      } catch {
        // Process may have exited, skip
      }
    }
  } catch {
    // /proc not available (non-Linux), fallback to pgrep
    try {
      const result = execSync(`pgrep -f "${searchArg}"`, { encoding: 'utf-8' })
      for (const line of result.trim().split('\n')) {
        const pid = parseInt(line, 10)
        if (!isNaN(pid)) pids.push(pid)
      }
    } catch {
      // No matches
    }
  }
  return pids
}

// Get direct child PIDs of a process. Uses `pgrep -P` which exists on both
// macOS (BSD) and Linux; macOS BSD `ps` has no `--ppid` flag.
function getChildPids(pid: number): number[] {
  try {
    const result = execSync(`pgrep -P ${pid} || true`, { encoding: 'utf-8' })
    const out: number[] = []
    for (const line of result.split('\n')) {
      const childPid = parseInt(line.trim(), 10)
      if (!isNaN(childPid)) out.push(childPid)
    }
    return out
  } catch {
    return []
  }
}

// Get all descendant PIDs of a process (transitive closure).
function getDescendantPids(pid: number): number[] {
  const descendants: number[] = []
  for (const childPid of getChildPids(pid)) {
    descendants.push(childPid)
    descendants.push(...getDescendantPids(childPid))
  }
  return descendants
}

// Combined pattern for all supported AI agents (Claude Code, OpenCode)
// Must be preceded by / or start, and followed by whitespace/null/end
// This avoids matching directory paths like /fulcrum/opencode/sockets/ or /worktrees/claude-test/
const AGENT_PATTERN = /(^|\/)(claude|opencode)(\s|\0|$)/i

// Check if a process is an AI agent process by examining its command line
function isAgentProcess(pid: number): boolean {
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf-8')
    return AGENT_PATTERN.test(cmdline)
  } catch {
    // /proc not available (non-Linux), try ps
    try {
      const result = execSync(`ps -p ${pid} -o args= 2>/dev/null || true`, {
        encoding: 'utf-8',
      })
      return AGENT_PATTERN.test(result)
    } catch {
      return false
    }
  }
}

// Kill a process tree (parent and all descendants)
export function killProcessTree(pid: number): void {
  const descendants = getDescendantPids(pid)

  // Kill children first (deepest first), then parent
  for (const childPid of descendants.reverse()) {
    try {
      process.kill(childPid, 'SIGKILL')
    } catch {
      // Process may have already exited
    }
  }

  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // Process may have already exited
  }
}

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
      throw new Error('tmux multiplexer not yet implemented')
  }
}

export function resetMultiplexerService(): void {
  dtachService = null
}

/**
 * @deprecated Use resetMultiplexerService instead
 */
export const resetDtachService = resetMultiplexerService
