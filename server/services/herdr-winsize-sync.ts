// Resolve the dual-attach winsize conflict on dtach task sessions.
//
// Background: a fulcrum task terminal lives in a `dtach` session with two
// attached clients — bun-pty (browser via xterm.js) and a herdr pane (running
// `dtach -a` as its foreground process). dtach forwards SIGWINCH from
// whichever client most recently resized to the master PTY. When the two
// clients have different cols/rows the master flips between them and the
// rendered view that doesn't currently match the master shows garbage.
//
// herdr exposes no `pane.resize` RPC. Forcing herdr's pane PTY to the browser
// size via `stty -F /proc/<pid>/fd/0` works: the kernel raises SIGWINCH on
// the herdr-side dtach client, which forwards the new size through the dtach
// socket to the master PTY. We do that on every browser resize so the master
// stays at the browser's dimensions and the browser xterm never sees wider
// content than its grid.
//
// Trade-off: when herdr's pane is shorter than the browser's xterm, the
// alt-screen TUI (claude code's fullscreen renderer, htop, etc.) draws more
// rows than the herdr pane can display — herdr clips the bottom rows. The
// user explicitly accepted this: fulcrum is the primary view, herdr is a
// secondary mirror, fulcrum's full height matters more than herdr's full TUI
// visibility.
//
// Linux-only. /proc layout doesn't exist on macOS; this becomes a no-op
// there (the herdr-mirror feature has the same Linux-leaning shape today).

import { readFileSync, readdirSync, existsSync } from 'fs'
import { execSync } from 'child_process'
import { log } from '../lib/logger'
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
 * Force the herdr-side dtach client's slave PTY to the given dimensions. The
 * kernel SIGWINCHes the foreground process (dtach -a), which forwards the new
 * size to the master, bringing both clients into agreement. No-op if there's
 * no mirror attached or /proc isn't available. Never throws — mirror-sync
 * failure must not break the browser path.
 */
export function syncMirrorWinsize(terminalId: string, cols: number, rows: number): void {
  if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 2 || rows < 2) return
  if (!existsSync('/proc')) return

  const socketPath = getDtachService().getSocketPath(terminalId)
  const pid = findMirrorDtachPid(socketPath)
  if (pid === null) return // no mirror attached — common case

  const fdPath = `/proc/${pid}/fd/0`
  if (!existsSync(fdPath)) return

  try {
    execSync(`stty -F ${fdPath} cols ${cols} rows ${rows}`, {
      stdio: 'ignore',
      timeout: 1000,
    })
  } catch (err) {
    log.terminal.warn('mirror winsize sync failed (continuing)', {
      terminalId,
      pid,
      cols,
      rows,
      error: String(err),
    })
  }
}

/**
 * Resolve once the herdr-side dtach -a process appears for this terminal, or
 * after `attempts * intervalMs` of polling. Used by `mirrorTerminal` to defer
 * the post-mirror resize until the mirror is actually attached.
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
