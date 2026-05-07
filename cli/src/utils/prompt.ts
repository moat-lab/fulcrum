import * as readline from 'node:readline'

/**
 * Prompts the user for confirmation with a yes/no question.
 * Uses stderr for output to keep stdout clean for JSON.
 * Default is "no" - user must explicitly type "y" or "yes".
 */
function createPrompt() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  })
}

export async function prompt(message: string, defaultValue?: string): Promise<string> {
  const rl = createPrompt()
  const suffix = defaultValue ? ` [${defaultValue}]` : ''

  return new Promise((resolve) => {
    rl.question(`${message}${suffix}: `, (answer) => {
      rl.close()
      resolve(answer.trim() || defaultValue || '')
    })
  })
}

export async function confirm(message: string): Promise<boolean> {
  const rl = createPrompt()

  return new Promise((resolve) => {
    rl.question(`${message} [y/N] `, (answer) => {
      rl.close()
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes')
    })
  })
}
