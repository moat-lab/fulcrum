import { afterEach, describe, expect, test } from 'bun:test'
import { BufferManager } from './buffer-manager'

describe('BufferManager', () => {
  let bm: BufferManager | null = null

  afterEach(() => {
    bm?._dispose()
    bm = null
  })

  test('DECRQSS responses are consumed by the emulator parser', async () => {
    bm = new BufferManager(80, 24)
    bm.append('before ')
    bm.append('\x1b[?2026;2$y') // real DECRPM response with ESC prefix
    bm.append(' middle after')
    await bm.flushPending()

    const visible = bm._visibleText()
    expect(visible).toContain('before  middle after')
    expect(visible).not.toContain('?2026')
    expect(visible).not.toContain('$y')
  })

  test('alternate-screen sequences are handled by the emulator', async () => {
    bm = new BufferManager(80, 24)
    bm.append('main screen line 1\r\n')
    bm.append('\x1b[?1049h') // enter alt screen
    bm.append('alt screen content')
    await bm.flushPending()

    const altVisible = bm._visibleText()
    expect(altVisible).toContain('alt screen content')
  })

  test('cursor visibility is preserved through replay rehydration', async () => {
    bm = new BufferManager(80, 24)
    bm.append('hello')
    bm.append('\x1b[?25l') // hide cursor
    await bm.flushPending()

    const snapshot = bm.getContents()
    expect(snapshot.startsWith('\x1b[?25l')).toBe(true)
  })

  test('flushPending resolves after pending writes drain', async () => {
    bm = new BufferManager(80, 24)
    bm.append('queued '.repeat(100))
    await bm.flushPending()

    const visible = bm._visibleText()
    expect(visible).toContain('queued queued')
  })

  test('resize updates the emulator dimensions', async () => {
    bm = new BufferManager(80, 24)
    bm.resize(120, 40)
    bm.append('a'.repeat(100))
    await bm.flushPending()

    // 100 a's fit on one row at width 120 — verify by checking no wrap.
    const visible = bm._visibleText()
    const firstLine = visible.split('\n')[0]
    expect(firstLine.length).toBeGreaterThanOrEqual(100)
  })

  test('clear resets emulator and chunk ring', async () => {
    bm = new BufferManager(80, 24)
    bm.append('some content')
    await bm.flushPending()
    bm.clear()
    await bm.flushPending()

    expect(bm._visibleText().trim()).toBe('')
  })

  test('snapshot replays into a fresh emulator with matching visible text', async () => {
    // Round-trip: write content, snapshot, write snapshot to a fresh
    // BufferManager, verify visible text matches.
    const a = new BufferManager(80, 24)
    a.append('line one\r\n')
    a.append('line two\r\n')
    a.append('line three')
    await a.flushPending()
    const snapshot = a.getContents()
    const aText = a._visibleText()
    a._dispose()

    const b = new BufferManager(80, 24)
    b.append(snapshot)
    await b.flushPending()
    const bText = b._visibleText()
    b._dispose()

    expect(bText).toBe(aText)
  })
})
