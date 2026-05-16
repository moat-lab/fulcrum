import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { createTestApp } from '../__tests__/fixtures/app'
import { setupTestEnv, type TestEnv } from '../__tests__/utils/env'
import { db, apps, deployments, repositories } from '../db'
import { nanoid } from 'nanoid'

// Stateful mock for docker-swarm. Defaults reproduce the docker-less production
// shape (empty arrays / empty strings), so tests in other files that happen to
// touch /logs while docker-swarm is mocked-out still observe the existing
// no-docker contract.
let mockStackServicesReturn: Array<{
  id: string
  name: string
  serviceName: string
  mode: string
  replicas: string
  image: string
  ports: string[]
}> = []
let mockServiceLogsReturn = ''

mock.module('../services/docker-swarm', () => ({
  stackServices: () => Promise.resolve(mockStackServicesReturn),
  serviceLogs: () => Promise.resolve(mockServiceLogsReturn),
  stackRemove: () => Promise.resolve({ success: true }),
}))

mock.module('../services/docker-compose', () => ({
  checkDockerInstalled: () => Promise.resolve(true),
  checkDockerRunning: () => Promise.resolve(true),
  composeBuild: () => Promise.resolve({ success: true, output: '' }),
}))

describe('GET /api/apps/:id/logs', () => {
  let testEnv: TestEnv
  let repoId: string
  let appId: string

  beforeEach(() => {
    mockStackServicesReturn = []
    mockServiceLogsReturn = ''

    testEnv = setupTestEnv()

    const now = new Date().toISOString()
    repoId = nanoid()
    db.insert(repositories)
      .values({
        id: repoId,
        path: '/tmp/test-repo',
        displayName: 'test-repo',
        createdAt: now,
        updatedAt: now,
      })
      .run()

    appId = nanoid()
    db.insert(apps)
      .values({
        id: appId,
        name: 'Test App',
        repositoryId: repoId,
        branch: 'main',
        composeFile: 'compose.yml',
        status: 'running',
        autoDeployEnabled: false,
        createdAt: now,
        updatedAt: now,
      })
      .run()
  })

  afterEach(() => {
    testEnv.cleanup()
  })

  function seedDeployment(buildLogs: string, createdAt?: string) {
    const ts = createdAt ?? new Date().toISOString()
    db.insert(deployments)
      .values({
        id: nanoid(),
        appId,
        status: 'running',
        buildLogs,
        startedAt: ts,
        createdAt: ts,
      })
      .run()
  }

  test('swarm empty + deployment present → returns buildLogs', async () => {
    seedDeployment('line1\nline2\nline3')

    const { get } = createTestApp()
    const res = await get(`/api/apps/${appId}/logs`)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.logs).toBe('line1\nline2\nline3')
  })

  test('swarm non-empty wins (no fallback)', async () => {
    mockStackServicesReturn = [
      {
        id: 'svc-1',
        name: 'test-repo_web',
        serviceName: 'web',
        mode: 'replicated',
        replicas: '1/1',
        image: 'nginx',
        ports: [],
      },
    ]
    mockServiceLogsReturn = 'swarm-live-output'
    seedDeployment('stale-build-logs-should-not-appear')

    const { get } = createTestApp()
    const res = await get(`/api/apps/${appId}/logs`)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.logs).toContain('swarm-live-output')
    expect(body.logs).not.toContain('stale-build-logs-should-not-appear')
  })

  test('swarm empty + no deployment → empty string (current contract preserved)', async () => {
    const { get } = createTestApp()
    const res = await get(`/api/apps/${appId}/logs`)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.logs).toBe('')
  })

  test('?tail=2 truncates fallback to last 2 lines', async () => {
    seedDeployment('a\nb\nc\nd\ne')

    const { get } = createTestApp()
    const res = await get(`/api/apps/${appId}/logs?tail=2`)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.logs).toBe('d\ne')
  })

  test('?service=<name> falls back when swarm empty', async () => {
    // service param keeps swarm path but with serviceLogs only; mock returns
    // empty so the route falls back to deployments.buildLogs.
    seedDeployment('compose: deploy success\ncompose: starting web\ncompose: ready')

    const { get } = createTestApp()
    const res = await get(`/api/apps/${appId}/logs?service=web`)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.logs).toContain('compose: deploy success')
  })

  test('multi-deployment → returns the one with latest createdAt', async () => {
    seedDeployment('OLD-deployment-logs', '2026-01-01T00:00:00.000Z')
    seedDeployment('NEW-deployment-logs', '2026-05-01T00:00:00.000Z')
    seedDeployment('MIDDLE-deployment-logs', '2026-03-01T00:00:00.000Z')

    const { get } = createTestApp()
    const res = await get(`/api/apps/${appId}/logs`)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.logs).toBe('NEW-deployment-logs')
  })

  test('returns 404 for non-existent app', async () => {
    const { get } = createTestApp()
    const res = await get('/api/apps/nonexistent/logs')

    expect(res.status).toBe(404)
  })
})
