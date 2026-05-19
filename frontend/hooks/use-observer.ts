import { useQuery } from '@tanstack/react-query'
import { fetchJSON } from '@/lib/api'

export type ObserverActionRecord = {
  type: 'create_task' | 'store_memory'
  title?: string
  content?: string
  tags?: string[]
}

export interface ObserverInvocation {
  id: string
  channelMessageId: string | null
  channelType: string
  connectionId: string
  senderId: string
  senderName: string | null
  messagePreview: string
  provider: 'claude' | 'opencode' | 'codex'
  status: 'processing' | 'completed' | 'failed' | 'timeout' | 'circuit_open'
  actions: ObserverActionRecord[] | null
  error: string | null
  startedAt: string
  completedAt: string | null
  createdAt: string
}

export interface ObserverStatus {
  circuitBreaker: {
    state: 'closed' | 'open'
    failureCount: number
    failureThreshold: number
    nextProbeAt: number
    cooldownMs: number
  }
}

export interface ObserverStats {
  total: number
  completed: number
  failed: number
  timeout: number
  circuitOpen: number
  processing: number
  avgDurationMs: number
  tasksCreated: number
  memoriesStored: number
  last24h: number
}

export function useObserverInvocations(options?: {
  channelType?: string
  status?: string
  provider?: string
  limit?: number
  offset?: number
}) {
  const params = new URLSearchParams()
  if (options?.channelType) params.set('channelType', options.channelType)
  if (options?.status) params.set('status', options.status)
  if (options?.provider) params.set('provider', options.provider)
  if (options?.limit) params.set('limit', String(options.limit))
  if (options?.offset) params.set('offset', String(options.offset))

  const queryString = params.toString()
  const url = `/api/monitoring/observer/invocations${queryString ? `?${queryString}` : ''}`

  return useQuery({
    queryKey: ['observer', 'invocations', options],
    queryFn: () => fetchJSON<{ invocations: ObserverInvocation[]; count: number }>(url),
    refetchInterval: 10000,
  })
}

export function useObserverStatus() {
  return useQuery({
    queryKey: ['observer', 'status'],
    queryFn: () => fetchJSON<ObserverStatus>('/api/monitoring/observer/status'),
    refetchInterval: 5000,
  })
}

export function useObserverStats() {
  return useQuery({
    queryKey: ['observer', 'stats'],
    queryFn: () => fetchJSON<ObserverStats>('/api/monitoring/observer/stats'),
    refetchInterval: 15000,
  })
}
