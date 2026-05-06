/**
 * Mattermost REST API client for Fulcrum bot operations.
 */

import { getSettings } from '../../lib/settings'
import { log } from '../../lib/logger'
import type { MattermostSettings } from '../../lib/settings/types'

export interface MattermostPost {
  channel_id: string
  message?: string
  props?: {
    attachments?: MattermostAttachment[]
  }
}

export interface MattermostAttachment {
  fallback?: string
  color?: string
  pretext?: string
  text?: string
  title?: string
  title_link?: string
  fields?: MattermostField[]
  actions?: MattermostAction[]
}

export interface MattermostField {
  short: boolean
  title: string
  value: string
}

export interface MattermostAction {
  id: string
  name: string
  type: 'button' | 'select'
  style?: 'default' | 'primary' | 'good' | 'warning' | 'danger'
  integration?: {
    url: string
    context: Record<string, unknown>
  }
  data_source?: 'users' | 'channels'
  options?: Array<{ text: string; value: string }>
  default_option?: { text: string; value: string }
}

export interface MattermostDialog {
  callback_id: string
  title: string
  introduction_text?: string
  submit_label?: string
  elements: MattermostDialogElement[]
}

export interface MattermostDialogElement {
  display_name: string
  name: string
  type: 'text' | 'textarea' | 'select'
  subtype?: 'email' | 'number' | 'url'
  placeholder?: string
  default?: string
  optional?: boolean
  options?: Array<{ text: string; value: string }>
}

function getConfig(): MattermostSettings {
  return getSettings().channels.mattermost
}

type FulcrumHostPort = { host: string; port: number }

type FulcrumUrlResolution =
  | { kind: 'resolved'; value: FulcrumHostPort }
  | { kind: 'missing-callback-host'; port: number }

function resolveHostPort(): FulcrumUrlResolution {
  const settings = getSettings()
  const host = process.env.FULCRUM_HOST || settings.editor.host

  if (host) {
    return { kind: 'resolved', value: { host, port: settings.server.port } }
  }

  if (settings.channels.mattermost.enabled) {
    return { kind: 'missing-callback-host', port: settings.server.port }
  }

  return { kind: 'resolved', value: { host: 'localhost', port: settings.server.port } }
}

function getHostPort(): FulcrumHostPort {
  const resolution = resolveHostPort()

  switch (resolution.kind) {
    case 'resolved':
      return resolution.value
    case 'missing-callback-host':
      log.messaging.warn('Mattermost callback host not configured', {
        requiredEnv: 'FULCRUM_HOST',
        fallbackRejected: 'localhost',
        port: resolution.port,
      })
      throw new Error('Mattermost callback host not configured: set FULCRUM_HOST')
  }
}

function getCallbackUrl(path: string): string {
  const { host, port } = getHostPort()
  return `http://${host}:${port}/api/mattermost${path}`
}

export function fulcrumUrl(path: string): string {
  const { host, port } = getHostPort()
  return `http://${host}:${port}${path}`
}

async function mmFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const config = getConfig()
  if (!config.serverUrl || !config.botToken) {
    throw new Error('Mattermost not configured')
  }

  const url = `${config.serverUrl}/api/v4${path}`
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.botToken}`,
      ...options.headers,
    },
  })

  if (!res.ok) {
    const body = await res.text()
    log.error('Mattermost API error', { status: res.status, path, body })
    throw new Error(`Mattermost API error: ${res.status} ${body}`)
  }

  return res
}

/** Post a message to a Mattermost channel */
export async function postMessage(post: MattermostPost): Promise<{ id: string }> {
  const res = await mmFetch('/posts', {
    method: 'POST',
    body: JSON.stringify(post),
  })
  return res.json()
}

/** Update an existing post */
export async function updatePost(postId: string, post: Partial<MattermostPost> & { id: string }): Promise<void> {
  await mmFetch(`/posts/${postId}`, {
    method: 'PUT',
    body: JSON.stringify(post),
  })
}

/** Open an interactive dialog */
export async function openDialog(triggerId: string, dialog: MattermostDialog): Promise<void> {
  await mmFetch('/actions/dialogs/open', {
    method: 'POST',
    body: JSON.stringify({
      trigger_id: triggerId,
      url: getCallbackUrl('/dialogs'),
      dialog,
    }),
  })
}

/** Post a notification card to the configured default channel */
export async function postNotification(attachment: MattermostAttachment): Promise<{ id: string }> {
  const config = getConfig()
  return postMessage({
    channel_id: config.channelId,
    props: { attachments: [attachment] },
  })
}

/** Get the callback URL for actions */
export function getActionsUrl(): string {
  return getCallbackUrl('/actions')
}

/** Get the callback URL for dialogs */
export function getDialogsUrl(): string {
  return getCallbackUrl('/dialogs')
}

/** Get the bot's own user ID (cached after first call) */
let botUserId: string | null = null
async function getBotUserId(): Promise<string> {
  if (botUserId) return botUserId
  const res = await mmFetch('/users/me')
  const me = await res.json() as { id: string }
  botUserId = me.id
  return botUserId
}

/** Create a DM channel with a user and post a message */
export async function postDirectMessage(userId: string, attachment: MattermostAttachment): Promise<{ id: string }> {
  const botId = await getBotUserId()
  const dmRes = await mmFetch('/channels/direct', {
    method: 'POST',
    body: JSON.stringify([userId, botId]),
  })
  const dm = await dmRes.json() as { id: string }

  return postMessage({
    channel_id: dm.id,
    props: { attachments: [attachment] },
  })
}

export { getConfig, getCallbackUrl }
