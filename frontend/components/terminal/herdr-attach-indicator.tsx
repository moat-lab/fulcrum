import { useState } from 'react'
import { observer } from 'mobx-react-lite'
import { useTerminalStore } from '@/stores/hooks/use-terminal-store'
import { toast } from 'sonner'

interface HerdrAttachIndicatorProps {
  terminalId: string
  /** When true, only render the icon (no label) to save space. */
  compact?: boolean
}

/**
 * Small chip that surfaces the herdr workspace/tab a task terminal has been
 * mirrored into. Clicking the chip copies an SSH-friendly attach command
 * to the clipboard so the user can paste it into a remote shell.
 *
 * Renders nothing when the terminal has not been mirrored (herdrTabId
 * missing) — that's the case when terminal.herdr.enabled is false or the
 * mirror call failed.
 */
export const HerdrAttachIndicator = observer(function HerdrAttachIndicator({
  terminalId,
  compact,
}: HerdrAttachIndicatorProps) {
  const { terminals } = useTerminalStore()
  const [copied, setCopied] = useState(false)

  const terminal = terminals.find((t) => t.id === terminalId)
  if (!terminal?.herdrTabId) return null

  const session = terminal.herdrSession || 'fulcrum'
  const attachCommand = `herdr --session ${session}`
  const label = compact ? 'herdr' : `herdr · ${session}`

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(attachCommand)
      setCopied(true)
      toast.success('Attach command copied', { description: attachCommand })
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error('Clipboard write failed')
    }
  }

  return (
    <button
      type="button"
      onClick={onCopy}
      title={`Mirrored to herdr. Click to copy: ${attachCommand}`}
      className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-mono font-medium text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-400"
    >
      {copied ? '✓ copied' : label}
    </button>
  )
})
