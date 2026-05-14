/**
 * `fulcrum help` — list the top-level verbs the fulcrum CLI exposes.
 *
 * Surfaced primarily as the Mattermost-plugin contract entry so
 * `mattermost-plugin-fulcrum`'s `/f help` can render a bot post listing every
 * verb. The plugin parses the standard `{success, data:{schema_version, verb,
 * verbs}}` envelope; humans running `fulcrum help --json=false` get the
 * padded text rendering instead.
 */

import { defineCommand } from 'citty'
import { outputVerbPayload, setJsonOutput } from '../utils/output'

export interface VerbDescriptor {
  name: string
  description: string
}

/**
 * Top-level verbs registered in `cli/src/index.ts`. Order mirrors the
 * grouping in `main.subCommands`. Keep this list in sync with the registry
 * — the unit test in `cli/src/__tests__/commands/help.test.ts` asserts the
 * core plugin-contract verbs are present, and the JSON envelope is the
 * stable surface `mattermost-plugin-fulcrum` reads.
 */
export const HELP_VERBS: readonly VerbDescriptor[] = [
  { name: 'current-task', description: 'Manage the current worktree task' },
  { name: 'config', description: 'Manage configuration' },
  { name: 'opencode', description: 'OpenCode integration' },
  { name: 'claude', description: 'Claude Code integration' },
  { name: 'notifications', description: 'Manage notification settings' },
  { name: 'notify', description: 'Send a notification' },
  { name: 'hosts', description: 'Manage remote SSH hosts' },
  { name: 'up', description: 'Start the Fulcrum server' },
  { name: 'down', description: 'Stop the Fulcrum server' },
  { name: 'expose', description: 'Expose this Fulcrum server publicly via a Cloudflare Tunnel' },
  { name: 'status', description: 'Show server status' },
  { name: 'doctor', description: 'Check dependencies and system status' },
  { name: 'dev', description: 'Developer mode commands' },
  { name: 'mcp', description: 'Start MCP server (stdio)' },
  { name: 'update', description: 'Check for updates and update Fulcrum to the latest version' },
  { name: 'migrate-from-vibora', description: 'Migrate data from legacy ~/.vibora directory' },
  { name: 'dashboard', description: 'Fulcrum dashboard summary (Mattermost plugin contract)' },
  { name: 'tasks', description: 'Task verbs for Mattermost plugin contract' },
  { name: 'apps', description: 'App verbs for Mattermost plugin contract' },
  { name: 'search', description: 'Unified full-text search' },
  { name: 'monitor', description: 'System metrics snapshot' },
  { name: 'jobs', description: 'List scheduled jobs (systemd/launchd timers)' },
  { name: 'projects', description: 'List projects' },
  { name: 'help', description: 'List all fulcrum CLI verbs' },
]

export function renderHelpText(verbs: readonly VerbDescriptor[]): string {
  const lines = ['Available verbs:']
  const pad = Math.max(...verbs.map((v) => v.name.length))
  for (const v of verbs) {
    lines.push(`  ${v.name.padEnd(pad)}  ${v.description}`)
  }
  return lines.join('\n')
}

export const helpCommand = defineCommand({
  meta: { name: 'help', description: 'List all fulcrum CLI verbs' },
  args: {
    json: {
      type: 'boolean' as const,
      default: true,
      description: 'Emit JSON envelope (default; Mattermost-plugin contract)',
    },
  },
  run({ args }) {
    if (args.json) {
      setJsonOutput(true)
      outputVerbPayload('help', { verbs: HELP_VERBS })
    } else {
      console.log(renderHelpText(HELP_VERBS))
    }
  },
})
