import { useCallback, useEffect, useState } from 'react'
import { useTailscaleIp } from './use-config'

const STORAGE_PREFIX = 'browser-url:repo:'
const LOCALHOST_BROWSER_URL = 'http://localhost:3000'

function read(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}

/**
 * Persists the browser URL per repository in localStorage.
 * Defaults to http://<tailscale-ip>:3000 when available, else http://localhost:3000.
 */
export function useBrowserUrlLocal(repoId: string) {
  const storageKey = STORAGE_PREFIX + repoId
  const { data: tailscaleIp } = useTailscaleIp()
  const defaultUrl = tailscaleIp ? `http://${tailscaleIp}:3000` : LOCALHOST_BROWSER_URL

  const [url, setUrlState] = useState<string>(() => read(storageKey, defaultUrl))

  // If the stored value is missing and the default flips when tailscaleIp resolves, adopt it
  useEffect(() => {
    try {
      const stored = localStorage.getItem(storageKey)
      if (!stored) {
        setUrlState(defaultUrl)
      }
    } catch {
      // ignore
    }
  }, [storageKey, defaultUrl])

  // Re-read when repoId changes
  useEffect(() => {
    setUrlState(read(storageKey, defaultUrl))
  }, [storageKey, defaultUrl])

  const setUrl = useCallback(
    (next: string) => {
      setUrlState(next)
      try {
        localStorage.setItem(storageKey, next)
      } catch {
        // ignore
      }
    },
    [storageKey]
  )

  return { url, setUrl }
}
