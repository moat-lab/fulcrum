import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineCommand } from 'citty'
import { output, isJsonOutput } from '../utils/output'
import { CliError, ExitCodes } from '../utils/errors'
import { writePid, readPid, removePid, isProcessRunning, getPort } from '../utils/process'
import { confirm } from '../utils/prompt'
import { getFulcrumDir, updateSettingsPort, needsViboraMigration, getLegacyViboraDir } from '../utils/server'
import {
  isDtachInstalled,
  isBunInstalled,
  installDtach,
  installBun,
  isClaudeInstalled,
  isOpencodeInstalled,
  isCodexInstalled,
  isUvInstalled,
  installUv,
  isFnoxInstalled,
  installFnox,
  isAgeInstalled,
  installAge,
} from '../utils/install'
import { getDependency, getInstallMethod, getInstallCommand } from '../utils/dependencies'
import { ensureFnoxSetup } from '../utils/fnox-setup'
import { installClaudePlugin, needsPluginUpdate } from './claude'
import { checkForUpdates, installLatestVersion } from './update'
import pkg from '../../../package.json'
import { globalArgs, toFlags, setupJsonOutput } from './shared'

/**
 * Gets the package root directory (where the CLI is installed).
 * In bundled mode, this contains server/, dist/, and drizzle/.
 *
 * Handles two cases:
 * - Development: file is at cli/src/commands/up.ts (3 levels up to cli/)
 * - Bundled: file is at bin/fulcrum.js (1 level up to package root)
 */
function getPackageRoot(): string {
  const currentFile = fileURLToPath(import.meta.url)
  let dir = dirname(currentFile)

  // Walk up directories until we find one with server/index.js
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, 'server', 'index.js'))) {
      return dir
    }
    dir = dirname(dir)
  }

  // Fallback to old behavior (3 levels up)
  return dirname(dirname(dirname(currentFile)))
}

interface DependencySpec {
  name: string
  isInstalled: () => boolean
  install: () => boolean
  reason: string
  description: string
}

async function ensureDependency(spec: DependencySpec, autoYes: boolean): Promise<void> {
  if (spec.isInstalled()) return

  const dep = getDependency(spec.name)!
  const method = getInstallMethod(dep)
  console.error(spec.reason)
  console.error(`  ${spec.description}`)

  const shouldInstall = autoYes || (await confirm(`Would you like to install ${spec.name} via ${method}?`))
  if (shouldInstall) {
    const success = spec.install()
    if (!success) {
      throw new CliError('INSTALL_FAILED', `Failed to install ${spec.name}`, ExitCodes.ERROR)
    }
    console.error(`${spec.name} installed successfully!`)
  } else {
    throw new CliError(
      'MISSING_DEPENDENCY',
      `${spec.name} is required. Install manually: ${getInstallCommand(dep)}`,
      ExitCodes.ERROR
    )
  }
}

async function handleUpCommand(flags: Record<string, string>) {
  const autoYes = flags.yes === 'true' || flags.y === 'true'
  const shouldUpdate = flags.update === 'true'

  // Handle --update flag: check for updates and install if available
  if (shouldUpdate) {
    console.error('Checking for updates...')
    const { currentVersion, latestVersion, updateAvailable } = await checkForUpdates()

    if (latestVersion && updateAvailable) {
      console.error(`Update available: ${currentVersion} → ${latestVersion}`)
      console.error('Installing update...')
      const installed = installLatestVersion()
      if (!installed) {
        throw new CliError('UPDATE_FAILED', 'Failed to install update', ExitCodes.ERROR)
      }
      console.error('Update installed successfully.')
    } else if (latestVersion) {
      console.error(`Already on latest version: ${currentVersion}`)
    } else {
      console.error('Could not check for updates, continuing with current version.')
    }
  }

  // Check for migration from ~/.vibora (legacy Vibora installation)
  if (needsViboraMigration()) {
    const viboraDir = getLegacyViboraDir()
    console.error(`\nFound existing Vibora data at ${viboraDir}`)
    console.error('Run "fulcrum migrate-from-vibora" to copy your data to ~/.fulcrum')
    console.error('')
  }

  // Ensure all required dependencies are installed
  const requiredDeps: DependencySpec[] = [
    { name: 'bun', isInstalled: isBunInstalled, install: installBun,
      reason: 'Bun is required to run Fulcrum but is not installed.',
      description: 'Bun is the JavaScript runtime that powers Fulcrum.' },
    { name: 'dtach', isInstalled: isDtachInstalled, install: installDtach,
      reason: 'dtach is required for terminal persistence but is not installed.',
      description: 'dtach enables persistent terminal sessions that survive disconnects.' },
    { name: 'uv', isInstalled: isUvInstalled, install: installUv,
      reason: 'uv is required but is not installed.',
      description: 'uv is a fast Python package manager used by Claude Code.' },
    { name: 'fnox', isInstalled: isFnoxInstalled, install: installFnox,
      reason: 'fnox is required for encrypted secrets management but is not installed.',
      description: 'fnox encrypts sensitive settings like API keys and tokens.' },
    { name: 'age', isInstalled: isAgeInstalled, install: installAge,
      reason: 'age is required for encryption but is not installed.',
      description: 'age generates encryption keys used by fnox to encrypt secrets.' },
  ]
  for (const dep of requiredDeps) {
    await ensureDependency(dep, autoYes)
  }

  // Auto-install/update Claude Code plugin if Claude is installed
  if (isClaudeInstalled() && needsPluginUpdate()) {
    console.error('Updating Fulcrum plugin for Claude Code...')
    await installClaudePlugin({ silent: true })
    console.error('✓ Fulcrum plugin updated')
  }

  // Check if already running
  const existingPid = readPid()
  if (existingPid && isProcessRunning(existingPid)) {
    console.error(`Fulcrum server is already running (PID: ${existingPid})`)

    const shouldReplace = autoYes || (await confirm('Would you like to stop it and start a new instance?'))
    if (shouldReplace) {
      console.error('Stopping existing instance...')
      process.kill(existingPid, 'SIGTERM')

      // Wait for process to exit (up to 5 seconds)
      let attempts = 0
      while (attempts < 50 && isProcessRunning(existingPid)) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        attempts++
      }

      // Force kill if still running
      if (isProcessRunning(existingPid)) {
        process.kill(existingPid, 'SIGKILL')
      }

      removePid()
      console.error('Existing instance stopped.')
    } else {
      throw new CliError(
        'ALREADY_RUNNING',
        `Server already running at http://localhost:${getPort(flags.port)}`,
        ExitCodes.ERROR
      )
    }
  }

  const port = getPort(flags.port)

  // Persist port to settings.json when explicitly passed
  if (flags.port) {
    updateSettingsPort(port)
  }

  const host = flags.host ? '0.0.0.0' : 'localhost'
  const packageRoot = getPackageRoot()
  const serverPath = join(packageRoot, 'server', 'index.js')

  // Select correct PTY library based on platform
  const platform = process.platform
  const arch = process.arch
  let ptyLibName: string
  if (platform === 'darwin') {
    ptyLibName = arch === 'arm64' ? 'librust_pty_arm64.dylib' : 'librust_pty.dylib'
  } else if (platform === 'win32') {
    ptyLibName = 'rust_pty.dll'
  } else {
    ptyLibName = arch === 'arm64' ? 'librust_pty_arm64.so' : 'librust_pty.so'
  }
  const ptyLibPath = join(packageRoot, 'lib', ptyLibName)

  // Ensure fnox is initialized (age key + config/fnox.toml)
  const fulcrumDir = getFulcrumDir()
  ensureFnoxSetup(fulcrumDir)

  // Start the bundled server
  // Explicitly set FULCRUM_DIR to ensure consistent path resolution
  // regardless of where the CLI was invoked from
  const debug = flags.debug === 'true'
  console.error(`Starting Fulcrum server${debug ? ' (debug mode)' : ''}...`)
  const serverProc = spawn('bun', [serverPath], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: port.toString(),
      HOST: host,
      FULCRUM_DIR: fulcrumDir,
      FULCRUM_PACKAGE_ROOT: packageRoot,
      FULCRUM_VERSION: pkg.version,
      BUN_PTY_LIB: ptyLibPath,
      FULCRUM_FNOX_INSTALLED: '1',
      // Pass CLI's alias-aware detection to the server (which can't detect aliases)
      ...(isClaudeInstalled() && { FULCRUM_CLAUDE_INSTALLED: '1' }),
      ...(isOpencodeInstalled() && { FULCRUM_OPENCODE_INSTALLED: '1' }),
      ...(isCodexInstalled() && { FULCRUM_CODEX_INSTALLED: '1' }),
      ...(debug && { LOG_LEVEL: 'debug', DEBUG: '1' }),
    },
  })

  // Unref so parent can exit
  serverProc.unref()

  const pid = serverProc.pid
  if (!pid) {
    throw new CliError('START_FAILED', 'Failed to start server process', ExitCodes.ERROR)
  }

  // Write PID file
  writePid(pid)

  // Wait a moment for server to start, then verify
  await new Promise((resolve) => setTimeout(resolve, 1000))

  if (!isProcessRunning(pid)) {
    throw new CliError('START_FAILED', 'Server process died immediately after starting', ExitCodes.ERROR)
  }

  if (isJsonOutput()) {
    output({
      pid,
      port,
      url: `http://localhost:${port}`,
    })
  } else {
    // Show getting started tips for human-readable output
    const hasAgent = isClaudeInstalled() || isOpencodeInstalled() || isCodexInstalled()
    showGettingStartedTips(port, hasAgent)
  }
}

/**
 * Display getting started tips after successful server start.
 */
function showGettingStartedTips(port: number, hasAgent: boolean): void {
  console.error(`
Fulcrum is running at http://localhost:${port}

Getting Started:
  1. Open http://localhost:${port} in your browser
  2. Add a repository to get started
  3. Create a task to spin up an isolated worktree
  4. Run your AI agent in the task terminal

Commands:
  fulcrum status    Check server status
  fulcrum doctor    Check all dependencies
  fulcrum down      Stop the server
`)

  if (!hasAgent) {
    console.error(`Note: No AI agents detected. Install one to get started:
  Claude Code: curl -fsSL https://claude.ai/install.sh | bash
  OpenCode:    curl -fsSL https://opencode.ai/install | bash
`)
  }
}

// ============================================================================
// Command Definition
// ============================================================================

export const upCommand = defineCommand({
  meta: { name: 'up', description: 'Start the Fulcrum server' },
  args: {
    ...globalArgs,
    yes: { type: 'boolean' as const, alias: 'y', description: 'Auto-answer yes to prompts' },
    host: { type: 'boolean' as const, description: 'Bind to 0.0.0.0 (expose to network)' },
    update: { type: 'boolean' as const, description: 'Check for and install updates before starting' },
  },
  async run({ args }) {
    setupJsonOutput(args)
    await handleUpCommand(toFlags(args))
  },
})
