import { useState, useCallback, useEffect, useRef } from 'react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  LinkSquare02Icon,
  RefreshIcon,
} from '@hugeicons/core-free-icons'

interface BrowserPreviewProps {
  url: string
  setUrl: (url: string) => void
}

export function BrowserPreview({ url, setUrl }: BrowserPreviewProps) {
  const [inputValue, setInputValue] = useState(url)
  const [key, setKey] = useState(0)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  // Sync input value when URL changes (e.g., on initial load)
  useEffect(() => {
    setInputValue(url)
  }, [url])

  const handleIframeLoad = useCallback(() => {
    try {
      const href = iframeRef.current?.contentWindow?.location.href
      if (href && href !== 'about:blank') {
        setInputValue(href)
        setUrl(href)
      }
    } catch {
      // Cross-origin iframe — location access is blocked, silently ignore
    }
  }, [setUrl])

  const handleRefresh = useCallback(() => {
    setKey((k) => k + 1)
  }, [])

  const handleOpenInNewTab = useCallback(() => {
    if (!url) return
    window.open(url, '_blank', 'noopener,noreferrer')
  }, [url])

  const handleNavigate = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault()
      let newUrl = inputValue.trim()
      if (!newUrl.startsWith('http://') && !newUrl.startsWith('https://')) {
        newUrl = `http://${newUrl}`
      }
      setUrl(newUrl)
      setKey((k) => k + 1)
    },
    [inputValue, setUrl]
  )

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Browser toolbar */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border bg-card px-2 py-1.5">
        <Button variant="ghost" size="icon-xs" disabled>
          <HugeiconsIcon icon={ArrowLeft01Icon} size={14} strokeWidth={2} />
        </Button>
        <Button variant="ghost" size="icon-xs" disabled>
          <HugeiconsIcon icon={ArrowRight01Icon} size={14} strokeWidth={2} />
        </Button>
        <Button variant="ghost" size="icon-xs" onClick={handleRefresh}>
          <HugeiconsIcon icon={RefreshIcon} size={14} strokeWidth={2} />
        </Button>

        <form onSubmit={handleNavigate} className="flex-1">
          <Input
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            className="h-7 bg-background text-xs"
            placeholder="Enter URL..."
          />
        </form>

        <Button
          variant="ghost"
          size="icon-xs"
          onClick={handleOpenInNewTab}
          disabled={!url}
          title="Open in new tab"
        >
          <HugeiconsIcon icon={LinkSquare02Icon} size={14} strokeWidth={2} />
        </Button>
      </div>

      {/* Browser content */}
      <div className="flex-1 overflow-hidden bg-card">
        <iframe
          ref={iframeRef}
          key={key}
          src={url}
          className="h-full w-full border-0"
          title="Browser Preview"
          onLoad={handleIframeLoad}
        />
      </div>
    </div>
  )
}
