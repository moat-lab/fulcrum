import { useEffect, useMemo, useState, useCallback } from 'react'
import type { DiffOptions } from '@/types'

const STORAGE_PREFIX = 'diff-options:repo:'

const DEFAULT_DIFF_OPTIONS: DiffOptions = {
  wrap: true,
  ignoreWhitespace: true,
  includeUntracked: false,
  collapsedFiles: [],
  defaultCollapsed: false,
}

function readFromStorage(key: string): DiffOptions {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return DEFAULT_DIFF_OPTIONS
    const parsed = JSON.parse(raw) as Partial<DiffOptions>
    return { ...DEFAULT_DIFF_OPTIONS, ...parsed }
  } catch {
    return DEFAULT_DIFF_OPTIONS
  }
}

export function useDiffOptionsLocal(repoId: string) {
  const storageKey = STORAGE_PREFIX + repoId
  const [options, setOptionsState] = useState<DiffOptions>(() => readFromStorage(storageKey))

  useEffect(() => {
    setOptionsState(readFromStorage(storageKey))
  }, [storageKey])

  const persist = useCallback((next: DiffOptions) => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(next))
    } catch {
      // ignore
    }
  }, [storageKey])

  const setOptions = useCallback(
    (partial: Partial<DiffOptions>) => {
      setOptionsState((prev) => {
        const next = { ...prev, ...partial }
        persist(next)
        return next
      })
    },
    [persist]
  )

  const setOption = useCallback(
    <K extends keyof DiffOptions>(key: K, value: DiffOptions[K]) => {
      setOptions({ [key]: value } as Partial<DiffOptions>)
    },
    [setOptions]
  )

  const collapsedSet = useMemo(() => new Set(options.collapsedFiles), [options.collapsedFiles])

  const toggleFileCollapse = useCallback(
    (path: string) => {
      setOptionsState((prev) => {
        const next = new Set(prev.collapsedFiles)
        if (next.has(path)) {
          next.delete(path)
        } else {
          next.add(path)
        }
        const updated = { ...prev, collapsedFiles: [...next] }
        persist(updated)
        return updated
      })
    },
    [persist]
  )

  const collapseAll = useCallback(
    (filePaths: string[]) => {
      setOptions({ collapsedFiles: filePaths })
    },
    [setOptions]
  )

  const expandAll = useCallback(() => {
    setOptions({ collapsedFiles: [] })
  }, [setOptions])

  return {
    options,
    collapsedSet,
    setOption,
    setOptions,
    toggleFileCollapse,
    collapseAll,
    expandAll,
  }
}
