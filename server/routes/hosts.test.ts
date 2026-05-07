import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'

// Mock ssh2 native module FIRST to prevent libuv crash in Bun
// Uses the same MockClient as ssh-connection-manager.test.ts
mock.module('ssh2', () => ({
  Client: class {
    _sock = { destroyed: false, writable: true }
    _handlers = new Map()
    on(event: string, handler: (...args: unknown[]) => void) {
      this._handlers.set(event, handler)
      return this
    }
    connect() {
      const ready = this._handlers.get('ready')
      if (ready) setTimeout(() => ready(), 0)
    }
    end() {}
    exec(cmd: string, cb: (err: Error | null, stream: unknown) => void) {
      const stream = {
        on(e: string, h: (...a: unknown[]) => void) {
          if (e === 'data') setTimeout(() => h(Buffer.from('ok')), 0)
          if (e === 'close') setTimeout(() => h(0), 5)
          return stream
        },
        stderr: { on() { return this } },
      }
      cb(null, stream)
    }
    shell(opts: unknown, cb: (err: Error | null, stream: unknown) => void) {
      cb(null, { on() { return this }, write() {}, close() {}, stderr: { on() { return this } }, setWindow() {} })
    }
  },
}))

import { setupTestEnv, type TestEnv } from '../__tests__/utils/env'
import { createTestApp } from '../__tests__/fixtures/app'
import { db, hosts } from '../db'
import { eq } from 'drizzle-orm'

describe('Hosts API', () => {
  let testEnv: TestEnv

  beforeEach(() => {
    testEnv = setupTestEnv()
  })

  afterEach(() => {
    testEnv.cleanup()
  })

  function insertTestHost(overrides?: Partial<typeof hosts.$inferInsert>) {
    const now = new Date().toISOString()
    const data = {
      id: crypto.randomUUID(),
      name: 'test-host',
      hostname: '192.168.1.100',
      port: 22,
      username: 'testuser',
      authMethod: 'key',
      privateKeyPath: '/home/testuser/.ssh/id_ed25519',
      status: 'unknown',
      createdAt: now,
      updatedAt: now,
      ...overrides,
    }
    db.insert(hosts).values(data).run()
    return data
  }

  describe('GET /api/hosts', () => {
    test('returns empty list when no hosts', async () => {
      const { get } = createTestApp()
      const res = await get('/api/hosts')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual([])
    })

    test('returns all hosts', async () => {
      insertTestHost({ name: 'host-1', hostname: '10.0.0.1' })
      insertTestHost({ name: 'host-2', hostname: '10.0.0.2' })

      const { get } = createTestApp()
      const res = await get('/api/hosts')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toHaveLength(2)
      expect(body.map((h: { name: string }) => h.name).sort()).toEqual(['host-1', 'host-2'])
    })
  })

  describe('GET /api/hosts/:id', () => {
    test('returns host by id', async () => {
      const host = insertTestHost({ name: 'my-server' })

      const { get } = createTestApp()
      const res = await get(`/api/hosts/${host.id}`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.name).toBe('my-server')
      expect(body.hostname).toBe('192.168.1.100')
      expect(body.port).toBe(22)
      expect(body.username).toBe('testuser')
      expect(body.authMethod).toBe('key')
    })

    test('returns 404 for non-existent host', async () => {
      const { get } = createTestApp()
      const res = await get('/api/hosts/non-existent')
      expect(res.status).toBe(404)
    })
  })

  describe('POST /api/hosts', () => {
    test('creates host with required fields', async () => {
      const { post } = createTestApp()
      const res = await post('/api/hosts', {
        name: 'new-host',
        hostname: '10.0.0.5',
        username: 'admin',
      })
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.id).toBeDefined()
      expect(body.name).toBe('new-host')
      expect(body.hostname).toBe('10.0.0.5')
      expect(body.username).toBe('admin')
      expect(body.port).toBe(22)
      expect(body.authMethod).toBe('key')
      expect(body.status).toBe('unknown')
    })

    test('creates host with all fields', async () => {
      const { post } = createTestApp()
      const res = await post('/api/hosts', {
        name: 'full-host',
        hostname: '10.0.0.6',
        port: 2222,
        username: 'deploy',
        authMethod: 'password',
        password: 'secret-password',
        defaultDirectory: '/opt/work',
        fulcrumUrl: 'http://192.168.1.1:7777',
      })
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.port).toBe(2222)
      expect(body.authMethod).toBe('password')
      expect(body.password).toBe('••••••••')
      expect(body.defaultDirectory).toBe('/opt/work')
      expect(body.fulcrumUrl).toBe('http://192.168.1.1:7777')
      const saved = db.select().from(hosts).where(eq(hosts.id, body.id)).get()
      expect(saved!.password).toBe('secret-password')
    })

    test('returns 400 when required fields missing', async () => {
      const { post } = createTestApp()
      const res = await post('/api/hosts', { name: 'incomplete' })
      expect(res.status).toBe(400)
    })
  })

  describe('PATCH /api/hosts/:id', () => {
    test('updates host fields', async () => {
      const host = insertTestHost()
      const { patch } = createTestApp()

      const res = await patch(`/api/hosts/${host.id}`, {
        name: 'updated-host',
        port: 2222,
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.name).toBe('updated-host')
      expect(body.port).toBe(2222)
      // Unchanged fields preserved
      expect(body.hostname).toBe('192.168.1.100')
    })

    test('returns 404 for non-existent host', async () => {
      const { patch } = createTestApp()
      const res = await patch('/api/hosts/non-existent', { name: 'x' })
      expect(res.status).toBe(404)
    })
  })

  describe('DELETE /api/hosts/:id', () => {
    test('deletes host', async () => {
      const host = insertTestHost()
      const { delete: del, get } = createTestApp()

      const res = await del(`/api/hosts/${host.id}`)
      expect(res.status).toBe(200)

      const checkRes = await get(`/api/hosts/${host.id}`)
      expect(checkRes.status).toBe(404)
    })

    test('clears hostId from tasks when host deleted', async () => {
      const host = insertTestHost()

      // Insert a task with this hostId
      const now = new Date().toISOString()
      const { tasks } = await import('../db')
      db.insert(tasks).values({
        id: 'test-task-1',
        title: 'Remote Task',
        status: 'IN_PROGRESS',
        position: 0,
        agent: 'claude',
        hostId: host.id,
        createdAt: now,
        updatedAt: now,
      }).run()

      const { delete: del } = createTestApp()
      await del(`/api/hosts/${host.id}`)

      // Task should have hostId cleared
      const task = db.select().from(tasks).where(eq(tasks.id, 'test-task-1')).get()
      expect(task).toBeDefined()
      expect(task!.hostId).toBeNull()
    })

    test('returns 404 for non-existent host', async () => {
      const { delete: del } = createTestApp()
      const res = await del('/api/hosts/non-existent')
      expect(res.status).toBe(404)
    })
  })

  describe('POST /api/hosts/:id/test', () => {
    test('tests SSH connection and updates status', async () => {
      // Create a temp key file so readFileSync succeeds
      const keyPath = `${testEnv.fulcrumDir}/test_key`
      const { writeFileSync } = await import('fs')
      writeFileSync(keyPath, 'mock-private-key')
      const host = insertTestHost({ privateKeyPath: keyPath })
      const { post } = createTestApp()

      const res = await post(`/api/hosts/${host.id}/test`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.success).toBe(true)
      expect(body.latencyMs).toBeGreaterThanOrEqual(0)

      // Status should be updated in DB
      const updated = db.select().from(hosts).where(eq(hosts.id, host.id)).get()
      expect(updated!.status).toBe('connected')
      expect(updated!.lastConnectedAt).toBeDefined()
    })

    test('returns 404 for non-existent host', async () => {
      const { post } = createTestApp()
      const res = await post('/api/hosts/non-existent/test')
      expect(res.status).toBe(404)
    })
  })
})
