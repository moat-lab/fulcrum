// Buffer manager for terminal scrollback.
//
// Backed by an @xterm/headless instance that maintains canonical screen state.
// All escape-sequence handling (alternate screen, mouse modes, OSC, DCS,
// cursor positioning, etc.) goes through the emulator's parser instead of
// after-the-fact regex filtering. The serialize addon turns the live screen
// into ANSI for client replay.
//
// Disk persistence keeps the v3 raw-bytes format so history survives daemon
// restarts; on load we replay the bytes through a fresh emulator to rebuild
// canonical state.

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import * as path from 'path'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Terminal } from '@xterm/headless'
import { getFulcrumDir } from '../lib/settings'
import { log } from '../lib/logger'

// 1MB raw-bytes cap (disk-persistence ring buffer).
const MAX_BUFFER_BYTES = 1_000_000

// Emulator scrollback in lines. ~5k lines comfortably fits any normal session
// while bounding emulator memory growth (xterm.js trims past this).
const SCROLLBACK_LINES = 5000

function getBuffersDir(): string {
  const dir = path.join(getFulcrumDir(), 'buffers')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

interface BufferChunk {
  data: string
  timestamp: number
}

interface BufferFileV3 {
  version: 3
  content: string // base64 encoded
  mouseMode: {
    x10: boolean
    buttonEvent: boolean
    anyEvent: boolean
    sgr: boolean
  }
  cursorVisible?: boolean
}

export class BufferManager {
  private terminal: Terminal
  private serializer: SerializeAddon
  private terminalId: string | null = null
  private pendingWrites: Promise<void>[] = []

  // Raw chunks kept for disk persistence so history survives daemon restart.
  // The emulator is the source of truth for current screen state; this ring
  // buffer just lets us re-hydrate a fresh emulator on next process start.
  private chunks: BufferChunk[] = []
  private totalBytes: number = 0

  // Cursor visibility (DECTCEM). The serialize addon emits screen content but
  // does not restore mode state — TUIs that hide the cursor (Claude Code etc.)
  // need this rehydrated explicitly or the cursor reappears in the wrong place
  // after replay.
  private cursorVisible = true

  constructor(cols: number = 80, rows: number = 24) {
    this.terminal = new Terminal({
      cols,
      rows,
      scrollback: SCROLLBACK_LINES,
      allowProposedApi: true,
    })
    this.serializer = new SerializeAddon()
    this.terminal.loadAddon(this.serializer)
  }

  setTerminalId(id: string): void {
    this.terminalId = id
  }

  append(data: string): void {
    // Track DECTCEM for replay rehydration. We only watch one mode here;
    // everything else (mouse, alt-screen, OSC, DCS, etc.) is canonicalized
    // by the emulator itself.
    const ESC = ''
    if (data.includes(`${ESC}[?25h`)) this.cursorVisible = true
    if (data.includes(`${ESC}[?25l`)) this.cursorVisible = false

    // Persist raw bytes for cross-restart history.
    this.chunks.push({ data, timestamp: Date.now() })
    this.totalBytes += data.length
    while (this.totalBytes > MAX_BUFFER_BYTES && this.chunks.length > 1) {
      const removed = this.chunks.shift()!
      this.totalBytes -= removed.data.length
    }

    // Feed the canonical emulator. Its parser consumes any escape sequences
    // (including DECRQSS responses, OSC color queries, DA reports, etc.) so
    // they never appear in serialized output.
    this.writeToTerminal(data)
  }

  /**
   * Build a snapshot for client replay. Output is ANSI bytes that, when
   * written into a fresh xterm at matching cols/rows, reproduce the current
   * screen.
   */
  getContents(): string {
    let output = this.serializer.serialize({ scrollback: SCROLLBACK_LINES })
    if (!this.cursorVisible) {
      const ESC = ''
      output = `${ESC}[?25l` + output
    }
    return output
  }

  resize(cols: number, rows: number): void {
    this.terminal.resize(cols, rows)
  }

  /**
   * Resolve once the emulator finishes parsing all in-flight writes. Used by
   * `terminal:attach` to capture a deterministic snapshot after SIGWINCH —
   * replaces the previous fixed 60 ms setTimeout guess.
   */
  async flushPending(): Promise<void> {
    while (this.pendingWrites.length > 0) {
      const pending = this.pendingWrites
      this.pendingWrites = []
      await Promise.all(pending)
    }
  }

  clear(): void {
    this.terminal.reset()
    this.chunks = []
    this.totalBytes = 0
    this.cursorVisible = true
  }

  getLineCount(): number {
    return this.terminal.buffer.active.length
  }

  // Save raw chunks to disk in v3 format. We persist raw bytes (rather than a
  // serialized snapshot) so the disk format is independent of the specific
  // emulator we use — load-time replay rebuilds canonical state.
  saveToDisk(): void {
    if (!this.terminalId) return
    const filePath = path.join(getBuffersDir(), `${this.terminalId}.buf`)
    try {
      const content = this.chunks.map((c) => c.data).join('')
      const fileData: BufferFileV3 = {
        version: 3,
        content: Buffer.from(content).toString('base64'),
        // Mouse mode no longer tracked here. TUIs re-enable it on next redraw,
        // and prior versions also chose not to restore it (would cause click
        // garbage when no consumer is running). Field kept zero-valued for
        // backward compatibility with v3 readers.
        mouseMode: { x10: false, buttonEvent: false, anyEvent: false, sgr: false },
        cursorVisible: this.cursorVisible,
      }
      writeFileSync(filePath, JSON.stringify(fileData), 'utf-8')
    } catch (err) {
      log.buffer.error('Failed to save buffer', { terminalId: this.terminalId, error: String(err) })
    }
  }

  loadFromDisk(): void {
    if (!this.terminalId) return
    const filePath = path.join(getBuffersDir(), `${this.terminalId}.buf`)
    try {
      if (!existsSync(filePath)) {
        log.buffer.debug('No buffer file', { terminalId: this.terminalId })
        return
      }

      const raw = readFileSync(filePath, 'utf-8')
      let content: string

      try {
        const parsed = JSON.parse(raw)
        if (parsed.version === 3 && typeof parsed.content === 'string') {
          content = Buffer.from(parsed.content, 'base64').toString()
          this.cursorVisible = parsed.cursorVisible !== false
        } else if (parsed.version === 2 && typeof parsed.content === 'string') {
          content = Buffer.from(parsed.content, 'base64').toString()
        } else {
          content = raw
        }
      } catch {
        // Legacy plain-text format
        content = raw
      }

      // Seed the chunk ring buffer so the next save preserves loaded history.
      this.chunks = [{ data: content, timestamp: Date.now() }]
      this.totalBytes = content.length

      // Hydrate the emulator. The parser consumes escape sequences and rebuilds
      // canonical screen state.
      this.writeToTerminal(content)

      log.buffer.debug('Loaded buffer', { terminalId: this.terminalId, bytes: this.totalBytes })
    } catch (err) {
      log.buffer.error('Failed to load buffer', { terminalId: this.terminalId, error: String(err) })
    }
  }

  deleteFromDisk(): void {
    if (!this.terminalId) return
    const filePath = path.join(getBuffersDir(), `${this.terminalId}.buf`)
    try {
      if (existsSync(filePath)) {
        unlinkSync(filePath)
      }
    } catch {
      // Ignore errors
    }
  }

  /** Test-only: visible text in the emulator's active buffer. */
  _visibleText(): string {
    const lines: string[] = []
    const buffer = this.terminal.buffer.active
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i)
      if (line) lines.push(line.translateToString(true))
    }
    return lines.join('\n').replace(/\s+$/g, '')
  }

  /** Test-only: dispose the underlying emulator. */
  _dispose(): void {
    this.terminal.dispose()
  }

  private writeToTerminal(data: string): void {
    this.pendingWrites.push(
      new Promise((resolve) => {
        this.terminal.write(data, resolve)
      })
    )
  }
}
