import { useEffect, useRef, useState, useCallback } from 'react'
import type { Terminal as XTerm } from '@xterm/xterm'
import { cn } from '@/lib/utils'
import { useTerminalWS } from '@/hooks/use-terminal-ws'
import { Terminal } from './terminal'
import { HugeiconsIcon } from '@hugeicons/react'
import { Loading03Icon } from '@hugeicons/core-free-icons'
import { MobileTerminalControls } from './mobile-terminal-controls'
import { useTheme } from 'next-themes'
import { log } from '@/lib/logger'

interface ShellTerminalProps {
  /**
   * Synthetic tabId for this terminal. Used to bypass the server's duplicate-cwd
   * detection (which only applies to terminals without a tabId). Caller chooses
   * the prefix, e.g. `task-shell:{taskId}` or `repo-shell:{repoId}`.
   */
  scopeId: string
  /** Display name for the terminal. */
  name: string
  /** Working directory for the shell. Renders an empty state when null. */
  cwd: string | null
  /** Optional taskId to associate with the terminal on the server side. */
  taskId?: string
  /** Message shown when cwd is null. */
  emptyMessage?: string
  className?: string
  /**
   * Reports the current terminal id to the parent. Used so the parent can wire
   * up things like ScratchEditor's "send to terminal" against this shell.
   */
  onTerminalIdChange?: (terminalId: string | null) => void
}

/**
 * A plain shell terminal scoped by a synthetic tabId.
 * Unlike the task agent terminal, this does NOT start an AI agent — it's just a shell.
 * Used by both the task detail view and the repository workspace.
 */
export function ShellTerminal({
  scopeId,
  name,
  cwd,
  taskId,
  emptyMessage = 'No working directory configured',
  className,
  onTerminalIdChange,
}: ShellTerminalProps) {
  const [terminalId, setTerminalId] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [xtermOpened, setXtermOpened] = useState(false)
  const xtermRef = useRef<XTerm | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const createdRef = useRef(false)
  const attachedRef = useRef(false)
  const { resolvedTheme } = useTheme()
  const isDark = resolvedTheme === 'dark'

  const {
    terminals,
    terminalsLoaded,
    connected,
    createTerminal,
    attachXterm,
    resizeTerminal,
    setupImagePaste,
    writeToTerminal,
    recreateTerminal,
  } = useTerminalWS()

  const attachXtermRef = useRef(attachXterm)
  const setupImagePasteRef = useRef(setupImagePaste)
  useEffect(() => { attachXtermRef.current = attachXterm }, [attachXterm])
  useEffect(() => { setupImagePasteRef.current = setupImagePaste }, [setupImagePaste])

  const currentTerminal = terminalId ? terminals.find((t) => t.id === terminalId) : null
  const terminalStatus = currentTerminal?.status

  // Notify parent of id changes
  useEffect(() => {
    onTerminalIdChange?.(terminalId)
  }, [terminalId, onTerminalIdChange])

  // Reset refs when scope changes (cwd or scopeId)
  useEffect(() => {
    createdRef.current = false
    attachedRef.current = false
    setTerminalId(null)
    setIsCreating(false)
    setXtermOpened(false)
  }, [cwd, scopeId])

  // Find existing or create new shell terminal
  // Gated on xtermOpened so setTerminalId never fires before xtermRef is populated —
  // otherwise the [terminalId]-keyed attach effect runs once with a null ref and never re-runs.
  useEffect(() => {
    if (!connected || !cwd || !terminalsLoaded || !xtermOpened) return

    const existing = terminals.find((t) => t.tabId === scopeId)
    if (existing) {
      log.taskTerminal.debug('Found existing shell terminal', { id: existing.id, scopeId })
      setTerminalId(existing.id)
      setIsCreating(false)
      return
    }

    if (!createdRef.current && xtermRef.current) {
      log.taskTerminal.info('Creating shell terminal', { cwd, scopeId })
      createdRef.current = true
      setIsCreating(true)
      const { cols, rows } = xtermRef.current
      createTerminal({
        name,
        cols,
        rows,
        cwd,
        tabId: scopeId,
        ...(taskId ? { taskId } : {}),
      })
    }
  }, [connected, cwd, terminalsLoaded, xtermOpened, terminals, scopeId, name, taskId, createTerminal])

  // Track terminal ID when it appears (optimistic tempId → realId)
  useEffect(() => {
    if (!cwd) return
    const match = terminals.find((t) => t.tabId === scopeId)
    if (!match) return

    const currentExists = terminalId && terminals.some((t) => t.id === terminalId)
    if (!terminalId || !currentExists) {
      setTerminalId(match.id)
      setIsCreating(false)
      if (terminalId && !currentExists) {
        attachedRef.current = false
      }
    }
  }, [terminals, cwd, terminalId, scopeId])

  // Attach xterm to terminal.
  // xtermOpened is in deps so this re-runs when the child's xterm finishes opening
  // (the onReady callback fires inside rAF, which sets xtermRef.current AND xtermOpened).
  // Without this, terminalId set by the tempId→realId effect can race ahead of the ref,
  // and the attach effect would early-return once and never retry.
  useEffect(() => {
    if (!terminalId || !xtermRef.current || !containerRef.current || attachedRef.current) return

    const onAttached = () => {
      requestAnimationFrame(() => {
        // The Terminal component handles fitting internally
      })
    }

    const cleanup = attachXtermRef.current(terminalId, xtermRef.current, { onAttached })
    const cleanupPaste = setupImagePasteRef.current(containerRef.current, terminalId)
    attachedRef.current = true

    return () => {
      cleanup()
      cleanupPaste()
      attachedRef.current = false
    }
  }, [terminalId, xtermOpened])

  const handleReady = useCallback((term: XTerm) => {
    xtermRef.current = term
    setXtermOpened(true)
  }, [])

  const handleResize = useCallback((cols: number, rows: number) => {
    if (terminalId) {
      resizeTerminal(terminalId, cols, rows)
    }
  }, [terminalId, resizeTerminal])

  const handleContainerReady = useCallback((container: HTMLDivElement) => {
    containerRef.current = container
  }, [])

  const handleMobileSend = useCallback((data: string) => {
    if (terminalId) {
      writeToTerminal(terminalId, data)
    }
  }, [terminalId, writeToTerminal])

  const handleReset = useCallback(() => {
    if (terminalId) {
      attachedRef.current = false
      createdRef.current = false
      setTerminalId(null)
      recreateTerminal(terminalId)
    }
  }, [terminalId, recreateTerminal])

  if (!cwd) {
    return (
      <div className={cn('flex h-full items-center justify-center text-muted-foreground text-sm bg-terminal-background', className)}>
        {emptyMessage}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {!connected && (
        <div className="shrink-0 px-2 py-1 bg-muted-foreground/20 text-muted-foreground text-xs">
          Connecting to terminal server...
        </div>
      )}
      {terminalStatus === 'error' && (
        <div className="shrink-0 px-2 py-1 bg-destructive/20 text-destructive text-xs">
          Terminal failed to start. The directory may not exist.
        </div>
      )}
      {terminalStatus === 'exited' && (
        <div className="shrink-0 px-2 py-1 bg-muted text-muted-foreground text-xs">
          Terminal exited (code: {currentTerminal?.exitCode})
        </div>
      )}

      <div className="relative min-h-0 min-w-0 flex-1">
        <Terminal
          className={cn('h-full w-full', className)}
          onReady={handleReady}
          onResize={handleResize}
          onContainerReady={handleContainerReady}
          terminalId={terminalId ?? undefined}
          setupImagePaste={setupImagePaste}
          onSend={handleMobileSend}
          onReset={terminalId ? handleReset : undefined}
        />

        {isCreating && !terminalId && (
          <div className="absolute inset-0 flex items-center justify-center bg-terminal-background">
            <div className="flex flex-col items-center gap-3">
              <HugeiconsIcon
                icon={Loading03Icon}
                size={24}
                strokeWidth={2}
                className={cn('animate-spin', isDark ? 'text-white/50' : 'text-black/50')}
              />
              <span className={cn('font-mono text-sm', isDark ? 'text-white/50' : 'text-black/50')}>
                Initializing terminal...
              </span>
            </div>
          </div>
        )}
      </div>

      <div className="h-2 shrink-0 bg-terminal-background" />
      <MobileTerminalControls onSend={handleMobileSend} />
    </div>
  )
}
