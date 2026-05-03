import { defineCommand } from 'citty'
import { FulcrumClient, type CreateHostInput } from '../client'
import { output, isJsonOutput } from '../utils/output'
import { CliError, ExitCodes } from '../utils/errors'
import { confirm, prompt } from '../utils/prompt'
import { globalArgs, toFlags, setupJsonOutput } from './shared'
import type { Host, Task } from '@shared/types'

type HostAddFlags = Record<string, string | boolean | undefined>

function statusGlyph(status: Host['status']): string {
  if (status === 'connected') return '✓'
  if (status === 'error') return '✗'
  return '?'
}

function findHostByName(hosts: Host[], name: string): Host | undefined {
  return hosts.find((h) => h.name === name)
}

function hasStringFlag(flags: HostAddFlags, key: string): boolean {
  const value = flags[key]
  return typeof value === 'string' && value.trim().length > 0
}

async function readHostAddValue(
  flags: HostAddFlags,
  key: string,
  message: string,
  options: { required: true; defaultValue?: string; prompt?: boolean }
): Promise<string>
async function readHostAddValue(
  flags: HostAddFlags,
  key: string,
  message: string,
  options?: { required?: false; defaultValue?: string; prompt?: boolean }
): Promise<string | undefined>
async function readHostAddValue(
  flags: HostAddFlags,
  key: string,
  message: string,
  options?: { required?: boolean; defaultValue?: string; prompt?: boolean }
): Promise<string | undefined> {
  const flagValue = flags[key]
  const value = typeof flagValue === 'string' ? flagValue.trim() : ''
  if (value) return value
  if (isJsonOutput() || !options?.prompt) {
    if (options?.defaultValue) return options.defaultValue
    if (!options?.required) return undefined
    throw new CliError(
      `MISSING_${key.replace(/-/g, '_').toUpperCase()}`,
      `--${key} is required${isJsonOutput() ? ' when using --json' : ''}`,
      ExitCodes.INVALID_ARGS
    )
  }

  const answer = await prompt(message, options?.defaultValue)
  if (answer) return answer
  if (!options?.required) return undefined
  throw new CliError(
    `MISSING_${key.replace(/-/g, '_').toUpperCase()}`,
    `${message} is required`,
    ExitCodes.INVALID_ARGS
  )
}

export function activeTasksForHost(tasks: Task[], hostId: string): Task[] {
  return tasks.filter((task) =>
    task.hostId === hostId && task.status !== 'DONE' && task.status !== 'CANCELED'
  )
}

async function resolveHostByName(client: FulcrumClient, name: string): Promise<Host> {
  const hosts = await client.listHosts()
  const host = findHostByName(hosts, name)
  if (!host) {
    throw new CliError(
      'HOST_NOT_FOUND',
      `Host "${name}" not found. Run "fulcrum hosts list" to see configured hosts.`,
      ExitCodes.INVALID_ARGS
    )
  }
  return host
}

async function handleList(client: FulcrumClient) {
  const hosts = await client.listHosts()
  if (isJsonOutput()) {
    output(hosts)
    return
  }

  if (hosts.length === 0) {
    console.log('No remote hosts configured. Use "fulcrum hosts add <name>" to add one.')
    return
  }

  console.log('Remote Hosts')
  console.log('============')
  for (const host of hosts) {
    const target = `${host.username}@${host.hostname}:${host.port}`
    const dir = host.defaultDirectory ? `  dir=${host.defaultDirectory}` : ''
    const url = host.fulcrumUrl ? `  url=${host.fulcrumUrl}` : ''
    console.log(`  ${statusGlyph(host.status)} ${host.name.padEnd(20)} ${target}${dir}${url}`)
  }
}

export async function buildCreateHostInput(
  name: string,
  flags: HostAddFlags,
  options?: { interactive?: boolean }
): Promise<CreateHostInput> {
  const promptForMissing = options?.interactive ?? (!hasStringFlag(flags, 'hostname') || !hasStringFlag(flags, 'username'))
  const hostname = await readHostAddValue(flags, 'hostname', 'SSH hostname or IP', { required: true, prompt: promptForMissing })
  const username = await readHostAddValue(flags, 'username', 'SSH username', { required: true, prompt: promptForMissing })
  const portValue = await readHostAddValue(flags, 'port', 'SSH port', { defaultValue: '22', prompt: promptForMissing })
  const authMethod = (typeof flags['auth-method'] === 'string' && flags['auth-method'].trim()
    ? flags['auth-method'].trim()
    : 'key') as 'key' | 'password'

  if (authMethod !== 'key' && authMethod !== 'password') {
    throw new CliError('INVALID_AUTH_METHOD', '--auth-method must be "key" or "password"', ExitCodes.INVALID_ARGS)
  }

  const port = portValue ? Number(portValue) : undefined
  if (port !== undefined && (Number.isNaN(port) || port < 1 || port > 65535)) {
    throw new CliError('INVALID_PORT', 'Port must be between 1 and 65535', ExitCodes.INVALID_ARGS)
  }

  const keyPath = authMethod === 'key'
    ? await readHostAddValue(flags, 'key-path', 'Private key path', { defaultValue: '~/.ssh/id_ed25519', prompt: promptForMissing })
    : undefined
  const password = authMethod === 'password'
    ? await readHostAddValue(flags, 'password', 'SSH password', { required: true, prompt: promptForMissing })
    : undefined
  const defaultDirectory = await readHostAddValue(flags, 'directory', 'Default directory', { prompt: promptForMissing })
  const fulcrumUrl = await readHostAddValue(flags, 'fulcrum-url', 'Fulcrum URL', { prompt: promptForMissing })

  return {
    name,
    hostname,
    username,
    port,
    authMethod,
    privateKeyPath: keyPath,
    password,
    defaultDirectory,
    fulcrumUrl,
  }
}

async function handleAdd(
  client: FulcrumClient,
  name: string,
  flags: HostAddFlags
) {
  const input = await buildCreateHostInput(name, flags)

  const host = await client.createHost(input)
  if (isJsonOutput()) {
    output(host)
  } else {
    console.log(`Host "${host.name}" added (${host.username}@${host.hostname}:${host.port})`)
  }
}

async function handleRemove(client: FulcrumClient, name: string) {
  const host = await resolveHostByName(client, name)
  const activeTasks = activeTasksForHost(await client.listTasks(), host.id)

  if (activeTasks.length > 0) {
    const taskList = activeTasks
      .slice(0, 5)
      .map((task) => `#${task.id} ${task.title}`)
      .join(', ')
    const extra = activeTasks.length > 5 ? `, and ${activeTasks.length - 5} more` : ''
    if (isJsonOutput()) {
      throw new CliError(
        'HOST_HAS_ACTIVE_TASKS',
        `Host "${host.name}" has ${activeTasks.length} active task(s): ${taskList}${extra}`,
        ExitCodes.VALIDATION_ERROR
      )
    }

    const shouldRemove = await confirm(
      `Host "${host.name}" has ${activeTasks.length} active task(s): ${taskList}${extra}. Remove it anyway? Tasks using this host will fall back to local execution.`
    )
    if (!shouldRemove) {
      throw new CliError('REMOVE_CANCELED', 'Host removal canceled', ExitCodes.ERROR)
    }
  }

  await client.deleteHost(host.id)
  if (isJsonOutput()) {
    output({ success: true, removed: host.name })
  } else {
    console.log(`Host "${host.name}" removed`)
  }
}

async function handleTest(client: FulcrumClient, name: string) {
  const host = await resolveHostByName(client, name)
  const result = await client.testHost(host.id)
  if (isJsonOutput()) {
    output(result)
    return
  }
  if (result.success) {
    console.log(`OK ${host.name} (${result.latencyMs ?? '?'}ms)${result.fingerprint ? `  fingerprint=SHA256:${result.fingerprint}` : ''}`)
  } else {
    console.log(`FAIL ${host.name}: ${result.error ?? 'connection failed'}`)
    process.exitCode = ExitCodes.GENERAL_ERROR
  }
}

async function handleCheckEnv(client: FulcrumClient, name: string) {
  const host = await resolveHostByName(client, name)
  const result = await client.checkHostEnv(host.id)
  if (isJsonOutput()) {
    output(result)
    return
  }
  console.log(`Environment check: ${host.name}`)
  for (const [tool, info] of Object.entries(result.checks)) {
    const glyph = info.installed ? '✓' : '✗'
    const version = info.version ? ` ${info.version}` : ''
    const err = info.error ? ` (${info.error})` : ''
    console.log(`  ${glyph} ${tool.padEnd(12)}${version}${err}`)
  }
  console.log(`Status: ${result.ready ? 'ready' : 'not ready'}`)
  if (!result.ready) {
    process.exitCode = ExitCodes.GENERAL_ERROR
  }
}

const hostsListCommand = defineCommand({
  meta: { name: 'list', description: 'List configured remote hosts' },
  args: globalArgs,
  async run({ args }) {
    setupJsonOutput(args)
    const client = new FulcrumClient(toFlags(args).url, toFlags(args).port)
    await handleList(client)
  },
})

const hostServerArgs = {
  'server-port': { type: 'string' as const, description: 'Fulcrum server port (default: 7777)' },
  url: globalArgs.url,
  json: globalArgs.json,
  debug: globalArgs.debug,
}

const hostsAddCommand = defineCommand({
  meta: { name: 'add', description: 'Add a new remote host' },
  args: {
    ...hostServerArgs,
    name: { type: 'positional' as const, description: 'Host name (display label, must be unique)', required: true },
    hostname: { type: 'string' as const, description: 'SSH hostname or IP' },
    port: { type: 'string' as const, description: 'SSH port (default: 22)' },
    username: { type: 'string' as const, description: 'SSH username' },
    'auth-method': { type: 'string' as const, description: 'Authentication method: key (default) or password' },
    'key-path': { type: 'string' as const, description: 'Private key path (default: ~/.ssh/id_ed25519, only used with --auth-method=key)' },
    password: { type: 'string' as const, description: 'SSH password (required when --auth-method=password; consider env var to avoid shell history)' },
    directory: { type: 'string' as const, description: 'Default directory on remote host' },
    'fulcrum-url': { type: 'string' as const, description: 'URL the remote agent uses to reach this Fulcrum server' },
  },
  async run({ args }) {
    setupJsonOutput(args)
    const flags = toFlags(args)
    const client = new FulcrumClient(flags.url, flags['server-port'])
    await handleAdd(client, args.name as string, flags)
  },
})

const hostsRemoveCommand = defineCommand({
  meta: { name: 'remove', description: 'Remove a remote host' },
  args: {
    ...globalArgs,
    name: { type: 'positional' as const, description: 'Host name', required: true },
  },
  async run({ args }) {
    setupJsonOutput(args)
    const flags = toFlags(args)
    const client = new FulcrumClient(flags.url, flags.port)
    await handleRemove(client, args.name as string)
  },
})

const hostsTestCommand = defineCommand({
  meta: { name: 'test', description: 'Test SSH connection to a remote host' },
  args: {
    ...globalArgs,
    name: { type: 'positional' as const, description: 'Host name', required: true },
  },
  async run({ args }) {
    setupJsonOutput(args)
    const flags = toFlags(args)
    const client = new FulcrumClient(flags.url, flags.port)
    await handleTest(client, args.name as string)
  },
})

const hostsCheckEnvCommand = defineCommand({
  meta: { name: 'check-env', description: 'Check remote environment readiness (dtach, fulcrum, agent)' },
  args: {
    ...globalArgs,
    name: { type: 'positional' as const, description: 'Host name', required: true },
  },
  async run({ args }) {
    setupJsonOutput(args)
    const flags = toFlags(args)
    const client = new FulcrumClient(flags.url, flags.port)
    await handleCheckEnv(client, args.name as string)
  },
})

export const hostsCommand = defineCommand({
  meta: { name: 'hosts', description: 'Manage remote SSH hosts' },
  args: globalArgs,
  subCommands: {
    list: hostsListCommand,
    add: hostsAddCommand,
    remove: hostsRemoveCommand,
    test: hostsTestCommand,
    'check-env': hostsCheckEnvCommand,
  },
  async run({ args }) {
    const positionals = (args._ as string[] | undefined) ?? []
    if (positionals.length > 0) return
    setupJsonOutput(args)
    const client = new FulcrumClient(toFlags(args).url, toFlags(args).port)
    await handleList(client)
  },
})
