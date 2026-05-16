import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { createTestGitRepo, type TestGitRepo } from '../__tests__/fixtures/git'
import { createTestApp } from '../__tests__/fixtures/app'
import { setupTestEnv, type TestEnv } from '../__tests__/utils/env'
import { db, apps, appServices, deployments, repositories } from '../db'
import { eq } from 'drizzle-orm'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { nanoid } from 'nanoid'

// Mock Docker checks to allow testing without Docker
mock.module('../services/docker-compose', () => ({
  checkDockerInstalled: () => Promise.resolve(true),
  checkDockerRunning: () => Promise.resolve(true),
  composeBuild: () => Promise.resolve({ success: true, output: '' }),
}))

// Mutable docker-swarm mock state so individual tests can simulate the
// "docker present + non-empty logs" and "docker absent" paths.
type SwarmService = { name: string; serviceName: string }
let mockStackServices: () => Promise<SwarmService[]> = () => Promise.resolve([])
let mockServiceLogs: (name: string, tail?: number) => Promise<string> =
  () => Promise.resolve('')
mock.module('../services/docker-swarm', () => ({
  stackServices: (name: string) => mockStackServices(),
  serviceLogs: (name: string, tail?: number) => mockServiceLogs(name, tail),
  stackRemove: () => Promise.resolve({ success: true }),
}))

describe('Apps Routes', () => {
  let testEnv: TestEnv
  let repo: TestGitRepo
  let repoId: string

  beforeEach(() => {
    testEnv = setupTestEnv()
    repo = createTestGitRepo()

    // Create a compose.yml in the test repo
    writeFileSync(
      join(repo.path, 'compose.yml'),
      `
services:
  web:
    image: nginx
    ports:
      - 80
  api:
    build: ./api
    ports:
      - 3000
`
    )

    // Create a repository record
    repoId = nanoid()
    const now = new Date().toISOString()
    db.insert(repositories)
      .values({
        id: repoId,
        path: repo.path,
        displayName: 'test-repo',
        createdAt: now,
        updatedAt: now,
      })
      .run()
  })

  afterEach(() => {
    repo.cleanup()
    testEnv.cleanup()
  })

  describe('GET /api/apps', () => {
    test('returns empty array when no apps exist', async () => {
      const { get } = createTestApp()
      const res = await get('/api/apps')
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body).toEqual([])
    })

    test('returns apps with their services', async () => {
      const now = new Date().toISOString()
      const appId = nanoid()

      // Insert test app
      db.insert(apps)
        .values({
          id: appId,
          name: 'Test App',
          repositoryId: repoId,
          branch: 'main',
          composeFile: 'compose.yml',
          status: 'stopped',
          autoDeployEnabled: false,
          createdAt: now,
          updatedAt: now,
        })
        .run()

      // Insert test services
      db.insert(appServices)
        .values([
          {
            id: nanoid(),
            appId,
            serviceName: 'web',
            containerPort: 80,
            exposed: true,
            domain: 'test.example.com',
            status: 'stopped',
            createdAt: now,
            updatedAt: now,
          },
          {
            id: nanoid(),
            appId,
            serviceName: 'api',
            containerPort: 3000,
            exposed: false,
            status: 'stopped',
            createdAt: now,
            updatedAt: now,
          },
        ])
        .run()

      const { get } = createTestApp()
      const res = await get('/api/apps')
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body).toHaveLength(1)
      expect(body[0].name).toBe('Test App')
      expect(body[0].services).toHaveLength(2)
      expect(body[0].repository.displayName).toBe('test-repo')
    })
  })

  describe('GET /api/apps/:id', () => {
    test('returns 404 for non-existent app', async () => {
      const { get } = createTestApp()
      const res = await get('/api/apps/nonexistent')
      const body = await res.json()

      expect(res.status).toBe(404)
      expect(body.error).toContain('not found')
    })

    test('returns app with services', async () => {
      const now = new Date().toISOString()
      const appId = nanoid()

      db.insert(apps)
        .values({
          id: appId,
          name: 'My App',
          repositoryId: repoId,
          branch: 'main',
          composeFile: 'compose.yml',
          status: 'running',
          autoDeployEnabled: true,
          environmentVariables: JSON.stringify({ NODE_ENV: 'production' }),
          createdAt: now,
          updatedAt: now,
        })
        .run()

      db.insert(appServices)
        .values({
          id: nanoid(),
          appId,
          serviceName: 'web',
          containerPort: 80,
          exposed: true,
          domain: 'app.example.com',
          status: 'running',
          createdAt: now,
          updatedAt: now,
        })
        .run()

      const { get } = createTestApp()
      const res = await get(`/api/apps/${appId}`)
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.id).toBe(appId)
      expect(body.name).toBe('My App')
      expect(body.status).toBe('running')
      expect(body.autoDeployEnabled).toBe(true)
      expect(body.environmentVariables).toEqual({ NODE_ENV: 'production' })
      expect(body.services).toHaveLength(1)
      expect(body.services[0].serviceName).toBe('web')
    })
  })

  describe('POST /api/apps', () => {
    test('creates app with valid data', async () => {
      const { post } = createTestApp()

      const res = await post('/api/apps', {
        name: 'New App',
        repositoryId: repoId,
        branch: 'main',
        services: [
          { serviceName: 'web', containerPort: 80, exposed: true, domain: 'new.example.com' },
          { serviceName: 'api', containerPort: 3000, exposed: false },
        ],
      })
      const body = await res.json()

      expect(res.status).toBe(201)
      expect(body.name).toBe('New App')
      expect(body.branch).toBe('main')
      expect(body.status).toBe('stopped')
      expect(body.composeFile).toBe('compose.yml')
      expect(body.services).toHaveLength(2)

      // Verify in database
      const dbApp = db.select().from(apps).where(eq(apps.id, body.id)).get()
      expect(dbApp).toBeDefined()
      expect(dbApp!.name).toBe('New App')
    })

    test('returns 400 for missing required fields', async () => {
      const { post } = createTestApp()

      const res = await post('/api/apps', {
        name: 'No Repo',
        // missing repositoryId
      })
      const body = await res.json()

      expect(res.status).toBe(400)
      expect(body.error).toContain('required')
    })

    test('returns 404 for non-existent repository', async () => {
      const { post } = createTestApp()

      const res = await post('/api/apps', {
        name: 'Bad Repo App',
        repositoryId: 'nonexistent-repo',
        services: [],
      })
      const body = await res.json()

      expect(res.status).toBe(404)
      expect(body.error).toContain('Repository not found')
    })

    test('creates app with environment variables', async () => {
      const { post } = createTestApp()

      const res = await post('/api/apps', {
        name: 'Env App',
        repositoryId: repoId,
        environmentVariables: {
          NODE_ENV: 'production',
          API_KEY: 'secret123',
        },
        services: [],
      })
      const body = await res.json()

      expect(res.status).toBe(201)
      expect(body.environmentVariables).toEqual({
        NODE_ENV: 'production',
        API_KEY: 'secret123',
      })
    })

    test('creates app with auto-deploy enabled', async () => {
      const { post } = createTestApp()

      const res = await post('/api/apps', {
        name: 'Auto Deploy App',
        repositoryId: repoId,
        autoDeployEnabled: true,
        services: [],
      })
      const body = await res.json()

      expect(res.status).toBe(201)
      expect(body.autoDeployEnabled).toBe(true)
    })

    test('auto-creates services from compose file when services array is empty', async () => {
      const { post } = createTestApp()

      const res = await post('/api/apps', {
        name: 'Auto Services App',
        repositoryId: repoId,
        services: [],
      })
      const body = await res.json()

      expect(res.status).toBe(201)
      expect(body.services).toHaveLength(2) // web + api from test compose.yml
      expect(body.services.map((s: { serviceName: string }) => s.serviceName).sort()).toEqual(['api', 'web'])
      expect(body.services.find((s: { serviceName: string }) => s.serviceName === 'web').containerPort).toBe(80)
      expect(body.services.find((s: { serviceName: string }) => s.serviceName === 'api').containerPort).toBe(3000)
    })
  })

  describe('PATCH /api/apps/:id', () => {
    let appId: string

    beforeEach(() => {
      const now = new Date().toISOString()
      appId = nanoid()

      db.insert(apps)
        .values({
          id: appId,
          name: 'Original Name',
          repositoryId: repoId,
          branch: 'main',
          composeFile: 'compose.yml',
          status: 'stopped',
          autoDeployEnabled: false,
          createdAt: now,
          updatedAt: now,
        })
        .run()

      db.insert(appServices)
        .values({
          id: nanoid(),
          appId,
          serviceName: 'web',
          containerPort: 80,
          exposed: false,
          status: 'stopped',
          createdAt: now,
          updatedAt: now,
        })
        .run()
    })

    test('updates app name', async () => {
      const { patch } = createTestApp()

      const res = await patch(`/api/apps/${appId}`, {
        name: 'Updated Name',
      })
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.name).toBe('Updated Name')

      // Verify in database
      const dbApp = db.select().from(apps).where(eq(apps.id, appId)).get()
      expect(dbApp!.name).toBe('Updated Name')
    })

    test('updates environment variables', async () => {
      const { patch } = createTestApp()

      const res = await patch(`/api/apps/${appId}`, {
        environmentVariables: { DATABASE_URL: 'postgres://localhost' },
      })
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.environmentVariables).toEqual({ DATABASE_URL: 'postgres://localhost' })
    })

    test('updates auto-deploy setting', async () => {
      const { patch } = createTestApp()

      const res = await patch(`/api/apps/${appId}`, {
        autoDeployEnabled: true,
      })
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.autoDeployEnabled).toBe(true)
    })

    test('updates service configuration', async () => {
      const { patch } = createTestApp()

      const res = await patch(`/api/apps/${appId}`, {
        services: [{ serviceName: 'web', containerPort: 8080, exposed: true, domain: 'web.example.com' }],
      })
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.services[0].containerPort).toBe(8080)
      expect(body.services[0].exposed).toBe(true)
      expect(body.services[0].domain).toBe('web.example.com')
    })

    test('returns 404 for non-existent app', async () => {
      const { patch } = createTestApp()

      const res = await patch('/api/apps/nonexistent', {
        name: 'New Name',
      })

      expect(res.status).toBe(404)
    })
  })

  describe('DELETE /api/apps/:id', () => {
    test('deletes app and its services', async () => {
      const now = new Date().toISOString()
      const appId = nanoid()

      db.insert(apps)
        .values({
          id: appId,
          name: 'To Delete',
          repositoryId: repoId,
          branch: 'main',
          composeFile: 'compose.yml',
          status: 'stopped',
          autoDeployEnabled: false,
          createdAt: now,
          updatedAt: now,
        })
        .run()

      db.insert(appServices)
        .values({
          id: nanoid(),
          appId,
          serviceName: 'web',
          containerPort: 80,
          exposed: false,
          status: 'stopped',
          createdAt: now,
          updatedAt: now,
        })
        .run()

      const { request } = createTestApp()
      const res = await request(`/api/apps/${appId}`, { method: 'DELETE' })
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.success).toBe(true)

      // Verify app is deleted
      const dbApp = db.select().from(apps).where(eq(apps.id, appId)).get()
      expect(dbApp).toBeUndefined()

      // Verify services are deleted
      const dbServices = db.select().from(appServices).where(eq(appServices.appId, appId)).all()
      expect(dbServices).toHaveLength(0)
    })

    test('returns 404 for non-existent app', async () => {
      const { request } = createTestApp()
      const res = await request('/api/apps/nonexistent', { method: 'DELETE' })

      expect(res.status).toBe(404)
    })
  })

  describe('POST /api/apps/:id/sync-services', () => {
    test('syncs services from compose file', async () => {
      const now = new Date().toISOString()
      const appId = nanoid()

      db.insert(apps)
        .values({
          id: appId,
          name: 'Sync Test',
          repositoryId: repoId,
          branch: 'main',
          composeFile: 'compose.yml',
          status: 'stopped',
          autoDeployEnabled: false,
          createdAt: now,
          updatedAt: now,
        })
        .run()

      // Add just one service initially
      db.insert(appServices)
        .values({
          id: nanoid(),
          appId,
          serviceName: 'web',
          containerPort: null, // No port set
          exposed: true,
          status: 'stopped',
          createdAt: now,
          updatedAt: now,
        })
        .run()

      const { post } = createTestApp()
      const res = await post(`/api/apps/${appId}/sync-services`)
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.success).toBe(true)
      expect(body.services).toHaveLength(2) // web + api from compose

      // Check web got its port updated
      const webService = body.services.find((s: { serviceName: string }) => s.serviceName === 'web')
      expect(webService.containerPort).toBe(80)

      // Check api was added
      const apiService = body.services.find((s: { serviceName: string }) => s.serviceName === 'api')
      expect(apiService).toBeDefined()
      expect(apiService.containerPort).toBe(3000)
    })

    test('returns 404 for non-existent app', async () => {
      const { post } = createTestApp()
      const res = await post('/api/apps/nonexistent/sync-services')

      expect(res.status).toBe(404)
    })
  })

  describe('GET /api/apps/:id/logs', () => {
    const seedAppOnly = (appId: string) => {
      const now = new Date().toISOString()
      db.insert(apps).values({
        id: appId,
        name: 'Logs App',
        repositoryId: repoId,
        branch: 'main',
        composeFile: 'compose.yml',
        status: 'running',
        autoDeployEnabled: false,
        createdAt: now,
        updatedAt: now,
      }).run()
    }

    const seedDeployment = (appId: string, buildLogs: string) => {
      const now = new Date().toISOString()
      db.insert(deployments).values({
        id: nanoid(),
        appId,
        status: 'running',
        gitCommit: 'test-commit',
        gitMessage: 'test',
        deployedBy: 'manual',
        buildLogs,
        startedAt: now,
        completedAt: now,
        createdAt: now,
      }).run()
    }

    beforeEach(() => {
      // Reset swarm mocks to "docker absent" baseline between tests
      mockStackServices = () => Promise.resolve([])
      mockServiceLogs = () => Promise.resolve('')
    })

    test('returns deployment buildLogs when docker swarm yields nothing', async () => {
      const appId = nanoid()
      seedAppOnly(appId)
      seedDeployment(appId, 'line-a\nline-b\nline-c')

      const { get } = createTestApp()
      const res = await get(`/api/apps/${appId}/logs`)
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.logs).toBe('line-a\nline-b\nline-c')
    })

    test('prefers docker swarm logs over deployment fallback when both exist', async () => {
      const appId = nanoid()
      seedAppOnly(appId)
      seedDeployment(appId, 'fallback-line')
      mockStackServices = () => Promise.resolve([
        { name: 'app_web', serviceName: 'web' },
      ])
      mockServiceLogs = () => Promise.resolve('swarm-line-1\nswarm-line-2')

      const { get } = createTestApp()
      const res = await get(`/api/apps/${appId}/logs`)
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.logs).toBe('=== web ===\nswarm-line-1\nswarm-line-2')
      expect(body.logs).not.toContain('fallback-line')
    })

    test('returns empty string when neither swarm nor deployments have logs', async () => {
      const appId = nanoid()
      seedAppOnly(appId)
      // No deployment row inserted

      const { get } = createTestApp()
      const res = await get(`/api/apps/${appId}/logs`)
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.logs).toBe('')
    })

    test('honors ?tail=N on the deployment fallback', async () => {
      const appId = nanoid()
      seedAppOnly(appId)
      seedDeployment(appId, ['l1', 'l2', 'l3', 'l4', 'l5'].join('\n'))

      const { get } = createTestApp()
      const res = await get(`/api/apps/${appId}/logs?tail=2`)
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.logs).toBe('l4\nl5')
    })

    test('?service=<name> falls back to deployment when swarm returns empty', async () => {
      const appId = nanoid()
      seedAppOnly(appId)
      seedDeployment(appId, 'service-fallback-line')

      const { get } = createTestApp()
      const res = await get(`/api/apps/${appId}/logs?service=web`)
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.logs).toBe('service-fallback-line')
    })

    test('reads the latest deployment when multiple exist', async () => {
      const appId = nanoid()
      seedAppOnly(appId)
      // Insert older + newer; newer should win
      const t0 = new Date(Date.now() - 60_000).toISOString()
      const t1 = new Date().toISOString()
      db.insert(deployments).values([
        {
          id: nanoid(),
          appId,
          status: 'running',
          gitCommit: 'old',
          gitMessage: 'old',
          deployedBy: 'manual',
          buildLogs: 'OLD',
          startedAt: t0,
          completedAt: t0,
          createdAt: t0,
        },
        {
          id: nanoid(),
          appId,
          status: 'running',
          gitCommit: 'new',
          gitMessage: 'new',
          deployedBy: 'manual',
          buildLogs: 'NEW',
          startedAt: t1,
          completedAt: t1,
          createdAt: t1,
        },
      ]).run()

      const { get } = createTestApp()
      const res = await get(`/api/apps/${appId}/logs`)
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.logs).toBe('NEW')
    })
  })
})
