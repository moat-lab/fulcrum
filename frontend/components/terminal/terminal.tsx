import { useEffect, useRef, useCallback } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'

import '@xterm/xterm/css/xterm.css'
import { cn } from '@/lib/utils'
import { registerOsc52Handler } from './osc52-handler'
import { useKeyboardContext } from '@/contexts/keyboard-context'
import { HugeiconsIcon } from '@hugeicons/react'
import { ArrowDownDoubleIcon, ReloadIcon } from '@hugeicons/core-free-icons'
import { MobileTerminalControls } from './mobile-terminal-controls'
import { useTheme } from 'next-themes'
import { getTerminalTheme } from './terminal-theme'

interface TerminalProps {
  className?: string
  onReady?: (terminal: XTerm) => void
  onResize?: (cols: number, rows: number) => void
  onContainerReady?: (container: HTMLDivElement) => void
  terminalId?: string
  setupImagePaste?: (container: HTMLElement, terminalId: string) => () => void
  onSend?: (data: string) => void
  onFocus?: () => void
  onReset?: () => void
}

export function Terminal({ className, onReady, onResize, onContainerReady, terminalId, setupImagePaste, onSend, onFocus, onReset }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const onResizeRef = useRef(onResize)
  const onFocusRef = useRef(onFocus)
  const onReadyRef = useRef(onReady)
  const onContainerReadyRef = useRef(onContainerReady)
  const { setTerminalFocused } = useKeyboardContext()
  const { resolvedTheme } = useTheme()
  const isDark = resolvedTheme === 'dark'
  const terminalTheme = getTerminalTheme(isDark)

  // Keep refs updated
  useEffect(() => {
    onResizeRef.current = onResize
  }, [onResize])

  useEffect(() => {
    onFocusRef.current = onFocus
  }, [onFocus])

  useEffect(() => {
    onReadyRef.current = onReady
  }, [onReady])

  useEffect(() => {
    onContainerReadyRef.current = onContainerReady
  }, [onContainerReady])

  const doFit = useCallback(() => {
    if (!fitAddonRef.current || !termRef.current) return

    // FitAddon.proposeDimensions can return NaN when the container has zero
    // size (tab hidden, panel collapsed). Calling .fit() with NaN propagates
    // garbage cols/rows to the server; the running TUI then draws against a
    // bogus geometry and the next visible render shows overlapping glyphs.
    // Guard explicitly: if dimensions aren't usable, skip this fit cycle.
    const proposed = fitAddonRef.current.proposeDimensions()
    if (!proposed || !Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows)) {
      return
    }
    if (proposed.cols < 2 || proposed.rows < 2) return

    fitAddonRef.current.fit()
    const { cols, rows } = termRef.current
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 2 || rows < 2) return
    onResizeRef.current?.(cols, rows)
  }, [])

  useEffect(() => {
    if (!containerRef.current || termRef.current) return

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'monospace',
      theme: terminalTheme,
      scrollback: 10000,
      rightClickSelectsWord: true,
      scrollOnUserInput: false,
    })

    const fitAddon = new FitAddon()
    const webLinksAddon = new WebLinksAddon()

    term.loadAddon(fitAddon)
    term.loadAddon(webLinksAddon)
    term.open(containerRef.current)

    const osc52Cleanup = registerOsc52Handler(term)

    termRef.current = term
    fitAddonRef.current = fitAddon

    // Initial fit after container is sized, with delayed refit to catch layout stabilization
    requestAnimationFrame(() => {
      doFit()
      onReadyRef.current?.(term)
      if (containerRef.current) {
        onContainerReadyRef.current?.(containerRef.current)
      }
    })

    // Track terminal focus for keyboard shortcuts
    const handleTerminalFocus = () => {
      setTerminalFocused(true)
      onFocusRef.current?.()
    }
    const handleTerminalBlur = () => setTerminalFocused(false)

    // xterm creates a hidden textarea for keyboard input - track its focus
    if (term.textarea) {
      term.textarea.addEventListener('focus', handleTerminalFocus)
      term.textarea.addEventListener('blur', handleTerminalBlur)
    }

    // Schedule additional fits to catch async layout (ResizablePanel timing)
    const refitTimeout = setTimeout(() => {
      doFit()
      term.refresh(0, term.rows - 1)
    }, 100)

    // Debounce all resize triggers (window, ResizeObserver, IntersectionObserver,
    // visibilitychange) through one 50 ms window. Multiple observers firing in
    // close succession during a drag-resize otherwise produce a stream of fits
    // that race the server's PTY resize calls, leaving the running TUI drawing
    // at an intermediate geometry that no longer matches what xterm renders.
    let resizeTimer: ReturnType<typeof setTimeout> | undefined
    const handleResize = () => {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        resizeTimer = undefined
        requestAnimationFrame(doFit)
      }, 50)
    }

    window.addEventListener('resize', handleResize)

    // Handle document visibility changes (browser tab switches)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        requestAnimationFrame(() => {
          doFit()
          term.refresh(0, term.rows - 1)
        })
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    // Use ResizeObserver for container size changes
    const resizeObserver = new ResizeObserver(handleResize)
    resizeObserver.observe(containerRef.current)

    // Use IntersectionObserver to handle terminals becoming visible after being hidden
    const visibilityObserver = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          requestAnimationFrame(() => {
            doFit()
            term.refresh(0, term.rows - 1)
          })
        }
      },
      { threshold: 0.1 }
    )
    visibilityObserver.observe(containerRef.current)

    return () => {
      clearTimeout(refitTimeout)
      if (resizeTimer) clearTimeout(resizeTimer)
      window.removeEventListener('resize', handleResize)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      resizeObserver.disconnect()
      visibilityObserver.disconnect()
      osc52Cleanup()
      if (term.textarea) {
        term.textarea.removeEventListener('focus', handleTerminalFocus)
        term.textarea.removeEventListener('blur', handleTerminalBlur)
      }
      setTerminalFocused(false)
      term.dispose()
      termRef.current = null
      fitAddonRef.current = null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- terminalTheme excluded: theme updates handled by separate effect
  }, [doFit, setTerminalFocused])

  // Set up image paste when terminalId is available
  useEffect(() => {
    if (!containerRef.current || !terminalId || !setupImagePaste) return
    const cleanup = setupImagePaste(containerRef.current, terminalId)
    return cleanup
  }, [terminalId, setupImagePaste])

  // Update terminal theme when system theme changes
  useEffect(() => {
    if (!termRef.current) return
    termRef.current.options.theme = terminalTheme
    // Refresh to re-render existing content with new theme colors
    termRef.current.refresh(0, termRef.current.rows - 1)
  }, [terminalTheme])

  return (
    <div className="flex h-full w-full max-w-full flex-col">
      <div className="relative min-h-0 flex-1">
        <div className={cn('h-full w-full max-w-full p-2 bg-terminal-background touch-none', className)}>
          <div ref={containerRef} className="h-full w-full overflow-hidden" />
        </div>
        <div className={cn('group absolute top-2 right-5 flex flex-col items-end gap-1', isDark ? 'text-white/50' : 'text-black/50')}>
          {onReset && (
            <button
              onClick={() => { if (window.confirm('Reset this terminal? This will destroy and recreate it.')) onReset() }}
              className={cn('p-1 opacity-0 transition-all group-hover:opacity-100', isDark ? 'hover:text-white/80' : 'hover:text-black/80')}
              title="Reset terminal"
            >
              <HugeiconsIcon icon={ReloadIcon} size={20} strokeWidth={2} />
            </button>
          )}
          <button
            onClick={() => termRef.current?.scrollToBottom()}
            className={cn('p-1 opacity-0 transition-all group-hover:opacity-100', isDark ? 'hover:text-white/80' : 'hover:text-black/80')}
            title="Scroll to bottom"
          >
            <HugeiconsIcon icon={ArrowDownDoubleIcon} size={24} strokeWidth={2} />
          </button>
        </div>
      </div>
      <div className="h-2 shrink-0 bg-terminal-background" />
      {onSend && <MobileTerminalControls onSend={onSend} />}
    </div>
  )
}
