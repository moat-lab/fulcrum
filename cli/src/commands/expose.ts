import { defineCommand } from 'citty'
import { execSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, chmodSync, unlinkSync } from 'node:fs'
import { homedir, hostname, platform } from 'node:os'
import { dirname, join } from 'node:path'
import { FulcrumClient } from '../client'
import { CliError, ExitCodes } from '../utils/errors'
import { output, isJsonOutput } from '../utils/output'
import { confirm } from '../utils/prompt'
import { globalArgs, toFlags, setupJsonOutput } from './shared'

// Templates are inlined as strings so the bundled single-file CLI stays
// self-contained. The source files in cli/src/templates/ remain the editable
// canonical version — keep this in sync.

const SYSTEMD_SERVICE_TEMPLATE = `[Unit]
Description=Fulcrum Cloudflare Tunnel
Documentation=https://github.com/knowsuchagency/fulcrum
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
ExecStart=/usr/bin/env cloudflared --no-autoupdate tunnel --token __TUNNEL_TOKEN__ run
Restart=on-failure
RestartSec=5s
TimeoutStopSec=20

[Install]
WantedBy=default.target
`

const LAUNCHD_PLIST_TEMPLATE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.fulcrum.tunnel</string>
    <key>ProgramArguments</key>
    <array>
        <string>__CLOUDFLARED_PATH__</string>
        <string>--no-autoupdate</string>
        <string>tunnel</string>
        <string>--token</string>
        <string>__TUNNEL_TOKEN__</string>
        <string>run</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardErrorPath</key>
    <string>__LOG_PATH__</string>
    <key>StandardOutPath</key>
    <string>__LOG_PATH__</string>
</dict>
</plist>
`

function isCloudflaredInstalled(): boolean {
  try {
    execSync('which cloudflared', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function whichCloudflared(): string {
  return execSync('which cloudflared', { encoding: 'utf-8' }).trim()
}

const LINUX_SERVICE_NAME = 'fulcrum-tunnel'
const MACOS_LABEL = 'com.fulcrum.tunnel'

function linuxUnitPath(): string {
  return join(homedir(), '.config', 'systemd', 'user', `${LINUX_SERVICE_NAME}.service`)
}

function macosPlistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${MACOS_LABEL}.plist`)
}

function macosLogPath(): string {
  return join(homedir(), 'Library', 'Logs', 'fulcrum-tunnel.log')
}

/** Install + start the cloudflared service for the given tunnel token. Returns the path written. */
function installService(tunnelToken: string): { path: string; how: 'systemd' | 'launchd' } {
  if (platform() === 'darwin') {
    const cloudflaredPath = whichCloudflared()
    const plist = LAUNCHD_PLIST_TEMPLATE
      .replace('__CLOUDFLARED_PATH__', cloudflaredPath)
      .replace('__TUNNEL_TOKEN__', tunnelToken)
      .replace(/__LOG_PATH__/g, macosLogPath())
    const dest = macosPlistPath()
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, plist, 'utf-8')
    chmodSync(dest, 0o644)
    // Reload: unload first to drop any stale registration
    spawnSync('launchctl', ['unload', dest], { stdio: 'ignore' })
    const load = spawnSync('launchctl', ['load', dest], { stdio: 'inherit' })
    if (load.status !== 0) {
      throw new CliError('LAUNCHCTL_LOAD_FAILED', 'launchctl load failed', ExitCodes.ERROR)
    }
    return { path: dest, how: 'launchd' }
  }

  // Linux: systemd user unit
  const unit = SYSTEMD_SERVICE_TEMPLATE.replace('__TUNNEL_TOKEN__', tunnelToken)
  const dest = linuxUnitPath()
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, unit, 'utf-8')
  chmodSync(dest, 0o644)

  for (const args of [
    ['--user', 'daemon-reload'],
    ['--user', 'enable', LINUX_SERVICE_NAME],
    ['--user', 'restart', LINUX_SERVICE_NAME],
  ]) {
    const r = spawnSync('systemctl', args, { stdio: 'inherit' })
    if (r.status !== 0) {
      throw new CliError(
        'SYSTEMCTL_FAILED',
        `systemctl ${args.join(' ')} failed (exit ${r.status})`,
        ExitCodes.ERROR,
      )
    }
  }
  return { path: dest, how: 'systemd' }
}

function uninstallService(): { stopped: boolean; removed: boolean } {
  if (platform() === 'darwin') {
    const dest = macosPlistPath()
    if (!existsSync(dest)) return { stopped: false, removed: false }
    spawnSync('launchctl', ['unload', dest], { stdio: 'ignore' })
    unlinkSync(dest)
    return { stopped: true, removed: true }
  }
  const dest = linuxUnitPath()
  if (!existsSync(dest)) return { stopped: false, removed: false }
  spawnSync('systemctl', ['--user', 'stop', LINUX_SERVICE_NAME], { stdio: 'ignore' })
  spawnSync('systemctl', ['--user', 'disable', LINUX_SERVICE_NAME], { stdio: 'ignore' })
  unlinkSync(dest)
  spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' })
  return { stopped: true, removed: true }
}

function serviceStatus(): string {
  if (platform() === 'darwin') {
    const r = spawnSync('launchctl', ['list', MACOS_LABEL], { encoding: 'utf-8' })
    if (r.status === 0) {
      const match = r.stdout.match(/"PID"\s*=\s*(\d+);/)
      return match ? `running (pid ${match[1]})` : 'loaded'
    }
    return 'not loaded'
  }
  const r = spawnSync('systemctl', ['--user', 'is-active', LINUX_SERVICE_NAME], { encoding: 'utf-8' })
  return (r.stdout || r.stderr).trim() || 'unknown'
}

async function handleExpose(args: { positional: string[]; flags: Record<string, string> }): Promise<void> {
  const { positional, flags } = args
  const subdomain = positional[0]?.trim() || hostname().split('.')[0]
  const domain = flags.domain?.trim()
  if (!domain) {
    throw new CliError(
      'MISSING_DOMAIN',
      'Required: --domain <zone> (e.g. --domain fulcrum.example.com)',
      ExitCodes.INVALID_ARGS,
    )
  }
  const skipService = flags['no-service'] === 'true'
  const autoYes = flags.yes === 'true' || flags.y === 'true'

  if (!skipService && !isCloudflaredInstalled()) {
    console.error('cloudflared is not installed.')
    console.error('Install it from https://github.com/cloudflare/cloudflared/releases or via your package manager.')
    if (!autoYes) {
      const proceed = await confirm('Continue without installing the system service? (the tunnel will be created but not running)')
      if (!proceed) throw new CliError('CLOUDFLARED_MISSING', 'cloudflared required to start tunnel', ExitCodes.ERROR)
    }
  }

  const client = new FulcrumClient(flags.url, flags.port)
  const result = await client.createServerExpose({ subdomain, domain })

  console.error(`Tunnel ready: ${result.publicDomain} (${result.reusedExisting ? 'reused' : 'created'})`)
  console.error(`Tunnel ID: ${result.tunnelId}`)

  let serviceInfo: { path: string; how: string } | null = null
  if (skipService) {
    console.error('Skipping system service installation (--no-service).')
  } else if (!result.tunnelToken) {
    console.error('Existing tunnel reused; the tunnel token was not returned by Cloudflare.')
    console.error('Keep the existing system service running, or rotate the token via the Cloudflare dashboard.')
  } else if (!isCloudflaredInstalled()) {
    console.error('Skipping service install: cloudflared not on PATH.')
  } else {
    const installed = installService(result.tunnelToken)
    serviceInfo = { path: installed.path, how: installed.how }
    console.error(`Installed and started ${installed.how} service: ${installed.path}`)
  }

  console.error('')
  console.error('Next steps:')
  console.error(`  1. Visit ${result.accessSetupUrl} and create a Cloudflare Access policy for *.${domain}.`)
  console.error(`  2. Open https://${result.publicDomain} in your browser.`)

  if (isJsonOutput()) {
    output({
      publicDomain: result.publicDomain,
      tunnelId: result.tunnelId,
      reusedExisting: result.reusedExisting,
      service: serviceInfo,
    })
  }
}

async function handleStatus(flags: Record<string, string>): Promise<void> {
  const client = new FulcrumClient(flags.url, flags.port)
  const status = await client.getServerExpose()
  const svc = serviceStatus()

  if (isJsonOutput()) {
    output({ ...status, serviceStatus: svc })
    return
  }
  console.log(`Public domain:        ${status.publicDomain ?? '(not set)'}`)
  console.log(`Tailscale hostname:   ${status.tailscaleHostname ?? '(not set)'}`)
  console.log(`Detected tailnet:     ${status.detectedTailscaleHostname ?? '(not detected)'}`)
  console.log(`Cloudflare ready:     ${status.tunnelAvailable ? 'yes' : 'no'}`)
  console.log(`Tunnel ID:            ${status.tunnelId ?? '(none)'}`)
  console.log(`Tunnel status:        ${status.tunnelStatus ?? '(unknown)'}`)
  console.log(`Local service:        ${svc}`)
}

async function handleDown(flags: Record<string, string>): Promise<void> {
  const removeTunnel = flags['remove-tunnel'] === 'true'
  const autoYes = flags.yes === 'true' || flags.y === 'true'

  if (removeTunnel && !autoYes) {
    const ok = await confirm('Permanently delete the Cloudflare Tunnel from your account?')
    if (!ok) {
      console.error('Aborted.')
      return
    }
  }

  const svc = uninstallService()
  if (svc.removed) {
    console.error('Stopped and removed the local cloudflared service.')
  }

  const client = new FulcrumClient(flags.url, flags.port)
  const result = await client.deleteServerExpose(removeTunnel)

  if (result.tunnelDeleted) console.error('Deleted the Cloudflare Tunnel from your account.')
  console.error('Cleared server.publicDomain.')

  if (isJsonOutput()) {
    output({ success: true, serviceRemoved: svc.removed, tunnelDeleted: !!result.tunnelDeleted })
  }
}

export const exposeCommand = defineCommand({
  meta: {
    name: 'expose',
    description: 'Expose this Fulcrum server publicly via a Cloudflare Tunnel',
  },
  args: {
    ...globalArgs,
    domain: { type: 'string' as const, description: 'Cloudflare zone for the public hostname (e.g. fulcrum.example.com)' },
    'no-service': { type: 'boolean' as const, description: 'Create the tunnel but do not install/start the system service' },
    'remove-tunnel': { type: 'boolean' as const, description: 'For `down`: also delete the tunnel from Cloudflare' },
    yes: { type: 'boolean' as const, alias: 'y', description: 'Auto-answer yes to prompts' },
  },
  subCommands: {
    status: defineCommand({
      meta: { name: 'status', description: 'Show current expose state and service status' },
      args: { ...globalArgs },
      async run({ args }) {
        setupJsonOutput(args)
        await handleStatus(toFlags(args))
      },
    }),
    down: defineCommand({
      meta: { name: 'down', description: 'Stop the local tunnel service and clear publicDomain' },
      args: {
        ...globalArgs,
        'remove-tunnel': { type: 'boolean' as const, description: 'Also delete the tunnel from Cloudflare' },
        yes: { type: 'boolean' as const, alias: 'y', description: 'Auto-answer yes to prompts' },
      },
      async run({ args }) {
        setupJsonOutput(args)
        await handleDown(toFlags(args))
      },
    }),
  },
  async run({ args, rawArgs }) {
    setupJsonOutput(args)
    // citty puts subcommand-route positionals in `_` but rawArgs preserves order
    const positional = (args._ as string[] | undefined) ?? rawArgs.filter((a) => !a.startsWith('-'))
    await handleExpose({ positional, flags: toFlags(args) })
  },
})
