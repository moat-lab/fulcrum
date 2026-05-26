// Sync the herdr-side dtach client's PTY winsize to the browser's dimensions.
//
// Background: a fulcrum task terminal lives in a `dtach` session that has two
// attached clients — bun-pty (browser via xterm.js) and a herdr pane (running
// `dtach -a` as its foreground process). dtach forwards SIGWINCH from
// whichever client most recently resized to the master PTY. When the two
// clients have different cols/rows, the master PTY's winsize flips between
// them and one of the rendered views (the one whose grid no longer matches
// what the TUI just drew) shows half-overlapping glyphs.
//
// herdr exposes no `pane.resize` RPC, so we can't tell herdr to change the
// pane's size. Instead we reach down to the kernel: locate the herdr-side
// `dtach -a` process by its socket-path argument, walk parent PIDs to confirm
// it's the one whose ancestor is herdr (not the fulcrum server), and run
// `stty -F /proc/<pid>/fd/0 cols X rows Y` against its slave PTY. That
// TIOCSWINSZ raises SIGWINCH on dtach -a, which forwards the new size through
// the dtach socket to the master PTY — bringing both clients into agreement.
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
 * Force the herdr-side dtach client's PTY to the given dimensions. No-op if
 * the herdr pane isn't attached yet, or if /proc isn't available (macOS).
 * Never throws — mirror-sync failure must not break the browser path.
 */
export function syncMirrorWinsize(terminalId: string, cols: number, rows: number): void {
  if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 2 || rows < 2) return
  if (!existsSync('/proc')) return

  const socketPath = getDtachService().getSocketPath(terminalId)
  const pid = findMirrorDtachPid(socketPath)
  if (pid === null) {
    // No herdr-side mirror attached — common case when herdr mirror is
    // disabled or the pane was closed.
    return
  }

  const fdPath = `/proc/${pid}/fd/0`
  if (!existsSync(fdPath)) return

  try {
    // stty exits 0 silently on success. Use a short timeout so a hung stty
    // can't block the resize path.
    execSync(`stty -F ${fdPath} cols ${cols} rows ${rows}`, {
      stdio: 'ignore',
      timeout: 1000,
    })
    log.terminal.debug('mirror winsize synced', { terminalId, pid, cols, rows })
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
 * Poll for the herdr-side dtach client to appear, then sync its winsize.
 * Called once after `mirrorTerminal` spawns the pane — the dtach -a process
 * appears asynchronously (herdr has to inject the keystrokes, the shell has
 * to execute the command, the dtach binary has to start), so a single
 * immediate sync would miss it.
 */
export async function pollAndSyncMirrorWinsize(
  terminalId: string,
  cols: number,
  rows: number,
  opts: { attempts?: number; intervalMs?: number } = {}
): Promise<void> {
  const attempts = opts.attempts ?? 20
  const intervalMs = opts.intervalMs ?? 150
  if (!existsSync('/proc')) return
  const socketPath = getDtachService().getSocketPath(terminalId)
  for (let i = 0; i < attempts; i++) {
    if (findMirrorDtachPid(socketPath) !== null) {
      syncMirrorWinsize(terminalId, cols, rows)
      return
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  log.terminal.debug('mirror winsize: dtach client never appeared', {
    terminalId,
    cols,
    rows,
    attempts,
  })
}
