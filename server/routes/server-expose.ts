import { Hono } from 'hono'
import * as childProcess from 'node:child_process'
import os from 'node:os'
import { getSettings, updateSettingByPath } from '../lib/settings'
import { log } from '../lib/logger'
import {
  createTunnel,
  configureTunnelIngress,
  createTunnelCname,
  deleteTunnel,
  isTunnelAvailable,
  listTunnels,
} from '../services/cloudflare-tunnel'

const app = new Hono()

interface TailscaleStatus {
  Self?: { DNSName?: string; HostName?: string; TailscaleIPs?: string[] }
  MagicDNSSuffix?: string
}

function readTailscaleStatus(): TailscaleStatus | null {
  try {
    const raw = childProcess.execSync('tailscale status --json', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 5000,
    })
    return JSON.parse(raw) as TailscaleStatus
  } catch {
    return null
  }
}

/** Best-effort Tailscale hostname detection. Returns null if Tailscale is not available. */
function detectTailscaleHostname(): string | null {
  const status = readTailscaleStatus()
  if (!status) return null
  const dnsName = status.Self?.DNSName
  if (dnsName) return dnsName.replace(/\.$/, '')
  if (status.Self?.HostName && status.MagicDNSSuffix) {
    return `${status.Self.HostName}.${status.MagicDNSSuffix}`
  }
  return null
}

function getTailscaleIpv4(status: TailscaleStatus): string | null {
  return status.Self?.TailscaleIPs?.find((ip) => !ip.includes(':')) ?? null
}

/** Best-effort Tailscale IPv4 detection. Returns null if Tailscale is not available. */
function detectTailscaleIp(): string | null {
  const status = readTailscaleStatus()
  if (!status) return null
  return getTailscaleIpv4(status)
}

/** GET /api/server/expose — current state */
app.get('/', async (c) => {
  const settings = getSettings()
  const publicDomain = settings.server.publicDomain
  const tailscaleHostname = settings.server.tailscaleHostname

  let tunnelId: string | null = null
  let tunnelStatus: string | null = null
  if (publicDomain && isTunnelAvailable()) {
    const tunnelName = `fulcrum-server-${publicDomain.replace(/[^a-z0-9]+/gi, '-')}`
    const result = await listTunnels()
    if (result.success && result.tunnels) {
      const match = result.tunnels.find((t) => t.name === tunnelName)
      if (match) {
        tunnelId = match.id
        tunnelStatus = match.status
      }
    }
  }

  return c.json({
    publicDomain,
    tailscaleHostname,
    detectedTailscaleHostname: detectTailscaleHostname(),
    tunnelAvailable: isTunnelAvailable(),
    tunnelId,
    tunnelStatus,
  })
})

/**
 * POST /api/server/expose — create/update the tunnel that fronts this Fulcrum
 * instance. Body: { subdomain: string, domain: string }
 *
 * Returns the tunnel token plus next-step instructions for the CLI to install
 * cloudflared as a system service.
 */
app.post('/', async (c) => {
  const settings = getSettings()
  if (!isTunnelAvailable()) {
    return c.json(
      {
        error:
          'Cloudflare API token and account ID must be configured first. Set them via `fulcrum config set integrations.cloudflareApiToken <token>` and `fulcrum config set integrations.cloudflareAccountId <id>`.',
      },
      400,
    )
  }

  let body: { subdomain?: string; domain?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const subdomain = body.subdomain?.trim() || os.hostname().split('.')[0]
  const domain = body.domain?.trim()
  if (!domain) {
    return c.json({ error: '`domain` is required (e.g. "fulcrum.example.com")' }, 400)
  }

  const publicDomain = `${subdomain}.${domain}`
  const tunnelName = `fulcrum-server-${publicDomain.replace(/[^a-z0-9]+/gi, '-')}`

  // Reuse existing tunnel if one with the same name already exists.
  let tunnelId: string
  let tunnelToken: string | null = null
  const listResult = await listTunnels()
  const existing = listResult.success
    ? listResult.tunnels?.find((t) => t.name === tunnelName)
    : undefined

  if (existing) {
    tunnelId = existing.id
    log.deploy.info('Reusing existing fulcrum-server tunnel', { tunnelId, tunnelName })
  } else {
    const created = await createTunnel(tunnelName)
    if (!created.success || !created.tunnel) {
      return c.json({ error: created.error ?? 'Failed to create tunnel' }, 500)
    }
    tunnelId = created.tunnel.tunnelId
    tunnelToken = created.tunnel.tunnelToken
  }

  const port = settings.server.port
  const ingressResult = await configureTunnelIngress(tunnelId, [
    {
      hostname: publicDomain,
      service: `http://localhost:${port}`,
    },
  ])
  if (!ingressResult.success) {
    return c.json({ error: ingressResult.error ?? 'Failed to configure tunnel ingress' }, 500)
  }

  const cnameResult = await createTunnelCname(subdomain, domain, tunnelId)
  if (!cnameResult.success) {
    return c.json({ error: cnameResult.error ?? 'Failed to create CNAME record' }, 500)
  }

  // Persist public domain. Tailscale hostname auto-detected unless the user
  // already set one (don't overwrite a manual entry).
  updateSettingByPath('server.publicDomain', publicDomain)
  if (!settings.server.tailscaleHostname) {
    const detected = detectTailscaleHostname()
    if (detected) updateSettingByPath('server.tailscaleHostname', detected)
  }

  // Tunnel token is only returned at create time. For an existing tunnel we
  // surface a placeholder so the CLI can warn that the user must keep their
  // existing service unit (or rotate the token via the CF dashboard).
  return c.json({
    success: true,
    publicDomain,
    tunnelId,
    tunnelName,
    tunnelToken,
    reusedExisting: !!existing,
    accessSetupUrl: `https://one.dash.cloudflare.com/?to=/:account/access/apps`,
  })
})

/**
 * DELETE /api/server/expose — clear publicDomain and (optionally) delete the
 * tunnel from Cloudflare.
 */
app.delete('/', async (c) => {
  const settings = getSettings()
  const publicDomain = settings.server.publicDomain
  if (!publicDomain) {
    return c.json({ success: true, message: 'No public domain configured' })
  }

  const url = new URL(c.req.url)
  const removeTunnel = url.searchParams.get('removeTunnel') === 'true'

  let tunnelDeleted = false
  if (removeTunnel && isTunnelAvailable()) {
    const tunnelName = `fulcrum-server-${publicDomain.replace(/[^a-z0-9]+/gi, '-')}`
    const result = await listTunnels()
    if (result.success && result.tunnels) {
      const match = result.tunnels.find((t) => t.name === tunnelName)
      if (match) {
        const del = await deleteTunnel(match.id)
        tunnelDeleted = del.success
      }
    }
  }

  updateSettingByPath('server.publicDomain', null)
  return c.json({ success: true, tunnelDeleted })
})

export default app

// Re-export for tests
export { detectTailscaleHostname, detectTailscaleIp, getTailscaleIpv4 }
