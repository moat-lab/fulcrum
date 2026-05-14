// Re-export all public APIs for backward compatibility
// All existing imports from './settings' will continue to work

// Types and constants
export {
  CURRENT_SCHEMA_VERSION,
  DEFAULT_SETTINGS,
  VALID_SETTING_PATHS,
  MIGRATION_MAP,
  type EditorApp,
  type TaskType,
  type AssistantProvider,
  type AssistantModel,
  type Settings,
  type LegacySettings,
  type SoundNotificationConfig,
  type ToastNotificationConfig,
  type DesktopNotificationConfig,
  type SlackNotificationConfig,
  type DiscordNotificationConfig,
  type PushoverNotificationConfig,
  type WhatsAppNotificationConfig,
  type TelegramNotificationConfig,
  type GmailNotificationConfig,
  type NotificationSettings,
  type NotificationSettingsUpdateResult,
  type ZAiSettings,
} from './types'

// Path utilities
export {
  enableTestMode,
  isTestMode,
  expandPath,
  getFulcrumDir,
  getDatabasePath,
  getWorktreeBasePath,
  getScratchBasePath,
  ensureFulcrumDir,
  ensureWorktreesDir,
  ensureScratchDir,
  getSettingsPath,
} from './paths'

// Migration utilities (exported for tests)
export { getNestedValue, setNestedValue } from './migration'

// Core settings CRUD
export {
  ensureSettingsFile,
  getSettings,
  getSetting,
  getSettingByKey,
  toLegacySettings,
  isDeveloperMode,
  updateSettingByPath,
  updateSettings,
  resetSettings,
  getDefaultValue,
  ensureLatestSettings,
  ensureLatestConfig,
} from './core'

// Notification settings
export {
  getNotificationSettings,
  updateNotificationSettings,
} from './notifications'

// Claude Code settings
export {
  getClaudeSettings,
  updateClaudeSettings,
  getClaudeConfig,
  updateClaudeConfig,
} from './claude-code'

// z.ai settings
export {
  getZAiSettings,
  updateZAiSettings,
} from './zai'

// fnox config management
export {
  isFnoxAvailable,
  isSecretPath,
  getFnoxSecret,
  setFnoxSecret,
  removeFnoxSecret,
  getFnoxValue,
  getEnvFnoxValue,
  setFnoxValue,
  initFnoxConfig,
  initFnoxSecrets,
  getFnoxConfigCount,
  getFnoxSecretCount,
  FNOX_CONFIG_MAP,
  FNOX_SECRET_MAP,
  clearFnoxCache,
  ensureFnoxBootstrap,
} from './fnox'

// initializeFulcrumDirectories
import { ensureFulcrumDir, ensureWorktreesDir } from './paths'

// Initialize all required directories and files
export function initializeFulcrumDirectories(): void {
  ensureFulcrumDir()
  ensureWorktreesDir()
}
