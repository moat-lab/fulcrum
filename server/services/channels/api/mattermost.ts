import { getSettings, updateSettingByPath } from '../../../lib/settings'
import {
  activeChannels,
  MATTERMOST_CONNECTION_ID,
  startMattermostChannel,
  stopMattermostChannel,
  getChannelFactory,
} from '../channel-manager'
import type { ConnectionStatus } from '../types'

export { MATTERMOST_CONNECTION_ID } from '../channel-manager'

export async function configureMattermost(serverUrl: string, botToken: string, teamId: string, channelId: string, commandToken: string): Promise<{
  enabled: boolean
  status: ConnectionStatus
}> {
  const factory = getChannelFactory()
  if (factory.validateMattermostConfig) {
    try {
      await factory.validateMattermostConfig(serverUrl, botToken)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`Invalid Mattermost configuration: ${message}`)
    }
  }

  await stopMattermostChannel()

  updateSettingByPath('channels.mattermost.enabled', true)
  updateSettingByPath('channels.mattermost.serverUrl', serverUrl)
  updateSettingByPath('channels.mattermost.botToken', botToken)
  updateSettingByPath('channels.mattermost.teamId', teamId)
  updateSettingByPath('channels.mattermost.channelId', channelId)
  updateSettingByPath('channels.mattermost.commandToken', commandToken)

  await startMattermostChannel()
  const channel = activeChannels.get(MATTERMOST_CONNECTION_ID)

  return { enabled: true, status: channel?.getStatus() || 'connecting' }
}

export async function enableMattermost(): Promise<{
  enabled: boolean
  status: ConnectionStatus
  error?: string
}> {
  const config = getSettings().channels.mattermost
  if (!config.serverUrl || !config.botToken) {
    return { enabled: false, status: 'credentials_required', error: 'Mattermost server URL and bot token are not configured.' }
  }

  await stopMattermostChannel()
  updateSettingByPath('channels.mattermost.enabled', true)
  await startMattermostChannel()
  const channel = activeChannels.get(MATTERMOST_CONNECTION_ID)

  return { enabled: true, status: channel?.getStatus() || 'connecting' }
}

export async function disableMattermost(): Promise<{
  enabled: boolean
  status: ConnectionStatus
}> {
  await stopMattermostChannel()
  updateSettingByPath('channels.mattermost.enabled', false)
  return { enabled: false, status: 'disconnected' }
}

export async function disconnectMattermost(): Promise<{
  enabled: boolean
  status: ConnectionStatus
}> {
  await stopMattermostChannel()
  updateSettingByPath('channels.mattermost.enabled', false)
  updateSettingByPath('channels.mattermost.serverUrl', '')
  updateSettingByPath('channels.mattermost.botToken', '')
  updateSettingByPath('channels.mattermost.teamId', '')
  updateSettingByPath('channels.mattermost.channelId', '')
  updateSettingByPath('channels.mattermost.commandToken', '')
  return { enabled: false, status: 'disconnected' }
}

export function getMattermostStatus(): {
  enabled: boolean
  status: ConnectionStatus
} {
  const config = getSettings().channels.mattermost
  if (!config.enabled) return { enabled: false, status: 'disconnected' }
  if (!config.serverUrl || !config.botToken) return { enabled: true, status: 'credentials_required' }

  const channel = activeChannels.get(MATTERMOST_CONNECTION_ID)
  return { enabled: true, status: channel?.getStatus() || 'disconnected' }
}

export function getMattermostConfig(): {
  enabled: boolean
  serverUrl: string
  botToken: string
  teamId: string
  channelId: string
  commandToken: string
} | null {
  const config = getSettings().channels.mattermost
  if (!config.serverUrl && !config.botToken) return null

  return {
    enabled: config.enabled,
    serverUrl: config.serverUrl,
    botToken: config.botToken ? '••••••••' : '',
    teamId: config.teamId,
    channelId: config.channelId,
    commandToken: config.commandToken ? '••••••••' : '',
  }
}
