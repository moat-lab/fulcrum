import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { fetchJSON } from '@/lib/api'
import type { Host } from '@/types'

const API_BASE = ''

export function useHosts() {
  return useQuery({
    queryKey: ['hosts'],
    queryFn: () => fetchJSON<Host[]>(`${API_BASE}/api/hosts`),
  })
}

export function useHost(id: string | null) {
  return useQuery({
    queryKey: ['hosts', id],
    queryFn: () => fetchJSON<Host>(`${API_BASE}/api/hosts/${id}`),
    enabled: !!id,
  })
}

export function useCreateHost() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (data: {
      name: string
      hostname: string
      port?: number
      username: string
      authMethod?: 'key' | 'password'
      privateKeyPath?: string
      password?: string
      defaultDirectory?: string
      fulcrumUrl?: string
    }) =>
      fetchJSON<Host>(`${API_BASE}/api/hosts`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['hosts'] })
    },
  })
}

export function useUpdateHost() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({
      id,
      updates,
    }: {
      id: string
      updates: Partial<Pick<Host, 'name' | 'hostname' | 'port' | 'username' | 'authMethod' | 'privateKeyPath' | 'password' | 'defaultDirectory' | 'fulcrumUrl'>>
    }) =>
      fetchJSON<Host>(`${API_BASE}/api/hosts/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(updates),
      }),
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries({ queryKey: ['hosts'] })
      queryClient.invalidateQueries({ queryKey: ['hosts', id] })
    },
  })
}

export function useDeleteHost() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (id: string) =>
      fetchJSON<{ success: boolean }>(`${API_BASE}/api/hosts/${id}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['hosts'] })
      queryClient.invalidateQueries({ queryKey: ['tasks'] })
    },
  })
}

export function useTestHostConnection() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (id: string) =>
      fetchJSON<{ success: boolean; error?: string; latencyMs?: number; fingerprint?: string }>(
        `${API_BASE}/api/hosts/${id}/test`,
        { method: 'POST' },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['hosts'] })
    },
  })
}

export interface EnvCheckResult {
  checks: Record<string, { installed: boolean; version?: string; error?: string }>
  ready: boolean
}

export function useCheckHostEnv() {
  return useMutation({
    mutationFn: (id: string) =>
      fetchJSON<EnvCheckResult>(
        `${API_BASE}/api/hosts/${id}/check-env`,
        { method: 'POST' },
      ),
  })
}

export function useResetHostFingerprint() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (id: string) =>
      fetchJSON<{ success: boolean }>(
        `${API_BASE}/api/hosts/${id}/reset-fingerprint`,
        { method: 'POST' },
      ),
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: ['hosts'] })
      queryClient.invalidateQueries({ queryKey: ['hosts', id] })
    },
  })
}
