import { execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync, renameSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { CliError, ExitCodes } from './errors'

// Tmp+rename so a crash mid-write can't leave a half-written fnox.toml that fnox would refuse to decode.
function writeFileAtomicSync(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp`
  writeFileSync(tmpPath, content, 'utf-8')
  renameSync(tmpPath, filePath)
}

function backupLegacyFnoxConfig(legacyPath: string, configDir: string): void {
  const backupPath = join(configDir, `legacy-${basename(legacyPath)}.bak`)
  renameSync(legacyPath, backupPath)
  console.error(`Backed up ${basename(legacyPath)} → config/${basename(backupPath)}`)
}

function migrateLegacyFnoxConfig(fulcrumDir: string, fnoxConfigPath: string): void {
  if (existsSync(fnoxConfigPath)) return

  const configDir = dirname(fnoxConfigPath)
  const legacyPaths = [join(fulcrumDir, '.fnox.toml'), join(fulcrumDir, 'fnox.toml')]
  const sourcePath = legacyPaths.find(legacy => existsSync(legacy))
  if (!sourcePath) return

  mkdirSync(configDir, { recursive: true })
  renameSync(sourcePath, fnoxConfigPath)
  console.error(`Migrated ${basename(sourcePath)} → config/fnox.toml`)

  for (const legacy of legacyPaths) {
    if (legacy !== sourcePath && existsSync(legacy)) backupLegacyFnoxConfig(legacy, configDir)
  }
}

/**
 * Ensure fnox is set up in the given Fulcrum directory.
 *
 * 1. Generate age key if it doesn't exist
 * 2. Create config/fnox.toml with age provider if it doesn't exist
 * 3. Verify the setup works with a round-trip test
 *
 * The config lives under `config/` so fnox's upward directory walk from task
 * worktrees at `~/.fulcrum/worktrees/<slug>/` does not discover it.
 */
export function ensureFnoxSetup(fulcrumDir: string): void {
  const ageKeyPath = join(fulcrumDir, 'age.txt')
  const fnoxConfigPath = join(fulcrumDir, 'config', 'fnox.toml')

  // Migrate any legacy config at `<fulcrumDir>/fnox.toml` or
  // `<fulcrumDir>/.fnox.toml` into the walk-safe nested location.
  migrateLegacyFnoxConfig(fulcrumDir, fnoxConfigPath)

  // Step 1: Generate age key if needed
  let publicKey: string
  if (!existsSync(ageKeyPath)) {
    console.error('Generating age encryption key...')
    try {
      const output = execSync(`age-keygen -o "${ageKeyPath}" 2>&1`, { encoding: 'utf-8' })
      // age-keygen outputs "Public key: age1..." to stderr (captured via 2>&1)
      const match = output.match(/Public key: (age1\S+)/)
      if (!match) {
        throw new Error(`Could not parse public key from age-keygen output: ${output}`)
      }
      publicKey = match[1]
    } catch (err) {
      throw new CliError(
        'FNOX_SETUP_FAILED',
        `Failed to generate age key: ${err instanceof Error ? err.message : String(err)}`,
        ExitCodes.ERROR
      )
    }
    // Ensure restrictive permissions
    chmodSync(ageKeyPath, 0o600)
    console.error('Age encryption key generated.')
  } else {
    // Read existing public key from age.txt
    const content = readFileSync(ageKeyPath, 'utf-8')
    const match = content.match(/# public key: (age1\S+)/)
    if (!match) {
      throw new CliError(
        'FNOX_SETUP_FAILED',
        `Could not parse public key from existing ${ageKeyPath}`,
        ExitCodes.ERROR
      )
    }
    publicKey = match[1]
  }

  // Step 2: Create config/fnox.toml if needed, or ensure plain provider exists
  if (!existsSync(fnoxConfigPath)) {
    console.error('Creating fnox configuration...')
    mkdirSync(dirname(fnoxConfigPath), { recursive: true })
    const config = `[providers.plain]\ntype = "plain"\n\n[providers.age]\ntype = "age"\nrecipients = ["${publicKey}"]\n`
    writeFileAtomicSync(fnoxConfigPath, config)
    console.error('fnox configuration created.')
  } else {
    // Ensure plain provider exists in existing config (upgrade from age-only)
    const existingConfig = readFileSync(fnoxConfigPath, 'utf-8')
    if (!existingConfig.includes('[providers.plain]')) {
      const updatedConfig = `[providers.plain]\ntype = "plain"\n\n${existingConfig}`
      writeFileAtomicSync(fnoxConfigPath, updatedConfig)
      console.error('Added plain provider to fnox configuration.')
    }
  }

  // Step 3: Verify with a round-trip test
  const env = { ...process.env, FNOX_AGE_KEY_FILE: ageKeyPath }
  const fnoxArgs = `-c "${fnoxConfigPath}"`
  try {
    execSync(`fnox set FULCRUM_SETUP_TEST test_value ${fnoxArgs}`, { env, stdio: 'ignore' })
    const value = execSync(`fnox get FULCRUM_SETUP_TEST ${fnoxArgs}`, { env, encoding: 'utf-8' }).trim()
    execSync(`fnox remove FULCRUM_SETUP_TEST ${fnoxArgs}`, { env, stdio: 'ignore' })
    if (value !== 'test_value') {
      throw new Error(`Round-trip test failed: expected "test_value", got "${value}"`)
    }
  } catch (err) {
    throw new CliError(
      'FNOX_SETUP_FAILED',
      `fnox verification failed: ${err instanceof Error ? err.message : String(err)}\n` +
        `  Age key: ${ageKeyPath}\n` +
        `  Config: ${fnoxConfigPath}\n` +
        `  Ensure fnox and age are properly installed.`,
      ExitCodes.ERROR
    )
  }
}
