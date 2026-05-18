import { readdirSync, readFileSync } from 'fs'
import { execSync } from 'child_process'

export function findProcessesByArg(searchArg: string): number[] {
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

export function getDescendantPids(pid: number): number[] {
  const descendants: number[] = []
  for (const childPid of getChildPids(pid)) {
    descendants.push(childPid)
    descendants.push(...getDescendantPids(childPid))
  }
  return descendants
}

export const AGENT_PATTERN = /(^|\/)(claude|opencode)(\s|\0|$)/i

export function isAgentProcess(pid: number): boolean {
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

export function killProcessTree(pid: number): void {
  const descendants = getDescendantPids(pid)

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
