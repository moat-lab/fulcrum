// Resolve the dual-attach winsize conflict on dtach task sessions.
//
// Background: a fulcrum task terminal lives in a `dtach` session with two
// attached clients — bun-pty (browser via xterm.js) and a herdr pane (running
// `dtach -a` as its foreground process). dtach forwards SIGWINCH from
// whichever client most recently resized to the master PTY. When the two
// clients have different cols/rows the master flips between them and the
// rendered view that doesn't currently match the master shows garbage (the
// original bug: clipboard-2026-05-26-003503.png).
//
// herdr exposes no `pane.resize` RPC, so we can't reshape herdr to match the
// browser. The reverse — forcing herdr's pane PTY to the browser size via
// `stty -F /proc/<pid>/fd/0` — works but clips the bottom of TUIs whenever
// herdr's pane is shorter than the browser (clipboard-2026-05-26-011725.png).
//
// Final strategy: read the herdr-side dtach client's natural winsize from
// /proc, compute `min(browser, herdr)` in TerminalSession.resize(), and call
// `pty.resize` on the bun-pty side at that MIN. The bun-side dtach -a
// SIGWINCHes the master to MIN, which fits both clients. We do NOT write to
// the herdr-side PTY — herdr keeps its natural size, the browser renders its
// own larger grid with empty space on the right/bottom, and neither view
// clips the TUI content.
//
// Linux-only. /proc layout doesn't exist on macOS; this becomes a no-op
// there (the herdr-mirror feature has the same Linux-leaning shape today).

import { readFileSync, readdirSync, existsSync } from 'fs'
import { execSync } from 'child_process'
import { getDtachService } from '../terminal/dtach-service'

/** Read PPid from /proc/<pid>/status. Returns 0 on any failure. */
function readPpid(pid: number): number {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf-8')
    const match = status.match(/^PPid:\s*(\d+)/m)
    return match ? parseInt(match[1], 10) : 0
  } catch {
    return 0
  }
}

/** Walk up from `pid`, return true if `ancestor` is reached within `maxDepth`. */
function hasAncestor(pid: number, ancestor: number, maxDepth = 16): boolean {
  let cur = pid
  for (let i = 0; i < maxDepth; i++) {
    const ppid = readPpid(cur)
    if (ppid === 0 || ppid === 1) return false
    if (ppid === ancestor) return true
    cur = ppid
  }
  return false
}

/**
 * Find every `dtach -a <socketPath>` process. We require both the `-a` flag
 * and the socket path so we don't pick up the orphaned `dtach -n` master
 * (parent of the actual shell, ppid=systemd, fd 0 is the master PTY end —
 * stty against that fails).
 */
function findDtachAttachPids(socketPath: string): number[] {
  if (!existsSync('/proc')) return []
  const pids: number[] = []
  try {
    for (const dir of readdirSync('/proc')) {
      if (!/^\d+$/.test(dir)) continue
      try {
        // cmdline is NUL-separated argv. Look for a "-a" arg followed by the
        // socket path arg — that's the unique signature of an attach client.
        const cmdline = readFileSync(`/proc/${dir}/cmdline`, 'utf-8')
        const args = cmdline.split('\0')
        if (!args[0]?.endsWith('dtach')) continue
        const aIdx = args.indexOf('-a')
        if (aIdx < 0) continue
        if (args[aIdx + 1] !== socketPath) continue
        pids.push(parseInt(dir, 10))
      } catch {
        // process exited between readdir and readFile
      }
    }
  } catch {
    // /proc gone? give up
  }
  return pids
}

/**
 * Identify the herdr-side dtach -a process for a given socket path: it's the
 * `dtach -a <socketPath>` whose ancestor chain does NOT contain the fulcrum
 * server (this Bun process). There can be at most one such process per socket
 * in practice (one browser, one herdr mirror).
 */
function findMirrorDtachPid(socketPath: string): number | null {
  const selfPid = process.pid
  const candidates = findDtachAttachPids(socketPath)
  for (const pid of candidates) {
    if (!hasAncestor(pid, selfPid)) return pid
  }
  return null
}

/**
 * Read the current slave-PTY winsize of the herdr-side dtach client. Returns
 * null if there's no mirror attached, /proc isn't available, or stty fails.
 *
 * Used by `TerminalSession.resize()` to compute the smallest-common-denominator
 * size — both the browser and herdr pane have to fit, so the master PTY must
 * be `min(browser, herdr)`. Otherwise whichever client is smaller renders a
 * cut-off TUI.
 */
export function readMirrorWinsize(
  terminalId: string
): { cols: number; rows: number } | null {
  if (!existsSync('/proc')) return null
  const socketPath = getDtachService().getSocketPath(terminalId)
  const pid = findMirrorDtachPid(socketPath)
  if (pid === null) return null
  const fdPath = `/proc/${pid}/fd/0`
  if (!existsSync(fdPath)) return null
  try {
    const out = execSync(`stty -F ${fdPath} size`, {
      encoding: 'utf-8',
      timeout: 1000,
    }).trim()
    const [rowsStr, colsStr] = out.split(/\s+/)
    const rows = parseInt(rowsStr, 10)
    const cols = parseInt(colsStr, 10)
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 2 || rows < 2) {
      return null
    }
    return { cols, rows }
  } catch {
    return null
  }
}

/**
 * Resolve once the herdr-side dtach -a process appears for this terminal, or
 * after `attempts * intervalMs` of polling. Used by `mirrorTerminal` to defer
 * the post-mirror resize until the mirror is actually attached — calling
 * resize earlier would just MIN against a non-existent mirror.
 */
export async function waitForMirrorAttached(
  terminalId: string,
  opts: { attempts?: number; intervalMs?: number } = {}
): Promise<boolean> {
  const attempts = opts.attempts ?? 20
  const intervalMs = opts.intervalMs ?? 150
  if (!existsSync('/proc')) return false
  const socketPath = getDtachService().getSocketPath(terminalId)
  for (let i = 0; i < attempts; i++) {
    if (findMirrorDtachPid(socketPath) !== null) return true
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return false
}
