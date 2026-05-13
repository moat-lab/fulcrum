/**
 * Settings → AI → Agent Channel section (issue #180 / parent #153).
 *
 * Surfaces the 5 `channels.exchange.*` fnox keys + a Test Connection button:
 *
 *   - channels.exchange.enabled    (plain boolean, default `false` → opt-in)
 *   - channels.exchange.url        (plain string)
 *   - channels.exchange.token      (age-encrypted, masked input)
 *   - channels.exchange.mailbox    (plain string)
 *   - channels.exchange.mcpGitRef  (plain string — `agent-channel-exchange` sha/tag)
 *
 * Test Connection hits `POST /api/channels/test-connection` which proxies
 * `GET <exchange>/version` and surfaces wire-compat failures here rather than
 * waiting until a task agent fails to register.
 */

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  TestTube01Icon,
  Loading03Icon,
  Tick02Icon,
  Cancel01Icon,
  RefreshIcon,
} from '@hugeicons/core-free-icons'
import { useConfig, useUpdateConfig } from '@/hooks/use-config'
import { CONFIG_KEYS } from '@shared/config-keys'

type PmClientForm = 'claude-mcp' | 'external-http'

interface PmMailboxDescriptor {
  channelId: string
  agentKind: string
  instanceLabel?: string
  registeredAt: string
}

interface PmMailboxesSnapshot {
  generatedAt: string | null
  channels: PmMailboxDescriptor[]
  lastError: string | null
}

const API_BASE = ''

interface TestConnectionResult {
  ok: boolean
  schemaVersion?: string
  error?: string
}

export function AgentChannelSection() {
  const enabledConfig = useConfig(CONFIG_KEYS.CHANNELS_EXCHANGE_ENABLED)
  const urlConfig = useConfig(CONFIG_KEYS.CHANNELS_EXCHANGE_URL)
  const tokenConfig = useConfig(CONFIG_KEYS.CHANNELS_EXCHANGE_TOKEN)
  const mailboxConfig = useConfig(CONFIG_KEYS.CHANNELS_EXCHANGE_MAILBOX)
  const mcpGitRefConfig = useConfig(CONFIG_KEYS.CHANNELS_EXCHANGE_MCP_GIT_REF)
  // PM Agent Mode sub-block (issue #181 / #153 §Chat 启动 UX hook).
  const pmEnabledConfig = useConfig(CONFIG_KEYS.CHANNELS_PM_ENABLED)
  const pmClientFormConfig = useConfig(CONFIG_KEYS.CHANNELS_PM_CLIENT_FORM)
  const pmMailboxConfig = useConfig(CONFIG_KEYS.CHANNELS_PM_MAILBOX)
  const pmSystemPromptRefConfig = useConfig(CONFIG_KEYS.CHANNELS_PM_SYSTEM_PROMPT_REF)
  const updateConfig = useUpdateConfig()

  const [enabled, setEnabled] = useState<boolean>(false)
  const [url, setUrl] = useState<string>('')
  const [token, setToken] = useState<string>('')
  const [mailbox, setMailbox] = useState<string>('')
  const [mcpGitRef, setMcpGitRef] = useState<string>('')
  const [testing, setTesting] = useState(false)
  const [lastTest, setLastTest] = useState<TestConnectionResult | null>(null)

  const [pmEnabled, setPmEnabled] = useState<boolean>(false)
  const [pmClientForm, setPmClientForm] = useState<PmClientForm>('claude-mcp')
  const [pmMailbox, setPmMailbox] = useState<string>('')
  const [pmSystemPromptRef, setPmSystemPromptRef] = useState<string>('')
  const [pmMailboxes, setPmMailboxes] = useState<PmMailboxesSnapshot | null>(null)
  const [pmMailboxesLoading, setPmMailboxesLoading] = useState(false)
  // PM Quick start (issue #194): generates a `claude --mcp-config <path>`
  // command Alice runs in her own terminal. fulcrum never spawns / holds the
  // resulting claude process.
  const [pmLaunch, setPmLaunch] = useState<{ command: string; mcpConfigPath: string; pmMailbox: string } | null>(null)
  const [pmLaunchError, setPmLaunchError] = useState<string | null>(null)
  const [pmLaunchLoading, setPmLaunchLoading] = useState(false)

  useEffect(() => {
    if (enabledConfig.data?.value !== undefined) setEnabled(Boolean(enabledConfig.data.value))
    if (urlConfig.data?.value !== undefined) setUrl(String(urlConfig.data.value ?? ''))
    if (tokenConfig.data?.value !== undefined) setToken(String(tokenConfig.data.value ?? ''))
    if (mailboxConfig.data?.value !== undefined) setMailbox(String(mailboxConfig.data.value ?? ''))
    if (mcpGitRefConfig.data?.value !== undefined) setMcpGitRef(String(mcpGitRefConfig.data.value ?? ''))
  }, [enabledConfig.data, urlConfig.data, tokenConfig.data, mailboxConfig.data, mcpGitRefConfig.data])

  useEffect(() => {
    if (pmEnabledConfig.data?.value !== undefined) setPmEnabled(Boolean(pmEnabledConfig.data.value))
    if (pmClientFormConfig.data?.value !== undefined) {
      const raw = String(pmClientFormConfig.data.value ?? 'claude-mcp')
      setPmClientForm(raw === 'external-http' ? 'external-http' : 'claude-mcp')
    }
    if (pmMailboxConfig.data?.value !== undefined) setPmMailbox(String(pmMailboxConfig.data.value ?? ''))
    if (pmSystemPromptRefConfig.data?.value !== undefined)
      setPmSystemPromptRef(String(pmSystemPromptRefConfig.data.value ?? ''))
  }, [
    pmEnabledConfig.data,
    pmClientFormConfig.data,
    pmMailboxConfig.data,
    pmSystemPromptRefConfig.data,
  ])

  async function refreshPmMailboxes(forceRefresh: boolean): Promise<void> {
    setPmMailboxesLoading(true)
    try {
      const res = await fetch(
        `${API_BASE}/api/channels/pm/mailboxes${forceRefresh ? '?refresh=1' : ''}`,
      )
      if (!res.ok) {
        setPmMailboxes({ generatedAt: null, channels: [], lastError: `HTTP ${res.status}` })
        return
      }
      const data = (await res.json()) as PmMailboxesSnapshot
      setPmMailboxes(data)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setPmMailboxes({ generatedAt: null, channels: [], lastError: message })
    } finally {
      setPmMailboxesLoading(false)
    }
  }

  useEffect(() => {
    if (!pmEnabled) {
      setPmMailboxes(null)
      return
    }
    void refreshPmMailboxes(false)
    const id = setInterval(() => void refreshPmMailboxes(false), 30_000)
    return () => clearInterval(id)
  }, [pmEnabled])

  async function persistField(key: string, value: string | boolean): Promise<void> {
    try {
      await updateConfig.mutateAsync({ key, value })
    } catch (err) {
      toast.error(`Failed to save ${key}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function handleGeneratePmLaunch(): Promise<void> {
    setPmLaunchLoading(true)
    setPmLaunchError(null)
    try {
      const res = await fetch(`${API_BASE}/api/channels/pm/prepare-launch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      const data = (await res.json()) as
        | { command: string; mcpConfigPath: string; pmMailbox: string }
        | { error: string; message?: string }
      if (!res.ok || !('command' in data)) {
        const message = 'message' in data && data.message ? data.message : 'unknown error'
        setPmLaunch(null)
        setPmLaunchError(message)
        toast.error(`PM launch prep failed: ${message}`)
        return
      }
      setPmLaunch(data)
      toast.success('PM launch command generated')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setPmLaunch(null)
      setPmLaunchError(message)
      toast.error(`PM launch prep failed: ${message}`)
    } finally {
      setPmLaunchLoading(false)
    }
  }

  async function copyPmCommand(): Promise<void> {
    if (!pmLaunch) return
    try {
      await navigator.clipboard.writeText(pmLaunch.command)
      toast.success('Copied to clipboard')
    } catch (err) {
      toast.error(`Copy failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function handleTestConnection(): Promise<void> {
    setTesting(true)
    setLastTest(null)
    try {
      const res = await fetch(`${API_BASE}/api/channels/test-connection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, token }),
      })
      const data = (await res.json()) as TestConnectionResult
      setLastTest(data)
      if (data.ok) {
        toast.success(`Exchange OK (schema ${data.schemaVersion ?? '?'})`)
      } else {
        toast.error(`Exchange unreachable: ${data.error ?? 'unknown error'}`)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setLastTest({ ok: false, error: message })
      toast.error(`Test Connection failed: ${message}`)
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="space-y-4" data-testid="agent-channel-section">
      <div className="space-y-1">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <label className="text-sm text-muted-foreground sm:w-32 sm:shrink-0">Enabled</label>
          <Switch
            checked={enabled}
            onCheckedChange={(v) => {
              setEnabled(v)
              void persistField(CONFIG_KEYS.CHANNELS_EXCHANGE_ENABLED, v)
            }}
            data-testid="agent-channel-enabled"
          />
        </div>
        <p className="text-xs text-muted-foreground sm:ml-32 sm:pl-2">
          Opt in to the agent-to-agent channel exchange. Off (default) leaves
          `claude` launches byte-identical to the legacy path.
        </p>
      </div>

      <div className="space-y-1">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <label className="text-sm text-muted-foreground sm:w-32 sm:shrink-0">Exchange URL</label>
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onBlur={() => persistField(CONFIG_KEYS.CHANNELS_EXCHANGE_URL, url)}
            placeholder="https://agent-channel.example.com"
            className="flex-1 font-mono text-sm"
            data-testid="agent-channel-url"
          />
        </div>
      </div>

      <div className="space-y-1">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <label className="text-sm text-muted-foreground sm:w-32 sm:shrink-0">Token</label>
          <Input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onBlur={() => persistField(CONFIG_KEYS.CHANNELS_EXCHANGE_TOKEN, token)}
            placeholder="Bearer token (stored age-encrypted via fnox)"
            className="flex-1 font-mono text-sm"
            data-testid="agent-channel-token"
          />
        </div>
        <p className="text-xs text-muted-foreground sm:ml-32 sm:pl-2">
          Stored encrypted (age provider). Never sent to the frontend after save.
        </p>
      </div>

      <div className="space-y-1">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <label className="text-sm text-muted-foreground sm:w-32 sm:shrink-0">Mailbox</label>
          <Input
            value={mailbox}
            onChange={(e) => setMailbox(e.target.value)}
            onBlur={() => persistField(CONFIG_KEYS.CHANNELS_EXCHANGE_MAILBOX, mailbox)}
            placeholder="fulcrum-mouriya-laptop"
            className="flex-1 font-mono text-sm"
            data-testid="agent-channel-mailbox"
          />
        </div>
        <p className="text-xs text-muted-foreground sm:ml-32 sm:pl-2">
          Mailbox namespace; channel-id form is `&lt;mailbox&gt;/task-&lt;id&gt;`.
        </p>
      </div>

      <div className="space-y-1">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <label className="text-sm text-muted-foreground sm:w-32 sm:shrink-0">MCP git ref</label>
          <Input
            value={mcpGitRef}
            onChange={(e) => setMcpGitRef(e.target.value)}
            onBlur={() => persistField(CONFIG_KEYS.CHANNELS_EXCHANGE_MCP_GIT_REF, mcpGitRef)}
            placeholder="sha or tag in Mouriya-Emma/agent-channel-exchange"
            className="flex-1 font-mono text-sm"
            data-testid="agent-channel-mcp-git-ref"
          />
        </div>
        <p className="text-xs text-muted-foreground sm:ml-32 sm:pl-2">
          Pinned git ref; fulcrum installs `@agent-channel/mcp` via
          `bun add github:Mouriya-Emma/agent-channel-exchange#&lt;ref&gt;`.
        </p>
      </div>

      <div className="flex items-center gap-2 pt-2 sm:ml-32 sm:pl-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => void handleTestConnection()}
          disabled={testing || !url}
          data-testid="agent-channel-test-connection"
        >
          {testing ? (
            <HugeiconsIcon icon={Loading03Icon} size={14} strokeWidth={2} className="mr-1.5 animate-spin" />
          ) : (
            <HugeiconsIcon icon={TestTube01Icon} size={14} strokeWidth={2} className="mr-1.5" />
          )}
          Test Connection
        </Button>
        {lastTest && (
          <span
            className={`flex items-center gap-1 text-xs ${lastTest.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}
            data-testid="agent-channel-test-result"
          >
            <HugeiconsIcon icon={lastTest.ok ? Tick02Icon : Cancel01Icon} size={12} strokeWidth={2} />
            {lastTest.ok ? `schema ${lastTest.schemaVersion ?? '?'}` : (lastTest.error ?? 'failed')}
          </span>
        )}
      </div>

      {/* PM Agent Mode sub-block (issue #181 / #153 §Chat 启动 UX hook). */}
      <div
        className="space-y-4 border-t border-border pt-4 mt-4"
        data-testid="pm-agent-mode-subblock"
      >
        <div>
          <h3 className="text-sm font-semibold">PM Agent Mode</h3>
          <p className="text-xs text-muted-foreground">
            Read-only chat hook for an external PM agent (Claude-MCP form or
            external HTTP form). Fulcrum never spawns the PM process.
          </p>
        </div>

        <div className="space-y-1">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <label className="text-sm text-muted-foreground sm:w-32 sm:shrink-0">Enabled</label>
            <Switch
              checked={pmEnabled}
              onCheckedChange={(v) => {
                setPmEnabled(v)
                void persistField(CONFIG_KEYS.CHANNELS_PM_ENABLED, v)
              }}
              data-testid="pm-agent-mode-enabled"
            />
          </div>
          <p className="text-xs text-muted-foreground sm:ml-32 sm:pl-2">
            Off (default) hides the PM mode entry on the chat surface and
            stops the mailbox poller.
          </p>
        </div>

        <div className="space-y-1">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <label className="text-sm text-muted-foreground sm:w-32 sm:shrink-0">Client form</label>
            <Select
              value={pmClientForm}
              onValueChange={(v) => {
                const next = v === 'external-http' ? 'external-http' : 'claude-mcp'
                setPmClientForm(next)
                void persistField(CONFIG_KEYS.CHANNELS_PM_CLIENT_FORM, next)
              }}
            >
              <SelectTrigger
                className="flex-1 font-mono text-sm"
                data-testid="pm-agent-mode-client-form"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="claude-mcp">claude-mcp</SelectItem>
                <SelectItem value="external-http">external-http</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <p className="text-xs text-muted-foreground sm:ml-32 sm:pl-2">
            `claude-mcp` mounts `@agent-channel/mcp` on the chat-side Claude
            session. `external-http` assumes an external PM process is online.
          </p>
        </div>

        <div className="space-y-1">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <label className="text-sm text-muted-foreground sm:w-32 sm:shrink-0">PM mailbox</label>
            <Input
              value={pmMailbox}
              onChange={(e) => setPmMailbox(e.target.value)}
              onBlur={() => persistField(CONFIG_KEYS.CHANNELS_PM_MAILBOX, pmMailbox)}
              placeholder="pm-mouriya/main (empty = exchange-assigned)"
              className="flex-1 font-mono text-sm"
              data-testid="pm-agent-mode-mailbox"
            />
          </div>
        </div>

        <div className="space-y-1">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <label className="text-sm text-muted-foreground sm:w-32 sm:shrink-0">
              System prompt ref
            </label>
            <Input
              value={pmSystemPromptRef}
              onChange={(e) => setPmSystemPromptRef(e.target.value)}
              onBlur={() =>
                persistField(CONFIG_KEYS.CHANNELS_PM_SYSTEM_PROMPT_REF, pmSystemPromptRef)
              }
              placeholder="path / URL / fnox key — fulcrum does not parse this"
              className="flex-1 font-mono text-sm"
              data-testid="pm-agent-mode-system-prompt-ref"
            />
          </div>
        </div>

        {pmEnabled && pmClientForm === 'claude-mcp' && (
          <div
            className="space-y-2 border border-border rounded-md p-3"
            data-testid="pm-agent-mode-quickstart"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">PM session quick start</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleGeneratePmLaunch()}
                disabled={pmLaunchLoading || !pmMailbox}
                data-testid="pm-agent-mode-generate-launch"
              >
                <HugeiconsIcon
                  icon={pmLaunchLoading ? Loading03Icon : TestTube01Icon}
                  size={14}
                  strokeWidth={2}
                  className={pmLaunchLoading ? 'mr-1.5 animate-spin' : 'mr-1.5'}
                />
                Generate command
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Run this in your own terminal (not under fulcrum). The MCP child
              spawned by your <code>claude</code> registers as
              <code> pm-agent</code> against the exchange — fulcrum does not
              hold the PM process.
            </p>
            {pmLaunchError && (
              <p
                className="text-xs text-red-600 dark:text-red-400 font-mono"
                data-testid="pm-agent-mode-launch-error"
              >
                {pmLaunchError}
              </p>
            )}
            {pmLaunch && (
              <div className="space-y-1.5">
                <pre
                  className="text-[11px] font-mono whitespace-pre-wrap break-all rounded bg-muted px-2 py-1.5"
                  data-testid="pm-agent-mode-launch-command"
                >
                  {pmLaunch.command}
                </pre>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-muted-foreground">
                    mailbox: {pmLaunch.pmMailbox}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void copyPmCommand()}
                    data-testid="pm-agent-mode-copy-launch"
                  >
                    Copy
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {pmEnabled && (
          <div
            className="space-y-2 border border-border rounded-md p-3"
            data-testid="pm-agent-mode-mailboxes"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">Online PM mailboxes</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void refreshPmMailboxes(true)}
                disabled={pmMailboxesLoading}
                data-testid="pm-agent-mode-refresh"
              >
                <HugeiconsIcon
                  icon={pmMailboxesLoading ? Loading03Icon : RefreshIcon}
                  size={14}
                  strokeWidth={2}
                  className={pmMailboxesLoading ? 'mr-1.5 animate-spin' : 'mr-1.5'}
                />
                Refresh
              </Button>
            </div>
            {pmMailboxes?.lastError && (
              <p
                className="text-xs text-red-600 dark:text-red-400 font-mono"
                data-testid="pm-agent-mode-mailboxes-error"
              >
                {pmMailboxes.lastError}
              </p>
            )}
            {pmMailboxes && pmMailboxes.channels.length === 0 && !pmMailboxes.lastError && (
              <p className="text-xs text-muted-foreground">
                No PM mailboxes online (exchange discovery returned empty).
              </p>
            )}
            {pmMailboxes && pmMailboxes.channels.length > 0 && (
              <ul className="space-y-1 text-xs font-mono">
                {pmMailboxes.channels.map((c) => (
                  <li
                    key={c.channelId}
                    className="flex items-center justify-between gap-2"
                    data-testid="pm-agent-mode-mailbox-row"
                  >
                    <span>{c.channelId}</span>
                    <span className="text-muted-foreground">
                      {c.instanceLabel ?? c.agentKind} · {c.registeredAt}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {pmMailboxes?.generatedAt && (
              <p className="text-[11px] text-muted-foreground">
                generated_at {pmMailboxes.generatedAt}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
