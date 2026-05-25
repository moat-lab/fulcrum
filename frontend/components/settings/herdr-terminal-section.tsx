import { useState, useEffect } from 'react'
import { useConfig, useUpdateConfig, CONFIG_KEYS } from '@/hooks/use-config'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'

/**
 * Settings section for the herdr terminal mirror.
 *
 * Self-contained — saves immediately on change (no global "Save" button
 * dependency). Lives inside its own SettingsSection wrapper in
 * frontend/routes/settings/index.tsx.
 */
export function HerdrTerminalSection() {
  const updateConfig = useUpdateConfig()

  const enabledQ = useConfig(CONFIG_KEYS.TERMINAL_HERDR_ENABLED)
  const sessionQ = useConfig(CONFIG_KEYS.TERMINAL_HERDR_SESSION)
  const scratchLabelQ = useConfig(CONFIG_KEYS.TERMINAL_HERDR_SCRATCH_WORKSPACE_LABEL)
  const autoCloseQ = useConfig(CONFIG_KEYS.TERMINAL_HERDR_AUTO_CLOSE_TAB)
  const binaryQ = useConfig(CONFIG_KEYS.TERMINAL_HERDR_BINARY)

  const enabled = Boolean(enabledQ.data?.value ?? false)
  const autoClose = Boolean(autoCloseQ.data?.value ?? true)

  // Strings are debounced via local state so users can type freely.
  const [session, setSession] = useState<string>('')
  const [scratchLabel, setScratchLabel] = useState<string>('')
  const [binary, setBinary] = useState<string>('')

  useEffect(() => {
    if (sessionQ.data?.value !== undefined)
      setSession((sessionQ.data.value as string | null) ?? 'fulcrum')
  }, [sessionQ.data?.value])
  useEffect(() => {
    if (scratchLabelQ.data?.value !== undefined)
      setScratchLabel((scratchLabelQ.data.value as string | null) ?? 'scratch')
  }, [scratchLabelQ.data?.value])
  useEffect(() => {
    if (binaryQ.data?.value !== undefined)
      setBinary((binaryQ.data.value as string | null) ?? 'herdr')
  }, [binaryQ.data?.value])

  const commitString = (key: string, current: string, fallback: string) => {
    const next = current.trim() || fallback
    updateConfig.mutate({ key, value: next })
  }

  const attachCmd = `herdr --session ${session || 'fulcrum'}`

  return (
    <div className="space-y-3">
      {/* Enabled toggle */}
      <div className="space-y-1">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <label className="text-sm text-muted-foreground sm:w-40 sm:shrink-0">Mirror to herdr</label>
          <Switch
            checked={enabled}
            onCheckedChange={(checked) =>
              updateConfig.mutate({ key: CONFIG_KEYS.TERMINAL_HERDR_ENABLED, value: checked })
            }
          />
        </div>
        <p className="text-xs text-muted-foreground sm:ml-40 sm:pl-2">
          When on, every task terminal is also opened as a tab in herdr so you can attach from any
          SSH session. Browser xterm.js is unaffected.
        </p>
      </div>

      {/* Session name */}
      <div className="space-y-1">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <label className="text-sm text-muted-foreground sm:w-40 sm:shrink-0">Session</label>
          <Input
            value={session}
            onChange={(e) => setSession(e.target.value)}
            onBlur={() =>
              commitString(CONFIG_KEYS.TERMINAL_HERDR_SESSION, session, 'fulcrum')
            }
            placeholder="fulcrum"
            className="w-48 font-mono text-sm"
            disabled={!enabled}
          />
        </div>
        <p className="text-xs text-muted-foreground sm:ml-40 sm:pl-2">
          Herdr session namespace. Attach with: <code>{attachCmd}</code>
        </p>
      </div>

      {/* Scratch workspace label */}
      <div className="space-y-1">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <label className="text-sm text-muted-foreground sm:w-40 sm:shrink-0">
            Scratch workspace
          </label>
          <Input
            value={scratchLabel}
            onChange={(e) => setScratchLabel(e.target.value)}
            onBlur={() =>
              commitString(
                CONFIG_KEYS.TERMINAL_HERDR_SCRATCH_WORKSPACE_LABEL,
                scratchLabel,
                'scratch'
              )
            }
            placeholder="scratch"
            className="w-48 font-mono text-sm"
            disabled={!enabled}
          />
        </div>
        <p className="text-xs text-muted-foreground sm:ml-40 sm:pl-2">
          Workspace label used for scratch and manual (non-git) tasks. Git tasks use their project
          name.
        </p>
      </div>

      {/* Auto-close tab */}
      <div className="space-y-1">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <label className="text-sm text-muted-foreground sm:w-40 sm:shrink-0">
            Close tab on done
          </label>
          <Switch
            checked={autoClose}
            disabled={!enabled}
            onCheckedChange={(checked) =>
              updateConfig.mutate({
                key: CONFIG_KEYS.TERMINAL_HERDR_AUTO_CLOSE_TAB,
                value: checked,
              })
            }
          />
        </div>
        <p className="text-xs text-muted-foreground sm:ml-40 sm:pl-2">
          When a task moves to DONE or CANCELED, close its herdr tab automatically.
        </p>
      </div>

      {/* Binary path */}
      <div className="space-y-1">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <label className="text-sm text-muted-foreground sm:w-40 sm:shrink-0">Binary</label>
          <Input
            value={binary}
            onChange={(e) => setBinary(e.target.value)}
            onBlur={() => commitString(CONFIG_KEYS.TERMINAL_HERDR_BINARY, binary, 'herdr')}
            placeholder="herdr"
            className="w-48 font-mono text-sm"
            disabled={!enabled}
          />
        </div>
        <p className="text-xs text-muted-foreground sm:ml-40 sm:pl-2">
          Path to the herdr executable (defaults to <code>herdr</code> on PATH).
        </p>
      </div>
    </div>
  )
}
