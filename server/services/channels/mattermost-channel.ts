import { eq } from 'drizzle-orm'
import { db, messagingConnections } from '../../db'
import { log } from '../../lib/logger'
import { getSettings } from '../../lib/settings'
import type { ChannelEvents, ConnectionStatus, IncomingMessage, MessagingChannel } from './types'

type MattermostWebSocketEvent =
  | { event: 'hello'; data?: Record<string, unknown> }
  | { event: 'posted'; data: { post?: string; channel_type?: string; sender_name?: string }; broadcast?: { user_id?: string; channel_id?: string } }
  | { event: string; data?: Record<string, unknown>; broadcast?: Record<string, unknown> }

interface MattermostPostEvent {
  id: string
  user_id: string
  channel_id: string
  message: string
  create_at?: number
  type?: string
  props?: Record<string, unknown>
}

interface MattermostUser {
  id: string
  username: string
}

export class MattermostChannel implements MessagingChannel {
  readonly type = 'mattermost' as const
  readonly connectionId: string

  private events: ChannelEvents | null = null
  private status: ConnectionStatus = 'disconnected'
  private ws: WebSocket | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private isShuttingDown = false
  private botUserId: string | null = null

  constructor(connectionId: string) {
    this.connectionId = connectionId
  }

  async initialize(events: ChannelEvents): Promise<void> {
    this.events = events
    this.isShuttingDown = false

    const config = getSettings().channels.mattermost
    if (!config.serverUrl || !config.botToken) {
      log.messaging.warn('Mattermost channel missing credentials', { connectionId: this.connectionId })
      this.updateStatus('disconnected')
      return
    }

    await this.connect()
  }

  private async connect(): Promise<void> {
    if (this.isShuttingDown) return

    const config = getSettings().channels.mattermost
    try {
      this.updateStatus('connecting')
      const me = await this.fetchCurrentUser()
      this.botUserId = me.id
      const displayName = `@${me.username}`
      db.update(messagingConnections)
        .set({ displayName, updatedAt: new Date().toISOString() })
        .where(eq(messagingConnections.id, this.connectionId))
        .run()
      this.events?.onDisplayNameChange?.(displayName)

      const wsUrl = toWebSocketUrl(config.serverUrl)
      this.ws = new WebSocket(wsUrl)
      this.ws.addEventListener('open', () => {
        this.ws?.send(JSON.stringify({ seq: 1, action: 'authentication_challenge', data: { token: config.botToken } }))
        this.updateStatus('connected')
      })
      this.ws.addEventListener('message', (event) => void this.handleSocketMessage(event.data))
      this.ws.addEventListener('close', () => this.handleDisconnect())
      this.ws.addEventListener('error', (event) => {
        log.messaging.error('Mattermost WebSocket error', { connectionId: this.connectionId, error: String(event) })
        this.handleDisconnect()
      })
    } catch (err) {
      log.messaging.error('Mattermost connect error', { connectionId: this.connectionId, error: String(err) })
      this.updateStatus('disconnected')
      this.scheduleReconnect()
    }
  }

  private async handleSocketMessage(data: unknown): Promise<void> {
    const text = typeof data === 'string' ? data : data instanceof Buffer ? data.toString('utf8') : ''
    if (!text) return

    let event: MattermostWebSocketEvent
    try {
      event = JSON.parse(text) as MattermostWebSocketEvent
    } catch {
      return
    }

    if (event.event !== 'posted') return
    if (event.data.channel_type !== 'D') return
    if (!event.data.post) return

    const post = JSON.parse(event.data.post) as MattermostPostEvent
    if (!post.message.trim()) return
    if (post.user_id === this.botUserId) return
    if (post.type === 'system_add_to_channel') return

    const incomingMessage: IncomingMessage = {
      channelType: 'mattermost',
      connectionId: this.connectionId,
      senderId: post.user_id,
      senderName: event.data.sender_name,
      content: post.message,
      timestamp: new Date(post.create_at ?? Date.now()),
      metadata: { channelId: post.channel_id, postId: post.id },
    }

    try {
      await this.events?.onMessage(incomingMessage)
    } catch (err) {
      log.messaging.error('Error processing Mattermost message', { connectionId: this.connectionId, error: String(err) })
    }
  }

  async shutdown(): Promise<void> {
    this.isShuttingDown = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.ws?.close()
    this.ws = null
    this.updateStatus('disconnected')
  }

  async sendMessage(recipientId: string, content: string, metadata?: Record<string, unknown>): Promise<boolean> {
    const config = getSettings().channels.mattermost
    const channelId = typeof metadata?.channelId === 'string' ? metadata.channelId : await this.getDirectChannelId(recipientId)

    try {
      const res = await fetch(`${config.serverUrl}/api/v4/posts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.botToken}` },
        body: JSON.stringify({ channel_id: channelId, message: content }),
      })
      if (!res.ok) throw new Error(`Mattermost post failed: ${res.status} ${await res.text()}`)
      return true
    } catch (err) {
      log.messaging.error('Failed to send Mattermost message', { connectionId: this.connectionId, to: recipientId, error: String(err) })
      return false
    }
  }

  getStatus(): ConnectionStatus {
    return this.status
  }

  private async fetchCurrentUser(): Promise<MattermostUser> {
    const config = getSettings().channels.mattermost
    const res = await fetch(`${config.serverUrl}/api/v4/users/me`, {
      headers: { 'Authorization': `Bearer ${config.botToken}` },
    })
    if (!res.ok) throw new Error(`Mattermost auth failed: ${res.status} ${await res.text()}`)
    return res.json()
  }

  private async getDirectChannelId(userId: string): Promise<string> {
    if (!this.botUserId) {
      this.botUserId = (await this.fetchCurrentUser()).id
    }
    const config = getSettings().channels.mattermost
    const res = await fetch(`${config.serverUrl}/api/v4/channels/direct`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.botToken}` },
      body: JSON.stringify([userId, this.botUserId]),
    })
    if (!res.ok) throw new Error(`Mattermost DM lookup failed: ${res.status} ${await res.text()}`)
    const dm = await res.json() as { id: string }
    return dm.id
  }

  private handleDisconnect(): void {
    this.ws = null
    this.updateStatus('disconnected')
    if (!this.isShuttingDown) this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.isShuttingDown) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, 5000)
  }

  private updateStatus(status: ConnectionStatus): void {
    if (this.status === status) return
    this.status = status
    this.events?.onConnectionChange(status)
  }
}

function toWebSocketUrl(serverUrl: string): string {
  const url = new URL('/api/v4/websocket', serverUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}
