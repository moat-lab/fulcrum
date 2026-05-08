import { afterEach, describe, expect, test } from 'bun:test'
import { PTYManager } from './pty-manager'

describe('PTYManager remote-only enforcement', () => {
  afterEach(() => {
    delete process.env.FULCRUM_REMOTE_ONLY
  })

  test('rejects local terminal creation when remote-only mode is enabled', async () => {
    process.env.FULCRUM_REMOTE_ONLY = 'true'
    const manager = new PTYManager({
      onData: () => {},
      onExit: () => {},
    })

    await expect(manager.create({ name: 'Local', cols: 80, rows: 24 })).rejects.toThrow('remote-only mode requires hostId')
  })
})
