import type { Client as ClientType } from 'ssh2'
import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { log } from '../lib/logger'

// Lazy-load ssh2 to avoid native module crash in test environments (Bun + libuv)
let _Client: typeof ClientType | null = null
function getSSH2Client(): typeof ClientType {
  if (!_Client) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _Client = require('ssh2').Client
  }
  return _Client!
}

export interface SSHConnectionConfig {
  host: string
  port: number
  username: string
  authMethod: 'key' | 'password'
  privateKeyPath?: string
  password?: string
  hostFingerprint?: string
  onFirstConnect?: (fingerprint: string) => void
}

interface PooledConnection {
  client: ClientType
  hostKey: string
  createdAt: number
  lastUsedAt: number
  inUse: boolean
}

const MAX_PER_HOST = 3
const IDLE_TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000 // 1 minute
const CONNECT_TIMEOUT_MS = 30 * 1000 // 30 seconds

function makeHostKey(config: SSHConnectionConfig): string {
  return `${config.username}@${config.host}:${config.port}`
}

function isHealthy(conn: PooledConnection): boolean {
  // NOTE: Uses ssh2 internal API. If ssh2 changes internals, this will
  // fall through to the catch and return false (safe default).
  try {
    const sock = (conn.client as unknown as { _sock?: { destroyed?: boolean; writable?: boolean } })._sock
    if (!sock) return false
    return !sock.destroyed && !!sock.writable
  } catch {
    return false
  }
}

export class SSHConnectionManager {
  private pool = new Map<string, PooledConnection[]>()
  private cleanupInterval: ReturnType<typeof setInterval>

  constructor() {
    this.cleanupInterval = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS)
  }

  async getConnection(config: SSHConnectionConfig): Promise<ClientType> {
    const hostKey = makeHostKey(config)
    const pooled = this.pool.get(hostKey)

    // Try to reuse an idle healthy connection
    if (pooled) {
      for (const conn of pooled) {
        if (!conn.inUse && isHealthy(conn)) {
          conn.inUse = true
          conn.lastUsedAt = Date.now()
          log.pty.debug('Reusing pooled SSH connection', { hostKey })
          return conn.client
        }
      }
      // Remove unhealthy idle connections
      const healthy = pooled.filter((c) => c.inUse || isHealthy(c))
      if (healthy.length !== pooled.length) {
        const removed = pooled.length - healthy.length
        log.pty.debug('Cleaned unhealthy connections', { hostKey, removed })
      }
      this.pool.set(hostKey, healthy)

      // Check pool limit
      if (healthy.length >= MAX_PER_HOST) {
        throw new Error(`SSH connection pool exhausted for ${hostKey} (max ${MAX_PER_HOST})`)
      }
    }

    // Create new connection
    const client = await this.createConnection(config)
    const entry: PooledConnection = {
      client,
      hostKey,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      inUse: true,
    }

    if (!this.pool.has(hostKey)) {
      this.pool.set(hostKey, [])
    }
    this.pool.get(hostKey)!.push(entry)

    log.pty.info('Created new SSH connection', { hostKey, poolSize: this.pool.get(hostKey)!.length })
    return client
  }

  releaseConnection(config: SSHConnectionConfig, client: ClientType): void {
    const hostKey = makeHostKey(config)
    const pooled = this.pool.get(hostKey)
    if (!pooled) return

    for (const conn of pooled) {
      if (conn.client === client) {
        conn.inUse = false
        conn.lastUsedAt = Date.now()
        log.pty.debug('Released SSH connection', { hostKey })
        return
      }
    }
  }

  async testConnection(config: SSHConnectionConfig): Promise<{ success: boolean; error?: string; latencyMs?: number }> {
    const start = Date.now()
    try {
      const client = await this.createConnection(config)
      const latencyMs = Date.now() - start
      client.end()
      return { success: true, latencyMs }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async execCommand(config: SSHConnectionConfig, command: string, timeoutMs = 60000): Promise<string> {
    // Use a temporary connection (not from pool) to avoid blocking
    // when all pool slots are occupied by terminal streams
    const client = await this.createConnection(config)
    try {
      return await new Promise<string>((resolve, reject) => {
        const execTimeout = setTimeout(() => {
          reject(new Error(`SSH command timed out after ${timeoutMs}ms`))
        }, timeoutMs)

        client.exec(command, (err, stream) => {
          if (err) {
            clearTimeout(execTimeout)
            reject(err)
            return
          }
          let stdout = ''
          let stderr = ''
          stream.on('data', (data: Buffer) => {
            stdout += data.toString()
          })
          stream.stderr.on('data', (data: Buffer) => {
            stderr += data.toString()
          })
          stream.on('close', (code: number) => {
            clearTimeout(execTimeout)
            if (code !== 0) {
              reject(new Error(`Command exited with code ${code}: ${stderr || stdout}`))
            } else {
              resolve(stdout)
            }
          })
        })
      })
    } finally {
      client.end()
    }
  }

  private createConnection(config: SSHConnectionConfig): Promise<ClientType> {
    return new Promise<ClientType>((resolve, reject) => {
      const Client = getSSH2Client()
      const client = new Client()
      const timeout = setTimeout(() => {
        client.end()
        reject(new Error(`SSH connection timeout after ${CONNECT_TIMEOUT_MS}ms`))
      }, CONNECT_TIMEOUT_MS)

      client.on('ready', () => {
        clearTimeout(timeout)
        log.pty.info('SSH connection established', { host: config.host, port: config.port })
        resolve(client)
      })

      client.on('error', (err) => {
        clearTimeout(timeout)
        log.pty.error('SSH connection error', { host: config.host, error: String(err) })
        reject(err)
      })

      const connectConfig: Parameters<Client['connect']>[0] = {
        host: config.host,
        port: config.port,
        username: config.username,
        keepaliveInterval: 30000,
        keepaliveCountMax: 3,
      }

      // TOFU host key verification
      connectConfig.hostVerifier = (key: Buffer) => {
        const fingerprint = createHash('sha256').update(key).digest('base64')
        if (config.hostFingerprint) {
          if (fingerprint !== config.hostFingerprint) {
            log.pty.error('SSH host key mismatch! Possible MITM attack', {
              host: config.host,
              expected: config.hostFingerprint,
              got: fingerprint,
            })
            return false
          }
          return true
        }
        // First connection (TOFU) - accept and log
        log.pty.info('SSH host key fingerprint (TOFU)', { host: config.host, fingerprint })
        // Store fingerprint via callback if provided
        config.onFirstConnect?.(fingerprint)
        return true
      }

      if (config.authMethod === 'key' && config.privateKeyPath) {
        try {
          connectConfig.privateKey = readFileSync(config.privateKeyPath)
        } catch {
          clearTimeout(timeout)
          reject(new Error(`Failed to read private key at: ${config.privateKeyPath}`))
          return
        }
      } else if (config.authMethod === 'password' && config.password) {
        connectConfig.password = config.password
      } else {
        clearTimeout(timeout)
        reject(new Error(`Invalid SSH auth config: method=${config.authMethod}`))
        return
      }

      client.connect(connectConfig)
    })
  }

  private cleanup(): void {
    const now = Date.now()
    for (const [hostKey, connections] of this.pool.entries()) {
      const remaining = connections.filter((conn) => {
        if (conn.inUse) return true
        if (!isHealthy(conn) || now - conn.lastUsedAt > IDLE_TIMEOUT_MS) {
          log.pty.debug('Cleaning up idle/unhealthy SSH connection', { hostKey })
          conn.client.end()
          return false
        }
        return true
      })
      if (remaining.length === 0) {
        this.pool.delete(hostKey)
      } else {
        this.pool.set(hostKey, remaining)
      }
    }
  }

  destroyAll(): void {
    clearInterval(this.cleanupInterval)
    for (const [hostKey, connections] of this.pool.entries()) {
      for (const conn of connections) {
        try {
          conn.client.end()
        } catch {
          // ignore
        }
      }
      log.pty.info('Destroyed SSH connections', { hostKey, count: connections.length })
    }
    this.pool.clear()
  }

  // Drop every pooled connection whose makeHostKey matches `<username>@<host>:<port>`.
  // Use after the operator deliberately invalidates a host's TOFU fingerprint —
  // existing sessions stay attached to a server we no longer trust until we
  // close them, so reset must hang up first.
  destroyForHost(config: { host: string; port: number; username: string }): number {
    const hostKey = `${config.username}@${config.host}:${config.port}`
    const connections = this.pool.get(hostKey)
    if (!connections || connections.length === 0) return 0
    const count = connections.length
    for (const conn of connections) {
      try { conn.client.end() } catch { /* ignore */ }
    }
    this.pool.delete(hostKey)
    log.pty.info('Destroyed SSH connections (TOFU reset)', { hostKey, count })
    return count
  }
}

// Singleton
let sshManager: SSHConnectionManager | null = null

export function getSSHConnectionManager(): SSHConnectionManager {
  if (!sshManager) {
    sshManager = new SSHConnectionManager()
  }
  return sshManager
}

export function resetSSHConnectionManager(): void {
  if (sshManager) {
    sshManager.destroyAll()
    sshManager = null
  }
  _Client = null
}
