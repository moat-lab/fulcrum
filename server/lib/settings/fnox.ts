import { execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, chmodSync, renameSync, mkdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { log } from '../logger'
import { getFulcrumDir, isTestMode } from './paths'

// --- Config Entry Types ---

export interface ConfigEntry {
  fnoxKey: string
  provider: 'age' | 'plain'
  type: 'string' | 'number' | 'boolean' | 'json'
}

// --- Complete Config Map: settings path → fnox config entry ---

export const FNOX_CONFIG_MAP: Record<string, ConfigEntry> = {
  // Server
  'server.port': { fnoxKey: 'FULCRUM_SERVER_PORT', provider: 'plain', type: 'number' },
  'server.publicDomain': { fnoxKey: 'FULCRUM_SERVER_PUBLIC_DOMAIN', provider: 'plain', type: 'string' },
  'server.tailscaleHostname': { fnoxKey: 'FULCRUM_SERVER_TAILSCALE_HOSTNAME', provider: 'plain', type: 'string' },

  // Paths
  'paths.defaultGitReposDir': { fnoxKey: 'FULCRUM_PATHS_GIT_REPOS_DIR', provider: 'plain', type: 'string' },

  // Editor
  'editor.app': { fnoxKey: 'FULCRUM_EDITOR_APP', provider: 'plain', type: 'string' },
  'editor.host': { fnoxKey: 'FULCRUM_EDITOR_HOST', provider: 'plain', type: 'string' },
  'editor.sshPort': { fnoxKey: 'FULCRUM_EDITOR_SSH_PORT', provider: 'plain', type: 'number' },

  // Integrations (secrets)
  'integrations.githubPat': { fnoxKey: 'FULCRUM_GITHUB_PAT', provider: 'age', type: 'string' },
  'integrations.cloudflareApiToken': { fnoxKey: 'FULCRUM_CLOUDFLARE_API_TOKEN', provider: 'age', type: 'string' },
  'integrations.cloudflareAccountId': { fnoxKey: 'FULCRUM_CLOUDFLARE_ACCOUNT_ID', provider: 'age', type: 'string' },
  'integrations.googleClientId': { fnoxKey: 'FULCRUM_GOOGLE_CLIENT_ID', provider: 'age', type: 'string' },
  'integrations.googleClientSecret': { fnoxKey: 'FULCRUM_GOOGLE_CLIENT_SECRET', provider: 'age', type: 'string' },

  // Agent
  'agent.defaultAgent': { fnoxKey: 'FULCRUM_AGENT_DEFAULT', provider: 'plain', type: 'string' },
  'agent.opencodeModel': { fnoxKey: 'FULCRUM_AGENT_OPENCODE_MODEL', provider: 'plain', type: 'string' },
  'agent.opencodeDefaultAgent': { fnoxKey: 'FULCRUM_AGENT_OPENCODE_DEFAULT', provider: 'plain', type: 'string' },
  'agent.opencodePlanAgent': { fnoxKey: 'FULCRUM_AGENT_OPENCODE_PLAN', provider: 'plain', type: 'string' },
  'agent.autoScrollToBottom': { fnoxKey: 'FULCRUM_AGENT_AUTO_SCROLL', provider: 'plain', type: 'boolean' },
  'agent.claudeCodePath': { fnoxKey: 'FULCRUM_AGENT_CLAUDE_CODE_PATH', provider: 'plain', type: 'string' },

  // Tasks
  'tasks.defaultTaskType': { fnoxKey: 'FULCRUM_TASKS_DEFAULT_TYPE', provider: 'plain', type: 'string' },
  'tasks.startWorktreeTasksImmediately': { fnoxKey: 'FULCRUM_TASKS_START_IMMEDIATELY', provider: 'plain', type: 'boolean' },
  'tasks.scratchStartupScript': { fnoxKey: 'FULCRUM_TASKS_SCRATCH_STARTUP_SCRIPT', provider: 'plain', type: 'string' },

  // Appearance
  'appearance.language': { fnoxKey: 'FULCRUM_APPEARANCE_LANGUAGE', provider: 'plain', type: 'string' },
  'appearance.theme': { fnoxKey: 'FULCRUM_APPEARANCE_THEME', provider: 'plain', type: 'string' },
  'appearance.timezone': { fnoxKey: 'FULCRUM_APPEARANCE_TIMEZONE', provider: 'plain', type: 'string' },

  // Assistant
  'assistant.provider': { fnoxKey: 'FULCRUM_ASSISTANT_PROVIDER', provider: 'plain', type: 'string' },
  'assistant.model': { fnoxKey: 'FULCRUM_ASSISTANT_MODEL', provider: 'plain', type: 'string' },
  'assistant.observerModel': { fnoxKey: 'FULCRUM_ASSISTANT_OBSERVER_MODEL', provider: 'plain', type: 'string' },
  'assistant.observerProvider': { fnoxKey: 'FULCRUM_ASSISTANT_OBSERVER_PROVIDER', provider: 'plain', type: 'string' },
  'assistant.observerOpencodeModel': { fnoxKey: 'FULCRUM_ASSISTANT_OBSERVER_OPENCODE_MODEL', provider: 'plain', type: 'string' },
  'assistant.customInstructions': { fnoxKey: 'FULCRUM_ASSISTANT_CUSTOM_INSTRUCTIONS', provider: 'plain', type: 'string' },
  'assistant.documentsDir': { fnoxKey: 'FULCRUM_ASSISTANT_DOCUMENTS_DIR', provider: 'plain', type: 'string' },
  'assistant.ritualsEnabled': { fnoxKey: 'FULCRUM_ASSISTANT_RITUALS_ENABLED', provider: 'plain', type: 'boolean' },
  'assistant.morningRitual.time': { fnoxKey: 'FULCRUM_ASSISTANT_MORNING_TIME', provider: 'plain', type: 'string' },
  'assistant.morningRitual.prompt': { fnoxKey: 'FULCRUM_ASSISTANT_MORNING_PROMPT', provider: 'plain', type: 'string' },
  'assistant.eveningRitual.time': { fnoxKey: 'FULCRUM_ASSISTANT_EVENING_TIME', provider: 'plain', type: 'string' },
  'assistant.eveningRitual.prompt': { fnoxKey: 'FULCRUM_ASSISTANT_EVENING_PROMPT', provider: 'plain', type: 'string' },

  // Channels - Email
  'channels.email.enabled': { fnoxKey: 'FULCRUM_EMAIL_ENABLED', provider: 'plain', type: 'boolean' },
  'channels.email.backend': { fnoxKey: 'FULCRUM_EMAIL_BACKEND', provider: 'plain', type: 'string' },
  'channels.email.googleAccountId': { fnoxKey: 'FULCRUM_EMAIL_GOOGLE_ACCOUNT_ID', provider: 'plain', type: 'string' },
  'channels.email.imap.host': { fnoxKey: 'FULCRUM_EMAIL_IMAP_HOST', provider: 'plain', type: 'string' },
  'channels.email.imap.port': { fnoxKey: 'FULCRUM_EMAIL_IMAP_PORT', provider: 'plain', type: 'number' },
  'channels.email.imap.secure': { fnoxKey: 'FULCRUM_EMAIL_IMAP_SECURE', provider: 'plain', type: 'boolean' },
  'channels.email.imap.user': { fnoxKey: 'FULCRUM_EMAIL_IMAP_USER', provider: 'plain', type: 'string' },
  'channels.email.imap.password': { fnoxKey: 'FULCRUM_EMAIL_IMAP_PASSWORD', provider: 'age', type: 'string' },
  'channels.email.pollIntervalSeconds': { fnoxKey: 'FULCRUM_EMAIL_POLL_INTERVAL', provider: 'plain', type: 'number' },

  // Channels - Slack
  'channels.slack.enabled': { fnoxKey: 'FULCRUM_SLACK_ENABLED', provider: 'plain', type: 'boolean' },
  'channels.slack.botToken': { fnoxKey: 'FULCRUM_SLACK_BOT_TOKEN', provider: 'age', type: 'string' },
  'channels.slack.appToken': { fnoxKey: 'FULCRUM_SLACK_APP_TOKEN', provider: 'age', type: 'string' },

  // Channels - Discord
  'channels.discord.enabled': { fnoxKey: 'FULCRUM_DISCORD_ENABLED', provider: 'plain', type: 'boolean' },
  'channels.discord.botToken': { fnoxKey: 'FULCRUM_DISCORD_BOT_TOKEN', provider: 'age', type: 'string' },

  // Channels - Telegram
  'channels.telegram.enabled': { fnoxKey: 'FULCRUM_TELEGRAM_ENABLED', provider: 'plain', type: 'boolean' },
  'channels.telegram.botToken': { fnoxKey: 'FULCRUM_TELEGRAM_BOT_TOKEN', provider: 'age', type: 'string' },

  // Channels - Agent Channel Exchange (issue #180 / parent #153)
  'channels.exchange.enabled': { fnoxKey: 'FULCRUM_CHANNELS_EXCHANGE_ENABLED', provider: 'plain', type: 'boolean' },
  'channels.exchange.url': { fnoxKey: 'FULCRUM_CHANNELS_EXCHANGE_URL', provider: 'plain', type: 'string' },
  'channels.exchange.token': { fnoxKey: 'FULCRUM_CHANNELS_EXCHANGE_TOKEN', provider: 'age', type: 'string' },
  'channels.exchange.mailbox': { fnoxKey: 'FULCRUM_CHANNELS_EXCHANGE_MAILBOX', provider: 'plain', type: 'string' },
  'channels.exchange.mcpGitRef': { fnoxKey: 'FULCRUM_CHANNELS_EXCHANGE_MCP_GIT_REF', provider: 'plain', type: 'string' },

  // Channels - PM Agent Mode hook (issue #181 / parent #153 §Chat 启动 UX hook)
  'channels.pm.enabled': { fnoxKey: 'FULCRUM_CHANNELS_PM_ENABLED', provider: 'plain', type: 'boolean' },
  'channels.pm.clientForm': { fnoxKey: 'FULCRUM_CHANNELS_PM_CLIENT_FORM', provider: 'plain', type: 'string' },
  'channels.pm.mailbox': { fnoxKey: 'FULCRUM_CHANNELS_PM_MAILBOX', provider: 'plain', type: 'string' },
  'channels.pm.systemPromptRef': { fnoxKey: 'FULCRUM_CHANNELS_PM_SYSTEM_PROMPT_REF', provider: 'plain', type: 'string' },

  // Channels - Mattermost
  'channels.mattermost.enabled': { fnoxKey: 'FULCRUM_MATTERMOST_ENABLED', provider: 'plain', type: 'boolean' },
  'channels.mattermost.serverUrl': { fnoxKey: 'FULCRUM_MATTERMOST_SERVER_URL', provider: 'plain', type: 'string' },
  'channels.mattermost.botToken': { fnoxKey: 'FULCRUM_MATTERMOST_BOT_TOKEN', provider: 'age', type: 'string' },
  'channels.mattermost.teamId': { fnoxKey: 'FULCRUM_MATTERMOST_TEAM_ID', provider: 'plain', type: 'string' },
  'channels.mattermost.channelId': { fnoxKey: 'FULCRUM_MATTERMOST_CHANNEL_ID', provider: 'plain', type: 'string' },
  'channels.mattermost.commandToken': { fnoxKey: 'FULCRUM_MATTERMOST_COMMAND_TOKEN', provider: 'age', type: 'string' },
  'channels.mattermost.allowedUserIds': { fnoxKey: 'FULCRUM_MATTERMOST_ALLOWED_USER_IDS', provider: 'plain', type: 'json' },

  // CalDAV
  'caldav.enabled': { fnoxKey: 'FULCRUM_CALDAV_ENABLED', provider: 'plain', type: 'boolean' },
  'caldav.syncIntervalMinutes': { fnoxKey: 'FULCRUM_CALDAV_SYNC_INTERVAL', provider: 'plain', type: 'number' },

  // Notifications
  'notifications.enabled': { fnoxKey: 'FULCRUM_NOTIF_ENABLED', provider: 'plain', type: 'boolean' },
  'notifications.toast.enabled': { fnoxKey: 'FULCRUM_NOTIF_TOAST_ENABLED', provider: 'plain', type: 'boolean' },
  'notifications.desktop.enabled': { fnoxKey: 'FULCRUM_NOTIF_DESKTOP_ENABLED', provider: 'plain', type: 'boolean' },
  'notifications.sound.enabled': { fnoxKey: 'FULCRUM_NOTIF_SOUND_ENABLED', provider: 'plain', type: 'boolean' },
  'notifications.sound.customSoundFile': { fnoxKey: 'FULCRUM_NOTIF_SOUND_FILE', provider: 'plain', type: 'string' },
  'notifications.slack.enabled': { fnoxKey: 'FULCRUM_NOTIF_SLACK_ENABLED', provider: 'plain', type: 'boolean' },
  'notifications.slack.webhookUrl': { fnoxKey: 'FULCRUM_SLACK_WEBHOOK_URL', provider: 'age', type: 'string' },
  'notifications.slack.useMessagingChannel': { fnoxKey: 'FULCRUM_NOTIF_SLACK_USE_MESSAGING', provider: 'plain', type: 'boolean' },
  'notifications.discord.enabled': { fnoxKey: 'FULCRUM_NOTIF_DISCORD_ENABLED', provider: 'plain', type: 'boolean' },
  'notifications.discord.webhookUrl': { fnoxKey: 'FULCRUM_DISCORD_WEBHOOK_URL', provider: 'age', type: 'string' },
  'notifications.discord.useMessagingChannel': { fnoxKey: 'FULCRUM_NOTIF_DISCORD_USE_MESSAGING', provider: 'plain', type: 'boolean' },
  'notifications.pushover.enabled': { fnoxKey: 'FULCRUM_NOTIF_PUSHOVER_ENABLED', provider: 'plain', type: 'boolean' },
  'notifications.pushover.appToken': { fnoxKey: 'FULCRUM_PUSHOVER_APP_TOKEN', provider: 'age', type: 'string' },
  'notifications.pushover.userKey': { fnoxKey: 'FULCRUM_PUSHOVER_USER_KEY', provider: 'age', type: 'string' },
  'notifications.whatsapp.enabled': { fnoxKey: 'FULCRUM_NOTIF_WHATSAPP_ENABLED', provider: 'plain', type: 'boolean' },
  'notifications.telegram.enabled': { fnoxKey: 'FULCRUM_NOTIF_TELEGRAM_ENABLED', provider: 'plain', type: 'boolean' },
  'notifications.gmail.enabled': { fnoxKey: 'FULCRUM_NOTIF_GMAIL_ENABLED', provider: 'plain', type: 'boolean' },
  'notifications.gmail.googleAccountId': { fnoxKey: 'FULCRUM_NOTIF_GMAIL_ACCOUNT_ID', provider: 'plain', type: 'string' },
  'notifications.mattermost.enabled': { fnoxKey: 'FULCRUM_NOTIF_MATTERMOST_ENABLED', provider: 'plain', type: 'boolean' },
  'notifications._updatedAt': { fnoxKey: 'FULCRUM_NOTIF_UPDATED_AT', provider: 'plain', type: 'number' },

  // z.ai
  'zai.enabled': { fnoxKey: 'FULCRUM_ZAI_ENABLED', provider: 'plain', type: 'boolean' },
  'zai.apiKey': { fnoxKey: 'FULCRUM_ZAI_API_KEY', provider: 'age', type: 'string' },
  'zai.haikuModel': { fnoxKey: 'FULCRUM_ZAI_HAIKU_MODEL', provider: 'plain', type: 'string' },
  'zai.sonnetModel': { fnoxKey: 'FULCRUM_ZAI_SONNET_MODEL', provider: 'plain', type: 'string' },
  'zai.opusModel': { fnoxKey: 'FULCRUM_ZAI_OPUS_MODEL', provider: 'plain', type: 'string' },

  // Internal
  '_schemaVersion': { fnoxKey: 'FULCRUM_SCHEMA_VERSION', provider: 'plain', type: 'number' },
}

// Reverse mapping: fnox key → settings path
const FNOX_KEY_TO_PATH: Record<string, string> = {}
for (const [settingsPath, entry] of Object.entries(FNOX_CONFIG_MAP)) {
  FNOX_KEY_TO_PATH[entry.fnoxKey] = settingsPath
}

// --- Backward-compatible FNOX_SECRET_MAP (entries where provider === 'age') ---

export const FNOX_SECRET_MAP: Record<string, string> = {}
for (const [settingsPath, entry] of Object.entries(FNOX_CONFIG_MAP)) {
  if (entry.provider === 'age') {
    FNOX_SECRET_MAP[entry.fnoxKey] = settingsPath
  }
}

// --- Paths ---

// Nested under `config/` so fnox's upward directory walk from task worktrees
// at `~/.fulcrum/worktrees/<slug>/` does not discover this file and merge its
// providers into user-invoked `fnox` commands. The walk only checks direct
// children of each ancestor directory for `fnox.toml`/`.fnox.toml`, so any
// subdirectory is safe.
function getFnoxConfigPath(): string {
  return join(getFulcrumDir(), 'config', 'fnox.toml')
}

function getLegacyFnoxConfigPaths(fulcrumDir: string): string[] {
  return [join(fulcrumDir, '.fnox.toml'), join(fulcrumDir, 'fnox.toml')]
}

// Tmp+rename so a crash mid-write can't leave a half-written fnox.toml that fnox would refuse to decode.
function writeFileAtomicSync(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp`
  writeFileSync(tmpPath, content, 'utf-8')
  renameSync(tmpPath, filePath)
}

function backupLegacyFnoxConfig(legacyPath: string, configDir: string): void {
  const backupPath = join(configDir, `legacy-${basename(legacyPath)}.bak`)
  renameSync(legacyPath, backupPath)
  log.settings.info(`Backed up ${basename(legacyPath)} → config/${basename(backupPath)}`)
}

export function migrateLegacyFnoxConfig(fulcrumDir: string): boolean {
  const newPath = join(fulcrumDir, 'config', 'fnox.toml')
  if (existsSync(newPath)) return false

  const configDir = dirname(newPath)
  const legacyPaths = getLegacyFnoxConfigPaths(fulcrumDir)
  const sourcePath = legacyPaths.find(legacy => existsSync(legacy))
  if (!sourcePath) return false

  mkdirSync(configDir, { recursive: true })
  renameSync(sourcePath, newPath)
  log.settings.info(`Migrated ${basename(sourcePath)} → config/fnox.toml`)

  for (const legacy of legacyPaths) {
    if (legacy !== sourcePath && existsSync(legacy)) backupLegacyFnoxConfig(legacy, configDir)
  }

  return true
}

function getFnoxKeyPath(): string {
  return join(getFulcrumDir(), 'age.txt')
}

// --- Availability ---

let _fnoxAvailable: boolean | null = null

function requiresPersistentFnoxWrites(): boolean {
  return process.env.NODE_ENV === 'production' || process.env.FULCRUM_FNOX_STRICT === '1'
}

function allowsInMemoryFnoxWrites(): boolean {
  return !requiresPersistentFnoxWrites() || isTestMode() || process.env.FULCRUM_FNOX_IN_MEMORY_ONLY === '1'
}

function describeFnoxUnavailable(): string {
  const hasCliFlag = process.env.FULCRUM_FNOX_INSTALLED === '1'
  const configExists = existsSync(getFnoxConfigPath())
  const keyExists = existsSync(getFnoxKeyPath())

  if (!hasCliFlag) {
    try {
      execSync('which fnox', { stdio: 'ignore' })
    } catch {
      return 'fnox CLI not found in PATH'
    }
  }

  if (!configExists && !keyExists) return 'config/fnox.toml and age.txt are missing'
  if (!configExists) return 'config/fnox.toml is missing'
  if (!keyExists) return 'age.txt is missing'
  return 'fnox is not available'
}

export function isFnoxAvailable(): boolean {
  if (isTestMode()) return false
  if (_fnoxAvailable !== null) return _fnoxAvailable

  // Check env flag set by CLI (avoids shell alias detection issues)
  const hasCliFlag = process.env.FULCRUM_FNOX_INSTALLED === '1'

  // Check that config and key files exist
  const configExists = existsSync(getFnoxConfigPath())
  const keyExists = existsSync(getFnoxKeyPath())

  if (!hasCliFlag) {
    // Fallback: check if fnox binary is in PATH
    try {
      execSync('which fnox', { stdio: 'ignore' })
    } catch {
      _fnoxAvailable = false
      return false
    }
  }

  _fnoxAvailable = configExists && keyExists
  if (!_fnoxAvailable) {
    log.settings.debug('fnox not fully configured', { configExists, keyExists })
  }
  return _fnoxAvailable
}

// --- Server-side Bootstrap ---

/**
 * Bootstrap fnox configuration when the server starts directly (e.g. systemd)
 * without going through `fulcrum up`. Creates age.txt and config/fnox.toml if
 * missing. Test mode and explicit in-memory mode skip bootstrap.
 */
export function ensureFnoxBootstrap(): void {
  if (allowsInMemoryFnoxWrites()) return

  const fulcrumDir = getFulcrumDir()

  // Move any legacy `~/.fulcrum/fnox.toml` or `~/.fulcrum/.fnox.toml` into
  // `~/.fulcrum/config/fnox.toml`. Earlier versions kept the file at the
  // Fulcrum root, where fnox's upward walk from task worktrees picked it up
  // and silently re-encrypted user-level secrets to Fulcrum's age recipient.
  migrateLegacyFnoxConfig(fulcrumDir)

  const ageKeyPath = join(fulcrumDir, 'age.txt')
  const fnoxConfigPath = getFnoxConfigPath()

  // If both files exist, nothing to do
  if (existsSync(ageKeyPath) && existsSync(fnoxConfigPath)) return

  // Check that required binaries are available
  try {
    execSync('which fnox', { stdio: 'ignore' })
    execSync('which age-keygen', { stdio: 'ignore' })
  } catch {
    throw new Error('Cannot bootstrap Fulcrum configuration: fnox and age-keygen must be installed')
  }

  // Generate age key if needed
  let publicKey: string
  if (!existsSync(ageKeyPath)) {
    log.settings.info('Generating age encryption key...')
    try {
      const output = execSync(`age-keygen -o "${ageKeyPath}" 2>&1`, { encoding: 'utf-8' })
      const match = output.match(/Public key: (age1\S+)/)
      if (!match) {
        throw new Error('Cannot bootstrap Fulcrum configuration: age-keygen output did not include a public key')
      }
      publicKey = match[1]
      chmodSync(ageKeyPath, 0o600)
    } catch (err) {
      throw new Error(`Cannot bootstrap Fulcrum configuration: failed to generate age key: ${String(err)}`)
    }
  } else {
    const content = readFileSync(ageKeyPath, 'utf-8')
    const match = content.match(/# public key: (age1\S+)/)
    if (!match) {
      throw new Error('Cannot bootstrap Fulcrum configuration: existing age.txt does not include a public key')
    }
    publicKey = match[1]
  }

  // Create config/fnox.toml if needed
  if (!existsSync(fnoxConfigPath)) {
    log.settings.info('Creating fnox configuration...')
    mkdirSync(dirname(fnoxConfigPath), { recursive: true })
    const config = `[providers.plain]\ntype = "plain"\n\n[providers.age]\ntype = "age"\nrecipients = ["${publicKey}"]\n`
    writeFileAtomicSync(fnoxConfigPath, config)
  } else {
    // Ensure plain provider exists (upgrade from age-only)
    const existingConfig = readFileSync(fnoxConfigPath, 'utf-8')
    if (!existingConfig.includes('[providers.plain]')) {
      const updatedConfig = `[providers.plain]\ntype = "plain"\n\n${existingConfig}`
      writeFileAtomicSync(fnoxConfigPath, updatedConfig)
    }
  }

  // Reset the cached availability check so isFnoxAvailable() sees the new files
  _fnoxAvailable = null
}

// --- Core CLI Functions ---

function fnoxEnv(): Record<string, string | undefined> {
  return { ...process.env, FNOX_AGE_KEY_FILE: getFnoxKeyPath() }
}

function fnoxArgs(): string {
  return `-c "${getFnoxConfigPath()}"`
}

export function fnoxGet(key: string): string | null {
  try {
    const result = execSync(`fnox get ${key} ${fnoxArgs()} --if-missing ignore`, {
      env: fnoxEnv(),
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim()
    return result || null
  } catch {
    return null
  }
}

export function fnoxSet(key: string, value: string, provider?: 'age' | 'plain'): void {
  const providerArg = provider ? `-p ${provider}` : ''
  // Use stdin to avoid exposing secrets in process args
  execSync(`fnox set ${key} ${providerArg} ${fnoxArgs()}`, {
    env: fnoxEnv(),
    input: value,
    stdio: ['pipe', 'ignore', 'ignore'],
  })
}

export function fnoxRemove(key: string): void {
  try {
    execSync(`fnox remove ${key} ${fnoxArgs()} --if-missing ignore`, {
      env: fnoxEnv(),
      stdio: 'ignore',
    })
  } catch {
    // Ignore errors when removing non-existent keys
  }
}

// --- Bulk Export ---

function fnoxExportJson(): Record<string, string> {
  try {
    const result = execSync(`fnox export -f json ${fnoxArgs()}`, {
      env: fnoxEnv(),
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim()
    if (!result) return {}
    const parsed = JSON.parse(result)
    // fnox v1.12+ wraps values under a "secrets" key with separate "metadata"
    if (parsed.secrets && typeof parsed.secrets === 'object') {
      return parsed.secrets as Record<string, string>
    }
    return parsed as Record<string, string>
  } catch {
    return {}
  }
}

// --- In-Memory Cache ---
// Use globalThis to ensure a single shared cache across all module instances.
// Bun's mock.module can create duplicate module instances, so a module-level
// Map would result in multiple caches with stale data in different instances.
const CACHE_KEY = '__fulcrum_fnox_config_cache__'
if (!(globalThis as Record<string, unknown>)[CACHE_KEY]) {
  ;(globalThis as Record<string, unknown>)[CACHE_KEY] = new Map<string, string>()
}
const configCache = (globalThis as Record<string, unknown>)[CACHE_KEY] as Map<string, string>

export function initFnoxConfig(): void {
  if (!isFnoxAvailable()) return

  const exported = fnoxExportJson()
  let loaded = 0

  for (const [fnoxKey, value] of Object.entries(exported)) {
    // Only cache keys that are in our config map
    if (fnoxKey in FNOX_KEY_TO_PATH) {
      configCache.set(fnoxKey, value)
      loaded++
    }
  }

  if (loaded > 0) {
    log.settings.info('Loaded fnox config', { count: loaded })
  }
}

// Backward-compatible alias
export const initFnoxSecrets = initFnoxConfig

// --- Type-aware value access ---

/**
 * Deserialize a string value from fnox based on the config entry type.
 */
function deserializeValue(raw: string, entry: ConfigEntry): unknown {
  switch (entry.type) {
    case 'number': {
      const n = Number(raw)
      return isNaN(n) ? null : n
    }
    case 'boolean':
      return raw === 'true'
    case 'json':
      try {
        return JSON.parse(raw)
      } catch {
        return null
      }
    case 'string':
    default:
      return raw
  }
}

/**
 * Serialize a value to string for fnox storage.
 */
function serializeValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/**
 * Get a config value by its settings path (e.g. "server.port").
 * Returns the deserialized value or null if not set.
 * Always reads from in-memory cache (works in test mode without fnox CLI).
 */
export function getFnoxValue(settingsPath: string): unknown {
  const entry = FNOX_CONFIG_MAP[settingsPath]
  if (!entry) return null
  const raw = configCache.get(entry.fnoxKey)
  if (raw === undefined) return null
  return deserializeValue(raw, entry)
}

/**
 * Read a config value directly from `process.env` using the FNOX_CONFIG_MAP
 * entry's `fnoxKey`. Returns `null` when the env var is unset or empty.
 *
 * Used by code paths that need env-direct fallback in containers where the
 * fnox CLI / age.txt are not bootstrapped (e.g. Komodo-deployed Docker images
 * that only ship plaintext compose env). Caller composes precedence as
 * `env > fnox > default` via `getEnvFnoxValue(path) ?? getFnoxValue(path) ?? default`.
 */
export function getEnvFnoxValue(settingsPath: string): unknown {
  const entry = FNOX_CONFIG_MAP[settingsPath]
  if (!entry) return null
  const raw = process.env[entry.fnoxKey]
  if (raw === undefined || raw === '') return null
  return deserializeValue(raw, entry)
}

/**
 * Set a config value by its settings path.
 * Test mode and explicit in-memory mode update the cache without persisting.
 */
export function setFnoxValue(settingsPath: string, value: unknown): void {
  const entry = FNOX_CONFIG_MAP[settingsPath]
  if (!entry) return

  const serialized = serializeValue(value)
  if (serialized === '') {
    if (isFnoxAvailable()) {
      fnoxRemove(entry.fnoxKey)
    } else if (!allowsInMemoryFnoxWrites()) {
      throw new Error(`Cannot persist Fulcrum setting ${settingsPath}: ${describeFnoxUnavailable()}`)
    }
    configCache.delete(entry.fnoxKey)
  } else {
    if (isFnoxAvailable()) {
      fnoxSet(entry.fnoxKey, serialized, entry.provider)
    } else if (!allowsInMemoryFnoxWrites()) {
      throw new Error(`Cannot persist Fulcrum setting ${settingsPath}: ${describeFnoxUnavailable()}`)
    }
    configCache.set(entry.fnoxKey, serialized)
  }
}

// --- Backward-compatible secret access ---

/**
 * Get a secret by its settings path (e.g. "integrations.githubPat").
 * Returns the cached string value or null.
 */
export function getFnoxSecret(settingsPath: string): string | null {
  const entry = FNOX_CONFIG_MAP[settingsPath]
  if (!entry) return null
  return configCache.get(entry.fnoxKey) ?? null
}

/**
 * Set a secret by its settings path.
 */
export function setFnoxSecret(settingsPath: string, value: string): void {
  setFnoxValue(settingsPath, value)
}

/**
 * Remove a secret by its settings path.
 */
export function removeFnoxSecret(settingsPath: string): void {
  const entry = FNOX_CONFIG_MAP[settingsPath]
  if (!entry) return
  if (isFnoxAvailable()) {
    fnoxRemove(entry.fnoxKey)
  } else if (!allowsInMemoryFnoxWrites()) {
    throw new Error(`Cannot persist Fulcrum setting ${settingsPath}: ${describeFnoxUnavailable()}`)
  }
  configCache.delete(entry.fnoxKey)
}

/**
 * Check if a settings path corresponds to a secret (age-encrypted).
 */
export function isSecretPath(settingsPath: string): boolean {
  const entry = FNOX_CONFIG_MAP[settingsPath]
  return (entry?.provider === 'age') || false
}

/**
 * Get the count of config values currently stored in fnox.
 */
export function getFnoxConfigCount(): number {
  return configCache.size
}

// Backward-compatible alias
export const getFnoxSecretCount = getFnoxConfigCount

/**
 * Clear the in-memory config cache. Used in tests to reset state between runs.
 */
export function clearFnoxCache(): void {
  configCache.clear()
}
