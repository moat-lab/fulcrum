import type { AnyTerminal } from './terminal-types'

const PROMPT_SUFFIX_PATTERN = /(?:[❯❮➜›»]|[$%#>])\s*$/

export function getLastNonEmptyTerminalLine(term: AnyTerminal): string | null {
  const buffer = term.buffer.active
  for (let index = buffer.baseY + buffer.cursorY; index >= 0; index--) {
    const text = buffer.getLine(index)?.translateToString(true).trimEnd()
    if (text) return text
  }
  return null
}

export function isShellPromptLine(line: string): boolean {
  return PROMPT_SUFFIX_PATTERN.test(line)
}

export function waitForShellPrompt(term: AnyTerminal, timeoutMs = 30_000): Promise<void> {
  if (isShellPromptLine(getLastNonEmptyTerminalLine(term) ?? '')) {
    return Promise.resolve()
  }

  return new Promise((resolve) => {
    let settled = false
    const timeout = window.setTimeout(finish, timeoutMs)
    const interval = window.setInterval(() => {
      if (isShellPromptLine(getLastNonEmptyTerminalLine(term) ?? '')) finish()
    }, 100)

    function finish() {
      if (settled) return
      settled = true
      window.clearTimeout(timeout)
      window.clearInterval(interval)
      resolve()
    }
  })
}
