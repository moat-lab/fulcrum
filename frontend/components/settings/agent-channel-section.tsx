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
import { HugeiconsIcon } from '@hugeicons/react'
import { TestTube01Icon, Loading03Icon, Tick02Icon, Cancel01Icon } from '@hugeicons/core-free-icons'
import { useConfig, useUpdateConfig } from '@/hooks/use-config'
import { CONFIG_KEYS } from '@shared/config-keys'

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
  const updateConfig = useUpdateConfig()

  const [enabled, setEnabled] = useState<boolean>(false)
  const [url, setUrl] = useState<string>('')
  const [token, setToken] = useState<string>('')
  const [mailbox, setMailbox] = useState<string>('')
  const [mcpGitRef, setMcpGitRef] = useState<string>('')
  const [testing, setTesting] = useState(false)
  const [lastTest, setLastTest] = useState<TestConnectionResult | null>(null)

  useEffect(() => {
    if (enabledConfig.data?.value !== undefined) setEnabled(Boolean(enabledConfig.data.value))
    if (urlConfig.data?.value !== undefined) setUrl(String(urlConfig.data.value ?? ''))
    if (tokenConfig.data?.value !== undefined) setToken(String(tokenConfig.data.value ?? ''))
    if (mailboxConfig.data?.value !== undefined) setMailbox(String(mailboxConfig.data.value ?? ''))
    if (mcpGitRefConfig.data?.value !== undefined) setMcpGitRef(String(mcpGitRefConfig.data.value ?? ''))
  }, [enabledConfig.data, urlConfig.data, tokenConfig.data, mailboxConfig.data, mcpGitRefConfig.data])

  async function persistField(key: string, value: string | boolean): Promise<void> {
    try {
      await updateConfig.mutateAsync({ key, value })
    } catch (err) {
      toast.error(`Failed to save ${key}: ${err instanceof Error ? err.message : String(err)}`)
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
    </div>
  )
}
