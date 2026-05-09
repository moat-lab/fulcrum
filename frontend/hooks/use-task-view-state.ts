import { useQueryClient, useMutation } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useTask } from './use-tasks'
import { useTailscaleIp } from './use-config'
import { getDefaultBrowserUrl } from '@/lib/preview-url'
import type { Task, ViewState, DiffOptions, FilesViewState } from '@/types'

interface PendingUpdates {
  activeTab?: ViewState['activeTab']
  browserUrl?: string
  diffOptions?: Partial<DiffOptions>
  filesViewState?: Partial<FilesViewState>
}

const DEFAULT_VIEW_STATE: ViewState = {
  activeTab: 'diff',
  browserUrl: getDefaultBrowserUrl(null),
  diffOptions: {
    wrap: true,
    ignoreWhitespace: true,
    includeUntracked: false,
    collapsedFiles: [],
    defaultCollapsed: false,
  },
  filesViewState: {
    selectedFile: null,
    expandedDirs: [],
  },
}

export function useTaskViewState(taskId: string) {
  const queryClient = useQueryClient()
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pendingUpdatesRef = useRef<PendingUpdates>({})
  const latestViewStateRef = useRef<ViewState>(DEFAULT_VIEW_STATE)

  const { data: task } = useTask(taskId)
  const { data: tailscaleIp } = useTailscaleIp()
  const defaultBrowserUrl = getDefaultBrowserUrl(tailscaleIp)

  // Parse viewState from task, merge with defaults
  const viewState: ViewState = useMemo(() => {
    const stored = task?.viewState
    if (!stored) {
      return { ...DEFAULT_VIEW_STATE, browserUrl: defaultBrowserUrl }
    }

    return {
      activeTab: stored.activeTab ?? DEFAULT_VIEW_STATE.activeTab,
      browserUrl: stored.browserUrl ?? defaultBrowserUrl,
      diffOptions: {
        ...DEFAULT_VIEW_STATE.diffOptions,
        ...stored.diffOptions,
      },
      filesViewState: {
        ...DEFAULT_VIEW_STATE.filesViewState,
        ...stored.filesViewState,
      },
    }
  }, [task?.viewState, defaultBrowserUrl])

  useEffect(() => {
    latestViewStateRef.current = viewState
  }, [viewState])

  // Mutation for backend persistence — fire-and-forget.
  // The optimistic cache update is the source of truth for the UI.
  // On success we just invalidate so the next natural refetch picks up
  // the server's persisted state, rather than writing server data into
  // the cache immediately (which caused a flash when a stale GET raced
  // the PATCH).
  const updateMutation = useMutation({
    mutationFn: async (newViewState: ViewState) => {
      const response = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ viewState: newViewState }),
      })
      if (!response.ok) throw new Error('Failed to update view state')
    },
  })

  // Optimistic update with debounced persistence
  const updateViewState = useCallback(
    (updates: PendingUpdates) => {
      const baseViewState = latestViewStateRef.current

      // Merge with pending updates
      const pending = pendingUpdatesRef.current
      pendingUpdatesRef.current = {
        ...pending,
        ...updates,
        diffOptions:
          updates.diffOptions || pending.diffOptions
            ? { ...pending.diffOptions, ...updates.diffOptions }
            : undefined,
        filesViewState:
          updates.filesViewState || pending.filesViewState
            ? { ...pending.filesViewState, ...updates.filesViewState }
            : undefined,
      }

      // Build new view state with full defaults
      const merged = pendingUpdatesRef.current
      const newViewState: ViewState = {
        activeTab: merged.activeTab ?? baseViewState.activeTab,
        browserUrl: merged.browserUrl ?? baseViewState.browserUrl,
        diffOptions: {
          ...baseViewState.diffOptions,
          ...merged.diffOptions,
        },
        filesViewState: {
          ...baseViewState.filesViewState,
          ...merged.filesViewState,
        },
      }
      latestViewStateRef.current = newViewState

      // Cancel any in-flight task queries so a stale GET can't overwrite
      // our optimistic cache update
      queryClient.cancelQueries({ queryKey: ['tasks', taskId] })

      // Immediate optimistic update
      queryClient.setQueryData<Task>(['tasks', taskId], (old) => {
        if (!old) return old
        return { ...old, viewState: newViewState }
      })

      // Also update the tasks list cache
      queryClient.setQueryData<Task[]>(['tasks'], (old) => {
        if (!old) return old
        return old.map((t) =>
          t.id === taskId ? { ...t, viewState: newViewState } : t
        )
      })

      // Debounced backend persistence
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }
      debounceTimerRef.current = setTimeout(() => {
        updateMutation.mutate(newViewState)
        pendingUpdatesRef.current = {}
      }, 500)
    },
    [queryClient, taskId, updateMutation]
  )

  const setActiveTab = useCallback(
    (tab: ViewState['activeTab']) => {
      updateViewState({ activeTab: tab })
    },
    [updateViewState]
  )

  const setBrowserUrl = useCallback(
    (url: string) => {
      updateViewState({ browserUrl: url })
    },
    [updateViewState]
  )

  const setDiffOptions = useCallback(
    (options: Partial<DiffOptions>) => {
      updateViewState({ diffOptions: options })
    },
    [updateViewState]
  )

  const setFilesViewState = useCallback(
    (updates: Partial<FilesViewState>) => {
      updateViewState({ filesViewState: updates })
    },
    [updateViewState]
  )

  return {
    viewState,
    setActiveTab,
    setBrowserUrl,
    setDiffOptions,
    setFilesViewState,
  }
}
