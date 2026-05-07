import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { setupTestEnv, type TestEnv } from '../__tests__/utils/env'
import { db, hosts, systemMetrics } from '../db'
import {
  startMetricsCollector,
  stopMetricsCollector,
  getMetrics,
  getCurrentMetrics,
  getHostMetricSummaries,
  hostToSshConfig,
} from './metrics-collector'

describe('Metrics Collector', () => {
  let testEnv: TestEnv

  beforeEach(() => {
    testEnv = setupTestEnv()
  })

  afterEach(() => {
    stopMetricsCollector()
    testEnv.cleanup()
  })

  describe('getCurrentMetrics', () => {
    test('returns system metrics object', () => {
      const metrics = getCurrentMetrics()

      expect(metrics).toHaveProperty('cpu')
      expect(metrics).toHaveProperty('memory')
      expect(metrics).toHaveProperty('disk')
    })

    test('returns valid CPU value', () => {
      const metrics = getCurrentMetrics()

      expect(typeof metrics.cpu).toBe('number')
      expect(metrics.cpu).toBeGreaterThanOrEqual(0)
      expect(metrics.cpu).toBeLessThanOrEqual(100)
    })

    test('returns valid memory values', () => {
      const metrics = getCurrentMetrics()

      expect(typeof metrics.memory.total).toBe('number')
      expect(typeof metrics.memory.used).toBe('number')
      expect(typeof metrics.memory.cache).toBe('number')
      expect(typeof metrics.memory.usedPercent).toBe('number')
      expect(typeof metrics.memory.cachePercent).toBe('number')

      expect(metrics.memory.total).toBeGreaterThan(0)
      expect(metrics.memory.used).toBeGreaterThanOrEqual(0)
      expect(metrics.memory.cache).toBeGreaterThanOrEqual(0)
      expect(metrics.memory.usedPercent).toBeGreaterThanOrEqual(0)
      expect(metrics.memory.usedPercent).toBeLessThanOrEqual(100)
    })

    test('returns valid disk values', () => {
      const metrics = getCurrentMetrics()

      expect(typeof metrics.disk.total).toBe('number')
      expect(typeof metrics.disk.used).toBe('number')
      expect(typeof metrics.disk.usedPercent).toBe('number')
      expect(metrics.disk.path).toBe('/')

      expect(metrics.disk.total).toBeGreaterThan(0)
      expect(metrics.disk.used).toBeGreaterThanOrEqual(0)
      expect(metrics.disk.usedPercent).toBeGreaterThanOrEqual(0)
      expect(metrics.disk.usedPercent).toBeLessThanOrEqual(100)
    })

    test('memory used is less than or equal to total', () => {
      const metrics = getCurrentMetrics()
      expect(metrics.memory.used).toBeLessThanOrEqual(metrics.memory.total)
    })

    test('disk used is less than or equal to total', () => {
      const metrics = getCurrentMetrics()
      expect(metrics.disk.used).toBeLessThanOrEqual(metrics.disk.total)
    })
  })

  describe('getMetrics', () => {
    test('returns empty array when no metrics collected', () => {
      const metrics = getMetrics(3600) // Last hour
      expect(metrics).toBeInstanceOf(Array)
    })

    test('returns metrics array structure', async () => {
      // Start collector to generate some metrics
      startMetricsCollector()

      // Wait for at least one collection
      await new Promise((resolve) => setTimeout(resolve, 1500))

      const metrics = getMetrics(3600)
      expect(metrics).toBeInstanceOf(Array)

      if (metrics.length > 0) {
        const metric = metrics[0]
        expect(metric).toHaveProperty('timestamp')
        expect(metric).toHaveProperty('cpuPercent')
        expect(metric).toHaveProperty('memoryUsedPercent')
        expect(metric).toHaveProperty('memoryCachePercent')
        expect(metric).toHaveProperty('diskUsedPercent')
      }
    })

    test('filters metrics by host id', () => {
      const timestamp = Math.floor(Date.now() / 1000)
      db.insert(systemMetrics).values({
        hostId: 'local',
        timestamp,
        cpuPercent: 10,
        memoryUsedBytes: 100,
        memoryTotalBytes: 200,
        memoryCacheBytes: 20,
        diskUsedBytes: 300,
        diskTotalBytes: 600,
      }).run()
      db.insert(systemMetrics).values({
        hostId: 'remote-1',
        timestamp,
        cpuPercent: 70,
        memoryUsedBytes: 700,
        memoryTotalBytes: 1000,
        memoryCacheBytes: 100,
        diskUsedBytes: 800,
        diskTotalBytes: 1000,
      }).run()

      expect(getMetrics(3600, 'local')).toEqual([
        expect.objectContaining({ cpuPercent: 10, memoryUsedPercent: 50, diskUsedPercent: 50 }),
      ])
      expect(getMetrics(3600, 'remote-1')).toEqual([
        expect.objectContaining({ cpuPercent: 70, memoryUsedPercent: 70, diskUsedPercent: 80 }),
      ])
    })
  })

  describe('startMetricsCollector', () => {
    test('can be started', () => {
      // Should not throw
      expect(() => startMetricsCollector()).not.toThrow()
    })

    test('is idempotent - can be started multiple times', () => {
      startMetricsCollector()
      startMetricsCollector()
      startMetricsCollector()
      // Should not throw
    })

    test('collects metrics after starting', async () => {
      startMetricsCollector()

      // Wait for collection
      await new Promise((resolve) => setTimeout(resolve, 1500))

      const metrics = getMetrics(60) // Last minute
      // May or may not have metrics depending on timing, but shouldn't error
      expect(metrics).toBeInstanceOf(Array)
    })
  })

  describe('stopMetricsCollector', () => {
    test('can be stopped', () => {
      startMetricsCollector()
      expect(() => stopMetricsCollector()).not.toThrow()
    })

    test('is idempotent - can be stopped multiple times', () => {
      startMetricsCollector()
      stopMetricsCollector()
      stopMetricsCollector()
      // Should not throw
    })

    test('can be stopped even if never started', () => {
      expect(() => stopMetricsCollector()).not.toThrow()
    })
  })

  describe('host metric summaries', () => {
    test('includes local and remote host health status', () => {
      const now = new Date().toISOString()
      const timestamp = Math.floor(Date.now() / 1000)
      db.insert(hosts).values({
        id: 'remote-1',
        name: 'Remote One',
        hostname: '192.0.2.10',
        port: 22,
        username: 'test',
        authMethod: 'key',
        status: 'connected',
        createdAt: now,
        updatedAt: now,
      }).run()
      db.insert(systemMetrics).values({
        hostId: 'remote-1',
        timestamp,
        cpuPercent: 42,
        memoryUsedBytes: 400,
        memoryTotalBytes: 1000,
        memoryCacheBytes: 100,
        diskUsedBytes: 250,
        diskTotalBytes: 1000,
      }).run()

      const summaries = getHostMetricSummaries()
      expect(summaries).toContainEqual(expect.objectContaining({ id: 'local', name: 'Local', status: 'connected' }))
      expect(summaries).toContainEqual(expect.objectContaining({
        id: 'remote-1',
        name: 'Remote One',
        status: 'connected',
        current: expect.objectContaining({ cpu: 42 }),
      }))
    })

    test('marks remote host disconnected when host status is error', () => {
      const now = new Date().toISOString()
      db.insert(hosts).values({
        id: 'remote-error',
        name: 'Remote Error',
        hostname: '192.0.2.11',
        port: 22,
        username: 'test',
        authMethod: 'key',
        status: 'error',
        createdAt: now,
        updatedAt: now,
      }).run()

      expect(getHostMetricSummaries()).toContainEqual(expect.objectContaining({
        id: 'remote-error',
        status: 'disconnected',
      }))
    })
  })

  describe('remote host SSH config', () => {
    test('preserves password credentials for password-auth metric collection', () => {
      const now = new Date().toISOString()
      const host = {
        id: 'remote-password',
        name: 'Remote Password',
        hostname: '192.0.2.12',
        port: 22,
        username: 'test',
        authMethod: 'password',
        privateKeyPath: null,
        password: 'secret-password',
        defaultDirectory: null,
        fulcrumUrl: null,
        hostFingerprint: 'fingerprint',
        status: 'unknown',
        lastConnectedAt: null,
        createdAt: now,
        updatedAt: now,
      } satisfies typeof hosts.$inferSelect

      expect(hostToSshConfig(host)).toEqual({
        host: '192.0.2.12',
        port: 22,
        username: 'test',
        authMethod: 'password',
        privateKeyPath: undefined,
        password: 'secret-password',
        hostFingerprint: 'fingerprint',
      })
    })
  })

  describe('metric values sanity', () => {
    test('CPU percent is reasonable', () => {
      const metrics = getCurrentMetrics()
      expect(metrics.cpu).toBeGreaterThanOrEqual(0)
      expect(metrics.cpu).toBeLessThanOrEqual(100)
    })

    test('memory percentages are consistent', () => {
      const metrics = getCurrentMetrics()
      const total = metrics.memory.total
      const used = metrics.memory.used
      const cache = metrics.memory.cache

      // used + cache should not exceed total (with some margin for timing)
      expect(used + cache).toBeLessThanOrEqual(total * 1.1) // Allow 10% margin for timing
    })
  })
})
