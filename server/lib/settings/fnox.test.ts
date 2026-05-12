import { describe, test, expect } from 'bun:test'
import * as childProcess from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FNOX_CONFIG_MAP, FNOX_SECRET_MAP, isSecretPath, migrateLegacyFnoxConfig } from './fnox'
import { VALID_SETTING_PATHS } from './types'

describe('fnox', () => {
  describe('FNOX_CONFIG_MAP', () => {
    test('all mapped settings paths are valid setting paths, notification paths, zai paths, or internal', () => {
      // Paths outside of VALID_SETTING_PATHS that are managed in their own config sections
      const extraPaths = new Set([
        'notifications.enabled',
        'notifications.toast.enabled',
        'notifications.desktop.enabled',
        'notifications.sound.enabled',
        'notifications.sound.customSoundFile',
        'notifications.slack.enabled',
        'notifications.slack.webhookUrl',
        'notifications.slack.useMessagingChannel',
        'notifications.discord.enabled',
        'notifications.discord.webhookUrl',
        'notifications.discord.useMessagingChannel',
        'notifications.pushover.enabled',
        'notifications.pushover.appToken',
        'notifications.pushover.userKey',
        'notifications.whatsapp.enabled',
        'notifications.telegram.enabled',
        'notifications.gmail.enabled',
        'notifications.gmail.googleAccountId',
        'notifications.mattermost.enabled',
        'notifications._updatedAt',
        'zai.enabled',
        'zai.apiKey',
        'zai.haikuModel',
        'zai.sonnetModel',
        'zai.opusModel',
        '_schemaVersion',
      ])

      for (const settingsPath of Object.keys(FNOX_CONFIG_MAP)) {
        const isValid = VALID_SETTING_PATHS.has(settingsPath) || extraPaths.has(settingsPath)
        if (!isValid) throw new Error(`Unexpected settings path: ${settingsPath}`)
        expect(isValid).toBe(true)
      }
    })

    test('all fnox keys use FULCRUM_ prefix', () => {
      for (const entry of Object.values(FNOX_CONFIG_MAP)) {
        expect(entry.fnoxKey.startsWith('FULCRUM_')).toBe(true)
      }
    })

    test('all fnox keys are unique', () => {
      const keys = Object.values(FNOX_CONFIG_MAP).map(e => e.fnoxKey)
      const uniqueKeys = new Set(keys)
      expect(keys.length).toBe(uniqueKeys.size)
    })

    test('covers all VALID_SETTING_PATHS', () => {
      for (const path of VALID_SETTING_PATHS) {
        expect(FNOX_CONFIG_MAP[path]).toBeDefined()
      }
    })

    test('has entries for all setting types', () => {
      const types = new Set(Object.values(FNOX_CONFIG_MAP).map(e => e.type))
      expect(types.has('string')).toBe(true)
      expect(types.has('number')).toBe(true)
      expect(types.has('boolean')).toBe(true)
    })

    test('has entries for both providers', () => {
      const providers = new Set(Object.values(FNOX_CONFIG_MAP).map(e => e.provider))
      expect(providers.has('plain')).toBe(true)
      expect(providers.has('age')).toBe(true)
    })

    test('maps known integration secrets', () => {
      expect(FNOX_CONFIG_MAP['integrations.githubPat'].fnoxKey).toBe('FULCRUM_GITHUB_PAT')
      expect(FNOX_CONFIG_MAP['integrations.githubPat'].provider).toBe('age')
      expect(FNOX_CONFIG_MAP['integrations.cloudflareApiToken'].fnoxKey).toBe('FULCRUM_CLOUDFLARE_API_TOKEN')
      expect(FNOX_CONFIG_MAP['integrations.googleClientId'].fnoxKey).toBe('FULCRUM_GOOGLE_CLIENT_ID')
      expect(FNOX_CONFIG_MAP['integrations.googleClientSecret'].fnoxKey).toBe('FULCRUM_GOOGLE_CLIENT_SECRET')
    })

    test('maps known channel secrets', () => {
      expect(FNOX_CONFIG_MAP['channels.slack.botToken'].fnoxKey).toBe('FULCRUM_SLACK_BOT_TOKEN')
      expect(FNOX_CONFIG_MAP['channels.slack.botToken'].provider).toBe('age')
      expect(FNOX_CONFIG_MAP['channels.slack.appToken'].fnoxKey).toBe('FULCRUM_SLACK_APP_TOKEN')
      expect(FNOX_CONFIG_MAP['channels.discord.botToken'].fnoxKey).toBe('FULCRUM_DISCORD_BOT_TOKEN')
      expect(FNOX_CONFIG_MAP['channels.telegram.botToken'].fnoxKey).toBe('FULCRUM_TELEGRAM_BOT_TOKEN')
      expect(FNOX_CONFIG_MAP['channels.email.imap.password'].fnoxKey).toBe('FULCRUM_EMAIL_IMAP_PASSWORD')
    })

    test('maps known notification secrets', () => {
      expect(FNOX_CONFIG_MAP['notifications.pushover.appToken'].fnoxKey).toBe('FULCRUM_PUSHOVER_APP_TOKEN')
      expect(FNOX_CONFIG_MAP['notifications.pushover.appToken'].provider).toBe('age')
      expect(FNOX_CONFIG_MAP['notifications.pushover.userKey'].fnoxKey).toBe('FULCRUM_PUSHOVER_USER_KEY')
      expect(FNOX_CONFIG_MAP['notifications.slack.webhookUrl'].fnoxKey).toBe('FULCRUM_SLACK_WEBHOOK_URL')
      expect(FNOX_CONFIG_MAP['notifications.discord.webhookUrl'].fnoxKey).toBe('FULCRUM_DISCORD_WEBHOOK_URL')
    })

    test('maps z.ai secret', () => {
      expect(FNOX_CONFIG_MAP['zai.apiKey'].fnoxKey).toBe('FULCRUM_ZAI_API_KEY')
      expect(FNOX_CONFIG_MAP['zai.apiKey'].provider).toBe('age')
    })

    test('maps plain config values', () => {
      expect(FNOX_CONFIG_MAP['server.port'].provider).toBe('plain')
      expect(FNOX_CONFIG_MAP['server.port'].type).toBe('number')
      expect(FNOX_CONFIG_MAP['editor.app'].provider).toBe('plain')
      expect(FNOX_CONFIG_MAP['editor.app'].type).toBe('string')
      expect(FNOX_CONFIG_MAP['agent.autoScrollToBottom'].provider).toBe('plain')
      expect(FNOX_CONFIG_MAP['agent.autoScrollToBottom'].type).toBe('boolean')
    })
  })

  describe('FNOX_SECRET_MAP (backward compat)', () => {
    test('contains only age-encrypted entries', () => {
      for (const [fnoxKey, settingsPath] of Object.entries(FNOX_SECRET_MAP)) {
        expect(FNOX_CONFIG_MAP[settingsPath].provider).toBe('age')
        expect(FNOX_CONFIG_MAP[settingsPath].fnoxKey).toBe(fnoxKey)
      }
    })

    test('has expected number of secret mappings (18)', () => {
      // 17 base secrets + channels.exchange.token (age-encrypted bearer per #180).
      expect(Object.keys(FNOX_SECRET_MAP).length).toBe(18)
    })
  })

  describe('isSecretPath', () => {
    test('returns true for known secret paths', () => {
      expect(isSecretPath('integrations.githubPat')).toBe(true)
      expect(isSecretPath('integrations.cloudflareApiToken')).toBe(true)
      expect(isSecretPath('channels.slack.botToken')).toBe(true)
      expect(isSecretPath('notifications.pushover.appToken')).toBe(true)
      expect(isSecretPath('zai.apiKey')).toBe(true)
    })

    test('returns false for non-secret paths', () => {
      expect(isSecretPath('server.port')).toBe(false)
      expect(isSecretPath('editor.app')).toBe(false)
      expect(isSecretPath('appearance.theme')).toBe(false)
      expect(isSecretPath('channels.slack.enabled')).toBe(false)
      expect(isSecretPath('notifications.enabled')).toBe(false)
    })

    test('returns false for unknown paths', () => {
      expect(isSecretPath('foo.bar')).toBe(false)
      expect(isSecretPath('')).toBe(false)
    })
  })

  describe('migrateLegacyFnoxConfig', () => {
    type LegacyFileName = '.fnox.toml' | 'fnox.toml'

    function withTempFulcrumDir(run: (fulcrumDir: string) => void): void {
      const fulcrumDir = mkdtempSync(join(tmpdir(), 'fulcrum-fnox-migrate-'))
      try {
        run(fulcrumDir)
      } finally {
        rmSync(fulcrumDir, { recursive: true, force: true })
      }
    }

    function writeLegacyFiles(fulcrumDir: string, fileNames: LegacyFileName[]): void {
      for (const fileName of fileNames) {
        writeFileSync(join(fulcrumDir, fileName), `${fileName} content`, 'utf-8')
      }
    }

    test('migrates only .fnox.toml when it is the only legacy file', () => {
      withTempFulcrumDir(fulcrumDir => {
        writeLegacyFiles(fulcrumDir, ['.fnox.toml'])

        expect(migrateLegacyFnoxConfig(fulcrumDir)).toBe(true)

        expect(readFileSync(join(fulcrumDir, 'config', 'fnox.toml'), 'utf-8')).toBe('.fnox.toml content')
        expect(existsSync(join(fulcrumDir, '.fnox.toml'))).toBe(false)
        expect(existsSync(join(fulcrumDir, 'fnox.toml'))).toBe(false)
      })
    })

    test('migrates only fnox.toml when it is the only legacy file', () => {
      withTempFulcrumDir(fulcrumDir => {
        writeLegacyFiles(fulcrumDir, ['fnox.toml'])

        expect(migrateLegacyFnoxConfig(fulcrumDir)).toBe(true)

        expect(readFileSync(join(fulcrumDir, 'config', 'fnox.toml'), 'utf-8')).toBe('fnox.toml content')
        expect(existsSync(join(fulcrumDir, '.fnox.toml'))).toBe(false)
        expect(existsSync(join(fulcrumDir, 'fnox.toml'))).toBe(false)
      })
    })

    test('migrates .fnox.toml and backs up fnox.toml when both legacy files exist', () => {
      withTempFulcrumDir(fulcrumDir => {
        writeLegacyFiles(fulcrumDir, ['.fnox.toml', 'fnox.toml'])

        expect(migrateLegacyFnoxConfig(fulcrumDir)).toBe(true)

        expect(readFileSync(join(fulcrumDir, 'config', 'fnox.toml'), 'utf-8')).toBe('.fnox.toml content')
        expect(readFileSync(join(fulcrumDir, 'config', 'legacy-fnox.toml.bak'), 'utf-8')).toBe('fnox.toml content')
        expect(existsSync(join(fulcrumDir, '.fnox.toml'))).toBe(false)
        expect(existsSync(join(fulcrumDir, 'fnox.toml'))).toBe(false)
      })
    })

    test('does nothing when no legacy files exist', () => {
      withTempFulcrumDir(fulcrumDir => {
        expect(migrateLegacyFnoxConfig(fulcrumDir)).toBe(false)

        expect(existsSync(join(fulcrumDir, 'config', 'fnox.toml'))).toBe(false)
        expect(existsSync(join(fulcrumDir, '.fnox.toml'))).toBe(false)
        expect(existsSync(join(fulcrumDir, 'fnox.toml'))).toBe(false)
      })
    })

    test('does nothing when the nested fnox config already exists', () => {
      withTempFulcrumDir(fulcrumDir => {
        writeLegacyFiles(fulcrumDir, ['.fnox.toml', 'fnox.toml'])
        const nestedPath = join(fulcrumDir, 'config', 'fnox.toml')
        mkdirSync(join(fulcrumDir, 'config'), { recursive: true })
        writeFileSync(nestedPath, 'nested content', 'utf-8')

        expect(migrateLegacyFnoxConfig(fulcrumDir)).toBe(false)

        expect(readFileSync(nestedPath, 'utf-8')).toBe('nested content')
        expect(readFileSync(join(fulcrumDir, '.fnox.toml'), 'utf-8')).toBe('.fnox.toml content')
        expect(readFileSync(join(fulcrumDir, 'fnox.toml'), 'utf-8')).toBe('fnox.toml content')
      })
    })
  })

  describe('test mode behavior', () => {
    test('isFnoxAvailable returns false in test mode', async () => {
      const { isFnoxAvailable } = await import('./fnox')
      expect(isFnoxAvailable()).toBe(false)
    })

    test('getFnoxSecret returns null when cache is empty', async () => {
      const { getFnoxSecret } = await import('./fnox')
      expect(getFnoxSecret('integrations.githubPat')).toBeNull()
    })

    test('getFnoxValue returns null when cache is empty', async () => {
      const { getFnoxValue } = await import('./fnox')
      expect(getFnoxValue('server.port')).toBeNull()
    })

    test('setFnoxValue/getFnoxValue roundtrip works in test mode (cache only)', async () => {
      const { setFnoxValue, getFnoxValue, clearFnoxCache } = await import('./fnox')
      clearFnoxCache()
      setFnoxValue('server.port', 9999)
      expect(getFnoxValue('server.port')).toBe(9999)
      clearFnoxCache()
      expect(getFnoxValue('server.port')).toBeNull()
    })
  })

  describe('non-test persistence failures', () => {
    test('setFnoxValue throws instead of cache-only fallback when fnox is unavailable', () => {
      const output = childProcess.execSync(
        `PATH=/usr/bin:/bin FULCRUM_FNOX_STRICT=1 FULCRUM_FNOX_INSTALLED=0 "${process.execPath}" -e "const m = await import('./server/lib/settings/fnox.ts'); m.clearFnoxCache(); try { m.setFnoxValue('server.port', 9999); process.exit(1) } catch (err) { console.log(String(err.message)) }"`,
        { encoding: 'utf-8' },
      )

      expect(output).toContain('Cannot persist Fulcrum setting server.port: fnox CLI not found in PATH')
    })

    test('removeFnoxSecret throws instead of cache-only delete when fnox is unavailable', () => {
      const output = childProcess.execSync(
        `PATH=/usr/bin:/bin FULCRUM_FNOX_IN_MEMORY_ONLY=1 "${process.execPath}" -e "const m = await import('./server/lib/settings/fnox.ts'); m.clearFnoxCache(); m.setFnoxValue('integrations.githubPat', 'test-token'); process.env.FULCRUM_FNOX_STRICT = '1'; delete process.env.FULCRUM_FNOX_IN_MEMORY_ONLY; try { m.removeFnoxSecret('integrations.githubPat'); process.exit(1) } catch (err) { console.log(String(err.message)); console.log(m.getFnoxSecret('integrations.githubPat')) }"`,
        { encoding: 'utf-8' },
      )

      expect(output).toContain('Cannot persist Fulcrum setting integrations.githubPat: fnox CLI not found in PATH')
      expect(output).toContain('test-token')
    })

    test('explicit in-memory mode keeps cache-only writes opt-in', () => {
      const output = childProcess.execSync(
        `PATH=/usr/bin:/bin FULCRUM_FNOX_IN_MEMORY_ONLY=1 "${process.execPath}" -e "const m = await import('./server/lib/settings/fnox.ts'); m.clearFnoxCache(); m.setFnoxValue('server.port', 9999); console.log(m.getFnoxValue('server.port'))"`,
        { encoding: 'utf-8' },
      )

      expect(output).toContain('9999')
    })

    test('ensureFnoxBootstrap throws when required binaries are unavailable', () => {
      const output = childProcess.execSync(
        `PATH=/usr/bin:/bin FULCRUM_FNOX_STRICT=1 FULCRUM_DIR=/tmp/fulcrum-missing-fnox-test "${process.execPath}" -e "const m = await import('./server/lib/settings/fnox.ts'); try { m.ensureFnoxBootstrap(); process.exit(1) } catch (err) { console.log(String(err.message)) }"`,
        { encoding: 'utf-8' },
      )

      expect(output).toContain('Cannot bootstrap Fulcrum configuration: fnox and age-keygen must be installed')
    })
  })
})
