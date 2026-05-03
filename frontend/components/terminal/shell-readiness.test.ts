import { describe, expect, test } from 'bun:test'
import { isShellPromptLine } from './shell-readiness'

describe('isShellPromptLine', () => {
  test('detects common shell prompt suffixes', () => {
    expect(isShellPromptLine('/repo/project ❯')).toBe(true)
    expect(isShellPromptLine('~/code/fulcrum $')).toBe(true)
    expect(isShellPromptLine('root@host:/app#')).toBe(true)
    expect(isShellPromptLine('scratch-dir >')).toBe(true)
  })

  test('does not treat banner or command output as prompt readiness', () => {
    expect(isShellPromptLine('OS: CachyOS x86_64')).toBe(false)
    expect(isShellPromptLine('zsh startup complete')).toBe(false)
    expect(isShellPromptLine('claude --append-system-prompt')).toBe(false)
  })
})
