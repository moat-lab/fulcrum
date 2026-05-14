/**
 * Messaging API routes for WhatsApp and other messaging channels.
 */

import { Hono } from 'hono'
import {
  listConnections,
  getWhatsAppStatus,
  enableWhatsApp,
  disableWhatsApp,
  requestWhatsAppAuth,
  disconnectWhatsApp,
  listSessionMappings,
  // Discord
  getDiscordStatus,
  getDiscordConfig,
  configureDiscord,
  enableDiscord,
  disableDiscord,
  disconnectDiscord,
  // Telegram
  getTelegramStatus,
  getTelegramConfig,
  configureTelegram,
  enableTelegram,
  disableTelegram,
  disconnectTelegram,
  // Slack
  getSlackStatus,
  getSlackConfig,
  configureSlack,
  enableSlack,
  disableSlack,
  disconnectSlack,
  // Mattermost
  getMattermostStatus,
  getMattermostConfig,
  configureMattermost,
  enableMattermost,
  disableMattermost,
  disconnectMattermost,
  // Email
  getEmailStatus,
  getEmailConfig,
  configureEmail,
  testEmailCredentials,
  enableEmail,
  disableEmail,
  getStoredEmails,
  searchImapEmails,
  fetchAndStoreEmails,
  sendMessageToChannel,
  type EmailAuthState,
  // Connection IDs for session lookups
  SLACK_CONNECTION_ID,
  DISCORD_CONNECTION_ID,
  TELEGRAM_CONNECTION_ID,
  MATTERMOST_CONNECTION_ID,
} from '../services/channels'
import { getStoredEmailById, type StoredEmail } from '../services/channels/email-storage'
import { getChannelMessageById } from '../services/channels/message-storage'
import { log } from '../lib/logger'

const app = new Hono()

// GET /api/messaging/channels - List all messaging channels
app.get('/channels', (c) => {
  const connections = listConnections()
  return c.json({ channels: connections })
})

// GET /api/messaging/whatsapp - Get WhatsApp connection status
app.get('/whatsapp', (c) => {
  const conn = getWhatsAppStatus()
  return c.json(conn || { enabled: false, status: 'disconnected' })
})

// POST /api/messaging/whatsapp/enable - Enable WhatsApp integration
app.post('/whatsapp/enable', async (c) => {
  try {
    const conn = await enableWhatsApp()
    log.messaging.info('WhatsApp enabled via API')
    return c.json(conn)
  } catch (err) {
    log.messaging.error('Failed to enable WhatsApp', { error: String(err) })
    return c.json({ error: String(err) }, 500)
  }
})

// POST /api/messaging/whatsapp/disable - Disable WhatsApp integration
app.post('/whatsapp/disable', async (c) => {
  try {
    const conn = await disableWhatsApp()
    log.messaging.info('WhatsApp disabled via API')
    return c.json(conn)
  } catch (err) {
    log.messaging.error('Failed to disable WhatsApp', { error: String(err) })
    return c.json({ error: String(err) }, 500)
  }
})

// POST /api/messaging/whatsapp/auth - Request QR code for authentication
app.post('/whatsapp/auth', async (c) => {
  try {
    const result = await requestWhatsAppAuth()
    return c.json(result)
  } catch (err) {
    log.messaging.error('Failed to request WhatsApp auth', { error: String(err) })
    return c.json({ error: String(err) }, 500)
  }
})

// POST /api/messaging/whatsapp/disconnect - Disconnect and clear auth
app.post('/whatsapp/disconnect', async (c) => {
  try {
    const conn = await disconnectWhatsApp()
    log.messaging.info('WhatsApp disconnected via API')
    return c.json(conn)
  } catch (err) {
    log.messaging.error('Failed to disconnect WhatsApp', { error: String(err) })
    return c.json({ error: String(err) }, 500)
  }
})

// GET /api/messaging/whatsapp/sessions - List WhatsApp session mappings
app.get('/whatsapp/sessions', (c) => {
  const conn = getWhatsAppStatus()
  if (!conn) {
    return c.json({ sessions: [] })
  }

  const mappings = listSessionMappings(conn.id)
  return c.json({ sessions: mappings })
})

// ==================== Discord Routes ====================

// GET /api/messaging/discord - Get Discord connection status
app.get('/discord', (c) => {
  const status = getDiscordStatus()
  const config = getDiscordConfig()
  return c.json({
    ...status,
    config,
  })
})

// POST /api/messaging/discord/configure - Configure and enable Discord with bot token
app.post('/discord/configure', async (c) => {
  try {
    const body = await c.req.json()
    const { botToken } = body

    if (!botToken || typeof botToken !== 'string') {
      return c.json({ error: 'botToken is required' }, 400)
    }

    const result = await configureDiscord(botToken)
    log.messaging.info('Discord configured via API')
    return c.json(result)
  } catch (err) {
    log.messaging.error('Failed to configure Discord', { error: String(err) })
    return c.json({ error: String(err) }, 500)
  }
})

// POST /api/messaging/discord/enable - Enable Discord using existing credentials
app.post('/discord/enable', async (c) => {
  try {
    const result = await enableDiscord()
    if (result.error) {
      return c.json({ error: result.error }, 400)
    }
    log.messaging.info('Discord enabled via API')
    return c.json(result)
  } catch (err) {
    log.messaging.error('Failed to enable Discord', { error: String(err) })
    return c.json({ error: String(err) }, 500)
  }
})

// POST /api/messaging/discord/disable - Disable Discord integration
app.post('/discord/disable', async (c) => {
  try {
    const result = await disableDiscord()
    log.messaging.info('Discord disabled via API')
    return c.json(result)
  } catch (err) {
    log.messaging.error('Failed to disable Discord', { error: String(err) })
    return c.json({ error: String(err) }, 500)
  }
})

// POST /api/messaging/discord/disconnect - Disconnect and clear credentials
app.post('/discord/disconnect', async (c) => {
  try {
    const result = await disconnectDiscord()
    log.messaging.info('Discord disconnected via API')
    return c.json(result)
  } catch (err) {
    log.messaging.error('Failed to disconnect Discord', { error: String(err) })
    return c.json({ error: String(err) }, 500)
  }
})

// GET /api/messaging/discord/sessions - List Discord session mappings
app.get('/discord/sessions', (c) => {
  const status = getDiscordStatus()
  if (!status.enabled) {
    return c.json({ sessions: [] })
  }

  const mappings = listSessionMappings(DISCORD_CONNECTION_ID)
  return c.json({ sessions: mappings })
})

// ==================== Telegram Routes ====================

// GET /api/messaging/telegram - Get Telegram connection status
app.get('/telegram', (c) => {
  const status = getTelegramStatus()
  const config = getTelegramConfig()
  return c.json({
    ...status,
    config,
  })
})

// POST /api/messaging/telegram/configure - Configure and enable Telegram with bot token
app.post('/telegram/configure', async (c) => {
  try {
    const body = await c.req.json()
    const { botToken } = body

    if (!botToken || typeof botToken !== 'string') {
      return c.json({ error: 'botToken is required' }, 400)
    }

    const result = await configureTelegram(botToken)
    log.messaging.info('Telegram configured via API')
    return c.json(result)
  } catch (err) {
    log.messaging.error('Failed to configure Telegram', { error: String(err) })
    return c.json({ error: String(err) }, 500)
  }
})

// POST /api/messaging/telegram/enable - Enable Telegram using existing credentials
app.post('/telegram/enable', async (c) => {
  try {
    const result = await enableTelegram()
    if (result.error) {
      return c.json({ error: result.error }, 400)
    }
    log.messaging.info('Telegram enabled via API')
    return c.json(result)
  } catch (err) {
    log.messaging.error('Failed to enable Telegram', { error: String(err) })
    return c.json({ error: String(err) }, 500)
  }
})

// POST /api/messaging/telegram/disable - Disable Telegram integration
app.post('/telegram/disable', async (c) => {
  try {
    const result = await disableTelegram()
    log.messaging.info('Telegram disabled via API')
    return c.json(result)
  } catch (err) {
    log.messaging.error('Failed to disable Telegram', { error: String(err) })
    return c.json({ error: String(err) }, 500)
  }
})

// POST /api/messaging/telegram/disconnect - Disconnect and clear credentials
app.post('/telegram/disconnect', async (c) => {
  try {
    const result = await disconnectTelegram()
    log.messaging.info('Telegram disconnected via API')
    return c.json(result)
  } catch (err) {
    log.messaging.error('Failed to disconnect Telegram', { error: String(err) })
    return c.json({ error: String(err) }, 500)
  }
})

// GET /api/messaging/telegram/sessions - List Telegram session mappings
app.get('/telegram/sessions', (c) => {
  const status = getTelegramStatus()
  if (!status.enabled) {
    return c.json({ sessions: [] })
  }

  const mappings = listSessionMappings(TELEGRAM_CONNECTION_ID)
  return c.json({ sessions: mappings })
})

// ==================== Slack Routes ====================

// GET /api/messaging/slack - Get Slack connection status
app.get('/slack', (c) => {
  const status = getSlackStatus()
  const config = getSlackConfig()
  return c.json({
    ...status,
    config,
  })
})

// POST /api/messaging/slack/configure - Configure and enable Slack with tokens
app.post('/slack/configure', async (c) => {
  try {
    const body = await c.req.json()
    const { botToken, appToken } = body

    if (!botToken || typeof botToken !== 'string') {
      return c.json({ error: 'botToken is required' }, 400)
    }

    if (!appToken || typeof appToken !== 'string') {
      return c.json({ error: 'appToken is required for Socket Mode' }, 400)
    }

    const result = await configureSlack(botToken, appToken)
    log.messaging.info('Slack configured via API')
    return c.json(result)
  } catch (err) {
    log.messaging.error('Failed to configure Slack', { error: String(err) })
    return c.json({ error: String(err) }, 500)
  }
})

// POST /api/messaging/slack/enable - Enable Slack using existing credentials
app.post('/slack/enable', async (c) => {
  try {
    const result = await enableSlack()
    if (result.error) {
      return c.json({ error: result.error }, 400)
    }
    log.messaging.info('Slack enabled via API')
    return c.json(result)
  } catch (err) {
    log.messaging.error('Failed to enable Slack', { error: String(err) })
    return c.json({ error: String(err) }, 500)
  }
})

// POST /api/messaging/slack/disable - Disable Slack integration
app.post('/slack/disable', async (c) => {
  try {
    const result = await disableSlack()
    log.messaging.info('Slack disabled via API')
    return c.json(result)
  } catch (err) {
    log.messaging.error('Failed to disable Slack', { error: String(err) })
    return c.json({ error: String(err) }, 500)
  }
})

// POST /api/messaging/slack/disconnect - Disconnect and clear credentials
app.post('/slack/disconnect', async (c) => {
  try {
    const result = await disconnectSlack()
    log.messaging.info('Slack disconnected via API')
    return c.json(result)
  } catch (err) {
    log.messaging.error('Failed to disconnect Slack', { error: String(err) })
    return c.json({ error: String(err) }, 500)
  }
})

// GET /api/messaging/slack/sessions - List Slack session mappings
app.get('/slack/sessions', (c) => {
  const status = getSlackStatus()
  if (!status.enabled) {
    return c.json({ sessions: [] })
  }

  const mappings = listSessionMappings(SLACK_CONNECTION_ID)
  return c.json({ sessions: mappings })
})

// ==================== Mattermost Routes ====================

app.get('/mattermost', (c) => {
  const status = getMattermostStatus()
  const config = getMattermostConfig()
  return c.json({ ...status, config })
})

app.post('/mattermost/configure', async (c) => {
  try {
    const body = await c.req.json()
    const { serverUrl, botToken, teamId, channelId } = body

    if (!serverUrl || typeof serverUrl !== 'string') return c.json({ error: 'serverUrl is required' }, 400)
    if (!botToken || typeof botToken !== 'string') return c.json({ error: 'botToken is required' }, 400)

    const result = await configureMattermost(
      serverUrl,
      botToken,
      typeof teamId === 'string' ? teamId : '',
      typeof channelId === 'string' ? channelId : '',
    )
    log.messaging.info('Mattermost configured via API')
    return c.json(result)
  } catch (err) {
    log.messaging.error('Failed to configure Mattermost', { error: String(err) })
    return c.json({ error: String(err) }, 500)
  }
})

app.post('/mattermost/enable', async (c) => {
  try {
    const result = await enableMattermost()
    if (result.error) return c.json({ error: result.error }, 400)
    log.messaging.info('Mattermost enabled via API')
    return c.json(result)
  } catch (err) {
    log.messaging.error('Failed to enable Mattermost', { error: String(err) })
    return c.json({ error: String(err) }, 500)
  }
})

app.post('/mattermost/disable', async (c) => {
  try {
    const result = await disableMattermost()
    log.messaging.info('Mattermost disabled via API')
    return c.json(result)
  } catch (err) {
    log.messaging.error('Failed to disable Mattermost', { error: String(err) })
    return c.json({ error: String(err) }, 500)
  }
})

app.post('/mattermost/disconnect', async (c) => {
  try {
    const result = await disconnectMattermost()
    log.messaging.info('Mattermost disconnected via API')
    return c.json(result)
  } catch (err) {
    log.messaging.error('Failed to disconnect Mattermost', { error: String(err) })
    return c.json({ error: String(err) }, 500)
  }
})

app.get('/mattermost/sessions', (c) => {
  const status = getMattermostStatus()
  if (!status.enabled) return c.json({ sessions: [] })

  const mappings = listSessionMappings(MATTERMOST_CONNECTION_ID)
  return c.json({ sessions: mappings })
})

// ==================== Email Routes ====================

// GET /api/messaging/email - Get email connection status
app.get('/email', (c) => {
  const status = getEmailStatus()
  const config = getEmailConfig()
  return c.json({
    ...status,
    config,
  })
})

// POST /api/messaging/email/configure - Configure and enable email
app.post('/email/configure', async (c) => {
  try {
    const body = await c.req.json<EmailAuthState>()

    // Validate required fields
    if (!body.imap?.host || !body.imap?.user || !body.imap?.password) {
      return c.json({ error: 'Missing IMAP configuration' }, 400)
    }

    const conn = await configureEmail(body)
    log.messaging.info('Email configured via API')
    return c.json(conn)
  } catch (err) {
    log.messaging.error('Failed to configure email', { error: String(err) })
    return c.json({ error: String(err) }, 500)
  }
})

// POST /api/messaging/email/test - Test email credentials without saving
app.post('/email/test', async (c) => {
  try {
    const body = await c.req.json<EmailAuthState>()

    // Validate required fields
    if (!body.imap?.host || !body.imap?.user || !body.imap?.password) {
      return c.json({ error: 'Missing IMAP configuration' }, 400)
    }

    const result = await testEmailCredentials(body)
    return c.json(result)
  } catch (err) {
    log.messaging.error('Failed to test email credentials', { error: String(err) })
    return c.json({ error: String(err) }, 500)
  }
})

// POST /api/messaging/email/enable - Enable email using existing credentials
app.post('/email/enable', async (c) => {
  try {
    const result = await enableEmail()
    if (result.error) {
      return c.json({ error: result.error }, 400)
    }
    log.messaging.info('Email enabled via API')
    return c.json(result)
  } catch (err) {
    log.messaging.error('Failed to enable email', { error: String(err) })
    return c.json({ error: String(err) }, 500)
  }
})

// POST /api/messaging/email/disable - Disable email
app.post('/email/disable', async (c) => {
  try {
    const conn = await disableEmail()
    log.messaging.info('Email disabled via API')
    return c.json(conn)
  } catch (err) {
    log.messaging.error('Failed to disable email', { error: String(err) })
    return c.json({ error: String(err) }, 500)
  }
})

// GET /api/messaging/email/sessions - List email session mappings
app.get('/email/sessions', (c) => {
  const status = getEmailStatus()
  if (!status.enabled) {
    return c.json({ sessions: [] })
  }

  // Email sessions are tracked by the constant 'email-channel' ID
  const mappings = listSessionMappings('email-channel')
  return c.json({ sessions: mappings })
})

// GET /api/messaging/email/emails - List stored emails
app.get('/email/emails', (c) => {
  try {
    const limit = parseInt(c.req.query('limit') || '50')
    const offset = parseInt(c.req.query('offset') || '0')
    const direction = c.req.query('direction') as 'incoming' | 'outgoing' | undefined
    const threadId = c.req.query('threadId')
    const search = c.req.query('search')
    const folder = c.req.query('folder')

    const result = getStoredEmails({
      limit,
      offset,
      direction,
      threadId: threadId || undefined,
      search: search || undefined,
      folder: folder || undefined,
    })

    return c.json({ emails: result, count: result.length })
  } catch (err) {
    log.messaging.error('Failed to list emails', { error: String(err) })
    return c.json({ error: String(err) }, 500)
  }
})

// GET /api/messaging/email/emails/:id - Get a specific email
app.get('/email/emails/:id', (c) => {
  try {
    const id = c.req.param('id')
    const email = getStoredEmailById(id)

    if (!email) {
      return c.json({ error: 'Email not found' }, 404)
    }

    return c.json(email)
  } catch (err) {
    log.messaging.error('Failed to get email', { error: String(err) })
    return c.json({ error: String(err) }, 500)
  }
})

// POST /api/messaging/email/search - Search emails via IMAP
app.post('/email/search', async (c) => {
  try {
    const body = await c.req.json<{
      subject?: string
      from?: string
      to?: string
      since?: string
      before?: string
      text?: string
      seen?: boolean
      flagged?: boolean
      fetchLimit?: number
    }>()

    // Search IMAP
    const uids = await searchImapEmails({
      subject: body.subject,
      from: body.from,
      to: body.to,
      since: body.since ? new Date(body.since) : undefined,
      before: body.before ? new Date(body.before) : undefined,
      text: body.text,
      seen: body.seen,
      flagged: body.flagged,
    })

    // Optionally fetch and store the results
    let fetchedEmails: StoredEmail[] = []
    if (uids.length > 0 && body.fetchLimit !== 0) {
      fetchedEmails = await fetchAndStoreEmails(uids, { limit: body.fetchLimit || 20 })
    }

    return c.json({
      matchingUids: uids,
      matchCount: uids.length,
      fetched: fetchedEmails.length,
      emails: fetchedEmails,
    })
  } catch (err) {
    log.messaging.error('Failed to search emails', { error: String(err) })
    return c.json({ error: String(err) }, 500)
  }
})

// POST /api/messaging/email/fetch - Fetch specific emails by UID
app.post('/email/fetch', async (c) => {
  try {
    const body = await c.req.json<{
      uids: number[]
      limit?: number
    }>()

    if (!body.uids || body.uids.length === 0) {
      return c.json({ error: 'No UIDs provided' }, 400)
    }

    const fetchedEmails = await fetchAndStoreEmails(body.uids, { limit: body.limit })

    return c.json({
      fetched: fetchedEmails.length,
      emails: fetchedEmails,
    })
  } catch (err) {
    log.messaging.error('Failed to fetch emails', { error: String(err) })
    return c.json({ error: String(err) }, 500)
  }
})

// GET /api/messaging/messages/:id - Get a specific channel message
app.get('/messages/:id', (c) => {
  try {
    const id = c.req.param('id')
    const message = getChannelMessageById(id)

    if (!message) {
      return c.json({ error: 'Message not found' }, 404)
    }

    return c.json(message)
  } catch (err) {
    log.messaging.error('Failed to get message', { error: String(err) })
    return c.json({ error: String(err) }, 500)
  }
})

// POST /api/messaging/send - Send a message to a channel
app.post('/send', async (c) => {
  try {
    const body = await c.req.json<{
      channel: 'email' | 'whatsapp' | 'discord' | 'telegram' | 'slack' | 'mattermost'
      body: string
      subject?: string
      replyToMessageId?: string
      slackBlocks?: Array<Record<string, unknown>>
      filePath?: string
    }>()

    if (!body.channel || !body.body) {
      return c.json({ error: 'Missing required fields: channel, body' }, 400)
    }

    const result = await sendMessageToChannel(
      body.channel,
      body.body,
      {
        subject: body.subject,
        replyToMessageId: body.replyToMessageId,
        slackBlocks: body.slackBlocks,
        filePath: body.filePath,
      }
    )

    if (result.success) {
      log.messaging.info('Message sent via API', {
        channel: body.channel,
        messageId: result.messageId,
      })
      return c.json(result)
    } else {
      log.messaging.warn('Failed to send message via API', {
        channel: body.channel,
        error: result.error,
      })
      return c.json(result, 400)
    }
  } catch (err) {
    log.messaging.error('Error sending message', { error: String(err) })
    return c.json({ success: false, error: String(err) }, 500)
  }
})

export default app
