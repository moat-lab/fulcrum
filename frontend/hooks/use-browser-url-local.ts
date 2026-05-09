import { useCallback, useEffect, useState } from 'react'
import { useTailscaleIp } from './use-config'
import { getDefaultBrowserUrl } from '@/lib/preview-url'

const STORAGE_PREFIX = 'browser-url:repo:'

function readFromStorage(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}

export function useBrowserUrlLocal(repoId: string) {
  const storageKey = STORAGE_PREFIX + repoId
  const { data: tailscaleIp } = useTailscaleIp()
  const defaultUrl = getDefaultBrowserUrl(tailscaleIp)
  const [url, setUrlState] = useState<string>(() => readFromStorage(storageKey, defaultUrl))

  useEffect(() => {
    setUrlState(readFromStorage(storageKey, defaultUrl))
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
