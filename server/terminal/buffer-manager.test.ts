import { describe, expect, test } from 'bun:test'
import { BufferManager } from './buffer-manager'

describe('BufferManager', () => {
  test('filters DECRQSS/DECRPM response fragments from replay buffers', () => {
    const buffer = new BufferManager()

    buffer.append('before ')
    buffer.append('\x1b[?2026;2$y')
    buffer.append(' middle 1016;2$y2027;0$y after')

    expect(buffer.getContents()).toBe('before  middle  after')
  })
})
