import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createTestApp } from '../__tests__/fixtures/app'
import { setupTestEnv, type TestEnv } from '../__tests__/utils/env'
import { createTestGitRepo } from '../__tests__/fixtures/git'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

describe('Filesystem Routes', () => {
  let testEnv: TestEnv
  let tempDir: string

  beforeEach(() => {
    testEnv = setupTestEnv()
    tempDir = mkdtempSync(join(tmpdir(), 'fs-test-'))
  })

  afterEach(() => {
    testEnv.cleanup()
    rmSync(tempDir, { recursive: true, force: true })
  })

  describe('GET /api/fs/list', () => {
    test('lists directory contents', async () => {
      // Create some files and directories
      mkdirSync(join(tempDir, 'subdir'))
      writeFileSync(join(tempDir, 'file.txt'), 'test content')

      const { get } = createTestApp()
      const res = await get(`/api/fs/list?path=${tempDir}`)
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.path).toBe(tempDir)
      expect(body.entries).toBeInstanceOf(Array)

      const dirEntry = body.entries.find((e: { name: string }) => e.name === 'subdir')
      expect(dirEntry).toBeDefined()
      expect(dirEntry.type).toBe('directory')

      const fileEntry = body.entries.find((e: { name: string }) => e.name === 'file.txt')
      expect(fileEntry).toBeDefined()
      expect(fileEntry.type).toBe('file')
    })

    test('returns parent path', async () => {
      const subdir = join(tempDir, 'subdir')
      mkdirSync(subdir)

      const { get } = createTestApp()
      const res = await get(`/api/fs/list?path=${subdir}`)
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.parent).toBe(tempDir)
    })

    test('defaults to home directory when no path provided', async () => {
      const { get } = createTestApp()
      const res = await get('/api/fs/list')
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.path).toBe(homedir())
    })

    test('expands tilde to home directory', async () => {
      const { get } = createTestApp()
      const res = await get('/api/fs/list?path=~')
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.path).toBe(homedir())
    })

    test('returns 404 for non-existent path', async () => {
      const { get } = createTestApp()
      const res = await get('/api/fs/list?path=/nonexistent/path')
      const body = await res.json()

      expect(res.status).toBe(404)
      expect(body.error).toContain('does not exist')
    })

    test('returns 400 for file path instead of directory', async () => {
      const filePath = join(tempDir, 'file.txt')
      writeFileSync(filePath, 'content')

      const { get } = createTestApp()
      const res = await get(`/api/fs/list?path=${filePath}`)
      const body = await res.json()

      expect(res.status).toBe(400)
      expect(body.error).toContain('not a directory')
    })

    test('skips hidden files', async () => {
      writeFileSync(join(tempDir, '.hidden'), 'hidden')
      writeFileSync(join(tempDir, 'visible.txt'), 'visible')

      const { get } = createTestApp()
      const res = await get(`/api/fs/list?path=${tempDir}`)
      const body = await res.json()

      expect(res.status).toBe(200)
      const hiddenEntry = body.entries.find((e: { name: string }) => e.name === '.hidden')
      expect(hiddenEntry).toBeUndefined()

      const visibleEntry = body.entries.find((e: { name: string }) => e.name === 'visible.txt')
      expect(visibleEntry).toBeDefined()
    })

    test('identifies git repositories', async () => {
      const gitRepoDir = join(tempDir, 'git-repo')
      mkdirSync(gitRepoDir)
      mkdirSync(join(gitRepoDir, '.git'))

      const { get } = createTestApp()
      const res = await get(`/api/fs/list?path=${tempDir}`)
      const body = await res.json()

      expect(res.status).toBe(200)
      const repoEntry = body.entries.find((e: { name: string }) => e.name === 'git-repo')
      expect(repoEntry).toBeDefined()
      expect(repoEntry.isGitRepo).toBe(true)
    })

    test('sorts directories before files', async () => {
      writeFileSync(join(tempDir, 'aaa-file.txt'), '')
      mkdirSync(join(tempDir, 'zzz-dir'))

      const { get } = createTestApp()
      const res = await get(`/api/fs/list?path=${tempDir}`)
      const body = await res.json()

      expect(res.status).toBe(200)
      // Directory should come before file even though it sorts later alphabetically
      const dirIndex = body.entries.findIndex((e: { name: string }) => e.name === 'zzz-dir')
      const fileIndex = body.entries.findIndex((e: { name: string }) => e.name === 'aaa-file.txt')
      expect(dirIndex).toBeLessThan(fileIndex)
    })
  })

  describe('GET /api/fs/tree', () => {
    test('returns directory tree', async () => {
      mkdirSync(join(tempDir, 'level1'))
      mkdirSync(join(tempDir, 'level1', 'level2'))
      writeFileSync(join(tempDir, 'level1', 'level2', 'file.txt'), 'content')

      const { get } = createTestApp()
      const res = await get(`/api/fs/tree?root=${tempDir}`)
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.root).toBe(tempDir)
      expect(body.entries).toBeInstanceOf(Array)

      const level1 = body.entries.find((e: { name: string }) => e.name === 'level1')
      expect(level1).toBeDefined()
      expect(level1.type).toBe('directory')
      expect(level1.children).toBeInstanceOf(Array)

      const level2 = level1.children.find((e: { name: string }) => e.name === 'level2')
      expect(level2).toBeDefined()
    })

    test('returns 400 when root parameter is missing', async () => {
      const { get } = createTestApp()
      const res = await get('/api/fs/tree')
      const body = await res.json()

      expect(res.status).toBe(400)
      expect(body.error).toContain('root parameter is required')
    })

    test('returns 404 for non-existent root', async () => {
      const { get } = createTestApp()
      const res = await get('/api/fs/tree?root=/nonexistent/path')
      const body = await res.json()

      expect(res.status).toBe(404)
      expect(body.error).toContain('does not exist')
    })

    test('returns 400 for file path as root', async () => {
      const filePath = join(tempDir, 'file.txt')
      writeFileSync(filePath, 'content')

      const { get } = createTestApp()
      const res = await get(`/api/fs/tree?root=${filePath}`)
      const body = await res.json()

      expect(res.status).toBe(400)
      expect(body.error).toContain('not a directory')
    })

    test('excludes node_modules directory', async () => {
      mkdirSync(join(tempDir, 'node_modules'))
      writeFileSync(join(tempDir, 'node_modules', 'package.json'), '{}')
      mkdirSync(join(tempDir, 'src'))

      const { get } = createTestApp()
      const res = await get(`/api/fs/tree?root=${tempDir}`)
      const body = await res.json()

      expect(res.status).toBe(200)
      const nodeModules = body.entries.find((e: { name: string }) => e.name === 'node_modules')
      expect(nodeModules).toBeUndefined()

      const src = body.entries.find((e: { name: string }) => e.name === 'src')
      expect(src).toBeDefined()
    })
  })

  describe('GET /api/fs/read', () => {
    test('reads file content', async () => {
      writeFileSync(join(tempDir, 'test.txt'), 'Hello, World!')

      const { get } = createTestApp()
      const res = await get(`/api/fs/read?path=test.txt&root=${tempDir}`)
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.content).toBe('Hello, World!')
      expect(body.mimeType).toBe('text/plain')
      expect(body.truncated).toBe(false)
    })

    test('returns correct mime type for TypeScript', async () => {
      writeFileSync(join(tempDir, 'test.ts'), 'const x = 1')

      const { get } = createTestApp()
      const res = await get(`/api/fs/read?path=test.ts&root=${tempDir}`)
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.mimeType).toBe('text/typescript')
    })

    test('returns correct mime type for JSON', async () => {
      writeFileSync(join(tempDir, 'test.json'), '{"key": "value"}')

      const { get } = createTestApp()
      const res = await get(`/api/fs/read?path=test.json&root=${tempDir}`)
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.mimeType).toBe('application/json')
    })

    test('truncates large files', async () => {
      // Create file with more than 5 lines
      const content = Array(10).fill('Line').join('\n')
      writeFileSync(join(tempDir, 'large.txt'), content)

      const { get } = createTestApp()
      const res = await get(`/api/fs/read?path=large.txt&root=${tempDir}&maxLines=5`)
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.truncated).toBe(true)
      expect(body.lineCount).toBe(10)
    })

    test('returns 400 when path parameter is missing', async () => {
      const { get } = createTestApp()
      const res = await get(`/api/fs/read?root=${tempDir}`)
      const body = await res.json()

      expect(res.status).toBe(400)
      expect(body.error).toContain('path parameter is required')
    })

    test('returns 400 when root parameter is missing', async () => {
      const { get } = createTestApp()
      const res = await get('/api/fs/read?path=test.txt')
      const body = await res.json()

      expect(res.status).toBe(400)
      expect(body.error).toContain('root parameter is required')
    })

    test('returns 404 for non-existent file', async () => {
      const { get } = createTestApp()
      const res = await get(`/api/fs/read?path=nonexistent.txt&root=${tempDir}`)
      const body = await res.json()

      expect(res.status).toBe(404)
      expect(body.error).toContain('not found')
    })

    test('returns 400 for directory instead of file', async () => {
      mkdirSync(join(tempDir, 'subdir'))

      const { get } = createTestApp()
      const res = await get(`/api/fs/read?path=subdir&root=${tempDir}`)
      const body = await res.json()

      expect(res.status).toBe(400)
      expect(body.error).toContain('not a file')
    })

    test('blocks path traversal attacks', async () => {
      const { get } = createTestApp()
      const res = await get(`/api/fs/read?path=../../../etc/passwd&root=${tempDir}`)
      const body = await res.json()

      expect(res.status).toBe(403)
      expect(body.error).toContain('Access denied')
    })

    test('reads image files as base64', async () => {
      // Create a minimal PNG file (1x1 pixel)
      const pngBuffer = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
        0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, // IDAT chunk
        0x54, 0x08, 0xd7, 0x63, 0xf8, 0xff, 0xff, 0x3f,
        0x00, 0x05, 0xfe, 0x02, 0xfe, 0xdc, 0xcc, 0x59,
        0xe7, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, // IEND chunk
        0x44, 0xae, 0x42, 0x60, 0x82
      ])
      writeFileSync(join(tempDir, 'test.png'), pngBuffer)

      const { get } = createTestApp()
      const res = await get(`/api/fs/read?path=test.png&root=${tempDir}`)
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.mimeType).toBe('image/png')
      expect(body.content).toMatch(/^data:image\/png;base64,/)
    })

    test('handles binary files', async () => {
      // Create a file with null bytes
      const binaryBuffer = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x00])
      writeFileSync(join(tempDir, 'binary.bin'), binaryBuffer)

      const { get } = createTestApp()
      const res = await get(`/api/fs/read?path=binary.bin&root=${tempDir}`)
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.mimeType).toBe('application/octet-stream')
      expect(body.content).toBe('')
    })

    test('returns mtime field as ISO string', async () => {
      writeFileSync(join(tempDir, 'test.txt'), 'content')

      const { get } = createTestApp()
      const res = await get(`/api/fs/read?path=test.txt&root=${tempDir}`)
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.mtime).toBeDefined()
      expect(typeof body.mtime).toBe('string')
      // Verify it's a valid ISO date string
      const date = new Date(body.mtime)
      expect(date.getTime()).not.toBeNaN()
    })
  })

  describe('GET /api/fs/image', () => {
    test('returns image as raw data', async () => {
      // Create a minimal PNG file
      const pngBuffer = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
        0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
        0x54, 0x08, 0xd7, 0x63, 0xf8, 0xff, 0xff, 0x3f,
        0x00, 0x05, 0xfe, 0x02, 0xfe, 0xdc, 0xcc, 0x59,
        0xe7, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
        0x44, 0xae, 0x42, 0x60, 0x82
      ])
      writeFileSync(join(tempDir, 'test.png'), pngBuffer)

      const { get } = createTestApp()
      const res = await get(`/api/fs/image?path=test.png&root=${tempDir}`)

      expect(res.status).toBe(200)
      expect(res.headers.get('Content-Type')).toBe('image/png')
      expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600')
    })

    test('returns 400 for non-image file', async () => {
      writeFileSync(join(tempDir, 'test.txt'), 'not an image')

      const { get } = createTestApp()
      const res = await get(`/api/fs/image?path=test.txt&root=${tempDir}`)
      const body = await res.json()

      expect(res.status).toBe(400)
      expect(body.error).toContain('Not an image file')
    })

    test('blocks path traversal', async () => {
      const { get } = createTestApp()
      const res = await get(`/api/fs/image?path=../../../etc/passwd&root=${tempDir}`)
      await res.json() // consume body

      expect(res.status).toBe(403)
    })
  })

  describe('GET /api/fs/file-stat', () => {
    test('returns file stats with mtime', async () => {
      writeFileSync(join(tempDir, 'test.txt'), 'content')

      const { get } = createTestApp()
      const res = await get(`/api/fs/file-stat?path=test.txt&root=${tempDir}`)
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.path).toBe('test.txt')
      expect(body.exists).toBe(true)
      expect(body.size).toBeGreaterThan(0)
      expect(body.mtime).toBeDefined()
      // Verify mtime is a valid ISO date string
      const date = new Date(body.mtime)
      expect(date.getTime()).not.toBeNaN()
    })

    test('returns exists: false for non-existent file', async () => {
      const { get } = createTestApp()
      const res = await get(`/api/fs/file-stat?path=nonexistent.txt&root=${tempDir}`)
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.exists).toBe(false)
      expect(body.mtime).toBe('')
      expect(body.size).toBe(0)
    })

    test('returns 400 when path is missing', async () => {
      const { get } = createTestApp()
      const res = await get(`/api/fs/file-stat?root=${tempDir}`)
      const body = await res.json()

      expect(res.status).toBe(400)
      expect(body.error).toContain('path parameter is required')
    })

    test('returns 400 when root is missing', async () => {
      const { get } = createTestApp()
      const res = await get('/api/fs/file-stat?path=test.txt')
      const body = await res.json()

      expect(res.status).toBe(400)
      expect(body.error).toContain('root parameter is required')
    })

    test('returns 400 for directory instead of file', async () => {
      mkdirSync(join(tempDir, 'subdir'))

      const { get } = createTestApp()
      const res = await get(`/api/fs/file-stat?path=subdir&root=${tempDir}`)
      const body = await res.json()

      expect(res.status).toBe(400)
      expect(body.error).toContain('not a file')
    })

    test('blocks path traversal attacks', async () => {
      const { get } = createTestApp()
      const res = await get(`/api/fs/file-stat?path=../../../etc/passwd&root=${tempDir}`)
      const body = await res.json()

      expect(res.status).toBe(403)
      expect(body.error).toContain('Access denied')
    })

    test('detects mtime changes after file modification', async () => {
      const filePath = join(tempDir, 'test.txt')
      writeFileSync(filePath, 'original')

      const { get } = createTestApp()
      const res1 = await get(`/api/fs/file-stat?path=test.txt&root=${tempDir}`)
      const body1 = await res1.json()
      const originalMtime = body1.mtime

      // Wait a bit and modify the file
      await new Promise((resolve) => setTimeout(resolve, 10))
      writeFileSync(filePath, 'modified content')

      const res2 = await get(`/api/fs/file-stat?path=test.txt&root=${tempDir}`)
      const body2 = await res2.json()

      expect(body2.mtime).not.toBe(originalMtime)
      expect(new Date(body2.mtime).getTime()).toBeGreaterThan(new Date(originalMtime).getTime())
    })
  })

  describe('POST /api/fs/write', () => {
    test('writes content to existing file', async () => {
      writeFileSync(join(tempDir, 'test.txt'), 'original')

      const { post } = createTestApp()
      const res = await post('/api/fs/write', {
        path: 'test.txt',
        root: tempDir,
        content: 'updated content',
      })
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.success).toBe(true)

      // Verify content was written
      const { readFileSync } = await import('node:fs')
      const content = readFileSync(join(tempDir, 'test.txt'), 'utf-8')
      expect(content).toBe('updated content')
    })

    test('returns 400 when path is missing', async () => {
      const { post } = createTestApp()
      const res = await post('/api/fs/write', {
        root: tempDir,
        content: 'test',
      })
      const body = await res.json()

      expect(res.status).toBe(400)
      expect(body.error).toContain('path is required')
    })

    test('returns 400 when root is missing', async () => {
      const { post } = createTestApp()
      const res = await post('/api/fs/write', {
        path: 'test.txt',
        content: 'test',
      })
      const body = await res.json()

      expect(res.status).toBe(400)
      expect(body.error).toContain('root is required')
    })

    test('returns 400 when content is missing', async () => {
      const { post } = createTestApp()
      const res = await post('/api/fs/write', {
        path: 'test.txt',
        root: tempDir,
      })
      const body = await res.json()

      expect(res.status).toBe(400)
      expect(body.error).toContain('content is required')
    })

    test('returns 404 for non-existent file', async () => {
      const { post } = createTestApp()
      const res = await post('/api/fs/write', {
        path: 'nonexistent.txt',
        root: tempDir,
        content: 'test',
      })
      const body = await res.json()

      expect(res.status).toBe(404)
      expect(body.error).toContain('not found')
    })

    test('blocks path traversal attacks', async () => {
      const { post } = createTestApp()
      const res = await post('/api/fs/write', {
        path: '../../../tmp/malicious.txt',
        root: tempDir,
        content: 'bad content',
      })
      const body = await res.json()

      expect(res.status).toBe(403)
      expect(body.error).toContain('Access denied')
    })
  })

  describe('POST /api/fs/upload', () => {
    function buildForm(opts: {
      filename?: string
      content?: Uint8Array | string
      mimeType?: string
      root?: string
      targetDir?: string
      overwrite?: string
      omitFile?: boolean
    }): FormData {
      const form = new FormData()
      if (!opts.omitFile) {
        const data: BlobPart =
          opts.content === undefined
            ? new Uint8Array([1, 2, 3, 4])
            : typeof opts.content === 'string'
              ? opts.content
              : new Uint8Array(opts.content)
        const blob = new Blob([data], { type: opts.mimeType ?? 'application/octet-stream' })
        form.append('file', blob, opts.filename ?? 'upload.bin')
      }
      if (opts.root !== undefined) form.append('root', opts.root)
      if (opts.targetDir !== undefined) form.append('targetDir', opts.targetDir)
      if (opts.overwrite !== undefined) form.append('overwrite', opts.overwrite)
      return form
    }

    test('uploads a file to the worktree root', async () => {
      const { request } = createTestApp()
      const res = await request('/api/fs/upload', {
        method: 'POST',
        body: buildForm({
          filename: 'hello.txt',
          content: 'hello world',
          mimeType: 'text/plain',
          root: tempDir,
          targetDir: '',
        }),
      })
      const body = await res.json()

      expect(res.status).toBe(201)
      expect(body.path).toBe('hello.txt')
      expect(body.size).toBe('hello world'.length)
      expect(body.mtime).toBeDefined()
      expect(readFileSync(join(tempDir, 'hello.txt'), 'utf-8')).toBe('hello world')
    })

    test('uploads into a subdirectory', async () => {
      mkdirSync(join(tempDir, 'src'))
      const { request } = createTestApp()
      const res = await request('/api/fs/upload', {
        method: 'POST',
        body: buildForm({
          filename: 'a.bin',
          content: new Uint8Array([7, 8, 9]),
          root: tempDir,
          targetDir: 'src',
        }),
      })
      const body = await res.json()

      expect(res.status).toBe(201)
      expect(body.path).toBe(join('src', 'a.bin'))
      expect(existsSync(join(tempDir, 'src', 'a.bin'))).toBe(true)
    })

    test('preserves binary contents', async () => {
      // Avoid leading 0x00 — Bun's multipart parser treats it as termination in the
      // Blob→FormData roundtrip used here. Real browser uploads aren't affected.
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0x10, 0x80, 0x7f])
      const { request } = createTestApp()
      const res = await request('/api/fs/upload', {
        method: 'POST',
        body: buildForm({
          filename: 'blob.bin',
          content: bytes,
          root: tempDir,
          targetDir: '',
        }),
      })
      expect(res.status).toBe(201)

      const written = readFileSync(join(tempDir, 'blob.bin'))
      expect(written.length).toBe(bytes.length)
      for (let i = 0; i < bytes.length; i++) {
        expect(written[i]).toBe(bytes[i])
      }
    })

    test('returns 409 when file already exists without overwrite', async () => {
      writeFileSync(join(tempDir, 'existing.txt'), 'old')
      const { request } = createTestApp()
      const res = await request('/api/fs/upload', {
        method: 'POST',
        body: buildForm({
          filename: 'existing.txt',
          content: 'new',
          root: tempDir,
          targetDir: '',
        }),
      })
      const body = await res.json()

      expect(res.status).toBe(409)
      expect(body.conflict).toBe(true)
      expect(body.path).toBe('existing.txt')
      expect(readFileSync(join(tempDir, 'existing.txt'), 'utf-8')).toBe('old')
    })

    test('overwrites when overwrite=true', async () => {
      writeFileSync(join(tempDir, 'existing.txt'), 'old')
      const { request } = createTestApp()
      const res = await request('/api/fs/upload', {
        method: 'POST',
        body: buildForm({
          filename: 'existing.txt',
          content: 'new',
          root: tempDir,
          targetDir: '',
          overwrite: 'true',
        }),
      })

      expect(res.status).toBe(201)
      expect(readFileSync(join(tempDir, 'existing.txt'), 'utf-8')).toBe('new')
    })

    test('rejects targetDir traversal', async () => {
      const { request } = createTestApp()
      const res = await request('/api/fs/upload', {
        method: 'POST',
        body: buildForm({
          filename: 'evil.txt',
          content: 'pwn',
          root: tempDir,
          targetDir: '../../etc',
        }),
      })
      const body = await res.json()

      expect(res.status).toBe(403)
      expect(body.error).toContain('Access denied')
    })

    test('strips path components from filename', async () => {
      const { request } = createTestApp()
      const res = await request('/api/fs/upload', {
        method: 'POST',
        body: buildForm({
          filename: '../../passwd',
          content: 'x',
          root: tempDir,
          targetDir: '',
        }),
      })
      const body = await res.json()

      expect(res.status).toBe(201)
      expect(body.path).toBe('passwd')
      expect(existsSync(join(tempDir, 'passwd'))).toBe(true)
    })

    test('returns 413 when file exceeds max size', async () => {
      const big = new Uint8Array(51 * 1024 * 1024)
      const { request } = createTestApp()
      const res = await request('/api/fs/upload', {
        method: 'POST',
        body: buildForm({
          filename: 'big.bin',
          content: big,
          root: tempDir,
          targetDir: '',
        }),
      })
      const body = await res.json()

      expect(res.status).toBe(413)
      expect(body.error).toContain('too large')
    })

    test('returns 400 when file is missing', async () => {
      const { request } = createTestApp()
      const res = await request('/api/fs/upload', {
        method: 'POST',
        body: buildForm({ omitFile: true, root: tempDir, targetDir: '' }),
      })
      const body = await res.json()

      expect(res.status).toBe(400)
      expect(body.error).toContain('file is required')
    })

    test('returns 400 when root is missing', async () => {
      const { request } = createTestApp()
      const res = await request('/api/fs/upload', {
        method: 'POST',
        body: buildForm({ filename: 'a.txt', targetDir: '' }),
      })
      const body = await res.json()

      expect(res.status).toBe(400)
      expect(body.error).toContain('root is required')
    })

    test('returns 400 when targetDir is missing', async () => {
      const { request } = createTestApp()
      const res = await request('/api/fs/upload', {
        method: 'POST',
        body: buildForm({ filename: 'a.txt', root: tempDir }),
      })
      const body = await res.json()

      expect(res.status).toBe(400)
      expect(body.error).toContain('targetDir is required')
    })

    test('returns 400 when targetDir does not exist', async () => {
      const { request } = createTestApp()
      const res = await request('/api/fs/upload', {
        method: 'POST',
        body: buildForm({
          filename: 'a.txt',
          root: tempDir,
          targetDir: 'nope',
        }),
      })
      const body = await res.json()

      expect(res.status).toBe(400)
      expect(body.error).toContain('does not exist')
    })

    test('returns 400 when targetDir is a file', async () => {
      writeFileSync(join(tempDir, 'notadir'), 'x')
      const { request } = createTestApp()
      const res = await request('/api/fs/upload', {
        method: 'POST',
        body: buildForm({
          filename: 'a.txt',
          root: tempDir,
          targetDir: 'notadir',
        }),
      })
      const body = await res.json()

      expect(res.status).toBe(400)
      expect(body.error).toContain('not a directory')
    })

    test('returns 400 when uploaded file has no name', async () => {
      // Bun's multipart parser drops the filename for zero-byte / leading-null Blobs
      // in this Blob→FormData roundtrip; the handler must reject rather than crash.
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(0)]), 'unused.txt')
      form.append('root', tempDir)
      form.append('targetDir', '')

      const { request } = createTestApp()
      const res = await request('/api/fs/upload', { method: 'POST', body: form })
      const body = await res.json()

      expect(res.status).toBe(400)
      expect(body.error).toContain('file is required')
    })
  })

  describe('POST /api/fs/edit', () => {
    test('edits file successfully with single match', async () => {
      writeFileSync(join(tempDir, 'test.txt'), 'hello world')

      const { post } = createTestApp()
      const res = await post('/api/fs/edit', {
        path: 'test.txt',
        root: tempDir,
        old_string: 'hello',
        new_string: 'goodbye',
      })
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.success).toBe(true)
      expect(body.size).toBeGreaterThan(0)
      expect(body.mtime).toBeDefined()

      // Verify content was changed
      const { readFileSync } = await import('node:fs')
      const content = readFileSync(join(tempDir, 'test.txt'), 'utf-8')
      expect(content).toBe('goodbye world')
    })

    test('returns 400 when string not found', async () => {
      writeFileSync(join(tempDir, 'test.txt'), 'hello world')

      const { post } = createTestApp()
      const res = await post('/api/fs/edit', {
        path: 'test.txt',
        root: tempDir,
        old_string: 'nonexistent',
        new_string: 'replacement',
      })
      const body = await res.json()

      expect(res.status).toBe(400)
      expect(body.error).toContain('String not found in file')
    })

    test('returns 400 when string found multiple times', async () => {
      writeFileSync(join(tempDir, 'test.txt'), 'foo bar foo baz foo')

      const { post } = createTestApp()
      const res = await post('/api/fs/edit', {
        path: 'test.txt',
        root: tempDir,
        old_string: 'foo',
        new_string: 'qux',
      })
      const body = await res.json()

      expect(res.status).toBe(400)
      expect(body.error).toContain('found 3 times')
      expect(body.error).toContain('provide more context')
    })

    test('returns 400 when path is missing', async () => {
      const { post } = createTestApp()
      const res = await post('/api/fs/edit', {
        root: tempDir,
        old_string: 'foo',
        new_string: 'bar',
      })
      const body = await res.json()

      expect(res.status).toBe(400)
      expect(body.error).toContain('path is required')
    })

    test('returns 400 when root is missing', async () => {
      const { post } = createTestApp()
      const res = await post('/api/fs/edit', {
        path: 'test.txt',
        old_string: 'foo',
        new_string: 'bar',
      })
      const body = await res.json()

      expect(res.status).toBe(400)
      expect(body.error).toContain('root is required')
    })

    test('returns 400 when old_string is missing', async () => {
      const { post } = createTestApp()
      const res = await post('/api/fs/edit', {
        path: 'test.txt',
        root: tempDir,
        new_string: 'bar',
      })
      const body = await res.json()

      expect(res.status).toBe(400)
      expect(body.error).toContain('old_string is required')
    })

    test('returns 400 when new_string is missing', async () => {
      const { post } = createTestApp()
      const res = await post('/api/fs/edit', {
        path: 'test.txt',
        root: tempDir,
        old_string: 'foo',
      })
      const body = await res.json()

      expect(res.status).toBe(400)
      expect(body.error).toContain('new_string is required')
    })

    test('returns 403 for path traversal attempt', async () => {
      const { post } = createTestApp()
      const res = await post('/api/fs/edit', {
        path: '../../../etc/passwd',
        root: tempDir,
        old_string: 'foo',
        new_string: 'bar',
      })
      const body = await res.json()

      expect(res.status).toBe(403)
      expect(body.error).toContain('Access denied')
    })

    test('returns 404 for non-existent file', async () => {
      const { post } = createTestApp()
      const res = await post('/api/fs/edit', {
        path: 'nonexistent.txt',
        root: tempDir,
        old_string: 'foo',
        new_string: 'bar',
      })
      const body = await res.json()

      expect(res.status).toBe(404)
      expect(body.error).toContain('not found')
    })

    test('returns 400 for directory instead of file', async () => {
      mkdirSync(join(tempDir, 'subdir'))

      const { post } = createTestApp()
      const res = await post('/api/fs/edit', {
        path: 'subdir',
        root: tempDir,
        old_string: 'foo',
        new_string: 'bar',
      })
      const body = await res.json()

      expect(res.status).toBe(400)
      expect(body.error).toContain('not a file')
    })

    test('handles multiline replacements', async () => {
      writeFileSync(join(tempDir, 'test.txt'), 'line1\nline2\nline3')

      const { post } = createTestApp()
      const res = await post('/api/fs/edit', {
        path: 'test.txt',
        root: tempDir,
        old_string: 'line1\nline2',
        new_string: 'replaced\nmultiline',
      })
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.success).toBe(true)

      const { readFileSync } = await import('node:fs')
      const content = readFileSync(join(tempDir, 'test.txt'), 'utf-8')
      expect(content).toBe('replaced\nmultiline\nline3')
    })
  })

  describe('POST /api/fs/rename', () => {
    test('renames a file to a sibling name', async () => {
      writeFileSync(join(tempDir, 'old.txt'), 'hello')

      const { post } = createTestApp()
      const res = await post('/api/fs/rename', {
        path: 'old.txt',
        root: tempDir,
        newName: 'new.txt',
      })
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.success).toBe(true)
      expect(body.path).toBe('new.txt')
      expect(existsSync(join(tempDir, 'old.txt'))).toBe(false)
      expect(existsSync(join(tempDir, 'new.txt'))).toBe(true)
    })

    test('renames a file inside a subdirectory', async () => {
      mkdirSync(join(tempDir, 'sub'))
      writeFileSync(join(tempDir, 'sub', 'a.txt'), 'x')

      const { post } = createTestApp()
      const res = await post('/api/fs/rename', {
        path: 'sub/a.txt',
        root: tempDir,
        newName: 'b.txt',
      })
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.path).toBe(join('sub', 'b.txt'))
      expect(existsSync(join(tempDir, 'sub', 'b.txt'))).toBe(true)
    })

    test('rejects newName containing path separator', async () => {
      writeFileSync(join(tempDir, 'a.txt'), 'x')

      const { post } = createTestApp()
      const res = await post('/api/fs/rename', {
        path: 'a.txt',
        root: tempDir,
        newName: '../b.txt',
      })
      const body = await res.json()

      expect(res.status).toBe(400)
      expect(body.error).toContain('plain file name')
    })

    test('returns 409 when target already exists', async () => {
      writeFileSync(join(tempDir, 'a.txt'), 'x')
      writeFileSync(join(tempDir, 'b.txt'), 'y')

      const { post } = createTestApp()
      const res = await post('/api/fs/rename', {
        path: 'a.txt',
        root: tempDir,
        newName: 'b.txt',
      })
      const body = await res.json()

      expect(res.status).toBe(409)
      expect(body.error).toContain('already exists')
    })

    test('returns 404 when source does not exist', async () => {
      const { post } = createTestApp()
      const res = await post('/api/fs/rename', {
        path: 'missing.txt',
        root: tempDir,
        newName: 'other.txt',
      })

      expect(res.status).toBe(404)
    })

    test('blocks path traversal in source path', async () => {
      const { post } = createTestApp()
      const res = await post('/api/fs/rename', {
        path: '../escape.txt',
        root: tempDir,
        newName: 'whatever.txt',
      })
      const body = await res.json()

      expect(res.status).toBe(403)
      expect(body.error).toContain('Access denied')
    })

    test('returns 400 when newName is missing', async () => {
      const { post } = createTestApp()
      const res = await post('/api/fs/rename', {
        path: 'a.txt',
        root: tempDir,
      })

      expect(res.status).toBe(400)
    })
  })

  describe('POST /api/fs/delete', () => {
    test('deletes a file', async () => {
      writeFileSync(join(tempDir, 'gone.txt'), 'bye')

      const { post } = createTestApp()
      const res = await post('/api/fs/delete', {
        path: 'gone.txt',
        root: tempDir,
      })
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.success).toBe(true)
      expect(existsSync(join(tempDir, 'gone.txt'))).toBe(false)
    })

    test('refuses to delete a directory', async () => {
      mkdirSync(join(tempDir, 'adir'))

      const { post } = createTestApp()
      const res = await post('/api/fs/delete', {
        path: 'adir',
        root: tempDir,
      })
      const body = await res.json()

      expect(res.status).toBe(400)
      expect(body.error).toContain('not a file')
      expect(existsSync(join(tempDir, 'adir'))).toBe(true)
    })

    test('returns 404 for missing file', async () => {
      const { post } = createTestApp()
      const res = await post('/api/fs/delete', {
        path: 'nope.txt',
        root: tempDir,
      })

      expect(res.status).toBe(404)
    })

    test('blocks path traversal', async () => {
      const { post } = createTestApp()
      const res = await post('/api/fs/delete', {
        path: '../../etc/passwd',
        root: tempDir,
      })
      const body = await res.json()

      expect(res.status).toBe(403)
      expect(body.error).toContain('Access denied')
    })
  })

  describe('GET /api/fs/download', () => {
    test('streams file as attachment', async () => {
      writeFileSync(join(tempDir, 'data.bin'), 'payload')

      const { get } = createTestApp()
      const res = await get(`/api/fs/download?path=data.bin&root=${tempDir}`)

      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('application/octet-stream')
      expect(res.headers.get('content-disposition')).toContain('attachment')
      expect(res.headers.get('content-disposition')).toContain('data.bin')
      const text = await res.text()
      expect(text).toBe('payload')
    })

    test('returns 404 for missing file', async () => {
      const { get } = createTestApp()
      const res = await get(`/api/fs/download?path=missing.bin&root=${tempDir}`)
      expect(res.status).toBe(404)
    })

    test('blocks path traversal', async () => {
      const { get } = createTestApp()
      const res = await get(`/api/fs/download?path=../escape.bin&root=${tempDir}`)
      const body = await res.json()
      expect(res.status).toBe(403)
      expect(body.error).toContain('Access denied')
    })

    test('returns 400 for directory', async () => {
      mkdirSync(join(tempDir, 'sub'))
      const { get } = createTestApp()
      const res = await get(`/api/fs/download?path=sub&root=${tempDir}`)
      const body = await res.json()
      expect(res.status).toBe(400)
      expect(body.error).toContain('not a file')
    })
  })

  describe('GET /api/fs/stat', () => {
    test('returns exists: true and isDirectory: true for directory', async () => {
      const subdir = join(tempDir, 'subdir')
      mkdirSync(subdir)

      const { get } = createTestApp()
      const res = await get(`/api/fs/stat?path=${subdir}`)
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.path).toBe(subdir)
      expect(body.exists).toBe(true)
      expect(body.type).toBe('directory')
      expect(body.isDirectory).toBe(true)
      expect(body.isFile).toBe(false)
    })

    test('returns exists: true and isFile: true for file', async () => {
      const filePath = join(tempDir, 'file.txt')
      writeFileSync(filePath, 'content')

      const { get } = createTestApp()
      const res = await get(`/api/fs/stat?path=${filePath}`)
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.path).toBe(filePath)
      expect(body.exists).toBe(true)
      expect(body.type).toBe('file')
      expect(body.isDirectory).toBe(false)
      expect(body.isFile).toBe(true)
    })

    test('returns exists: false for non-existent path', async () => {
      const { get } = createTestApp()
      const res = await get(`/api/fs/stat?path=${tempDir}/nonexistent`)
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.exists).toBe(false)
      expect(body.type).toBe(null)
      expect(body.isDirectory).toBe(false)
      expect(body.isFile).toBe(false)
    })

    test('expands tilde to home directory', async () => {
      const { get } = createTestApp()
      const res = await get('/api/fs/stat?path=~')
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.path).toBe(homedir())
      expect(body.exists).toBe(true)
      expect(body.isDirectory).toBe(true)
    })

    test('returns 400 when path is missing', async () => {
      const { get } = createTestApp()
      const res = await get('/api/fs/stat')
      const body = await res.json()

      expect(res.status).toBe(400)
      expect(body.error).toContain('path parameter is required')
    })
  })

  describe('GET /api/fs/is-git-repo', () => {
    test('returns true for git repository', async () => {
      const repo = createTestGitRepo()

      try {
        const { get } = createTestApp()
        const res = await get(`/api/fs/is-git-repo?path=${repo.path}`)
        const body = await res.json()

        expect(res.status).toBe(200)
        expect(body.isGitRepo).toBe(true)
        expect(body.path).toBe(repo.path)
      } finally {
        repo.cleanup()
      }
    })

    test('returns false for non-git directory', async () => {
      const { get } = createTestApp()
      const res = await get(`/api/fs/is-git-repo?path=${tempDir}`)
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.isGitRepo).toBe(false)
    })

    test('expands tilde path', async () => {
      const { get } = createTestApp()
      const res = await get('/api/fs/is-git-repo?path=~')
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.path).toBe(homedir())
    })

    test('returns 400 when path is missing', async () => {
      const { get } = createTestApp()
      const res = await get('/api/fs/is-git-repo')
      const body = await res.json()

      expect(res.status).toBe(400)
      expect(body.error).toContain('path parameter is required')
    })

    test('returns 404 for non-existent path', async () => {
      const { get } = createTestApp()
      const res = await get('/api/fs/is-git-repo?path=/nonexistent/path')
      const body = await res.json()

      expect(res.status).toBe(404)
      expect(body.error).toContain('does not exist')
    })

    test('returns 400 for file path', async () => {
      const filePath = join(tempDir, 'file.txt')
      writeFileSync(filePath, 'content')

      const { get } = createTestApp()
      const res = await get(`/api/fs/is-git-repo?path=${filePath}`)
      const body = await res.json()

      expect(res.status).toBe(400)
      expect(body.error).toContain('not a directory')
    })
  })
})
