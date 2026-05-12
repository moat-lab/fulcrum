import { Hono } from 'hono'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

interface DirectoryEntry {
  name: string
  type: 'file' | 'directory'
  isGitRepo: boolean
}

interface TreeEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: TreeEntry[]
}

interface FileReadResponse {
  content: string
  mimeType: string
  size: number
  lineCount: number
  truncated: boolean
  mtime: string
}

interface FileStatResponse {
  path: string
  mtime: string
  size: number
  exists: boolean
}

// Check if a directory is a git repository
function isGitRepo(dirPath: string): boolean {
  try {
    const gitDir = path.join(dirPath, '.git')
    return fs.existsSync(gitDir)
  } catch {
    return false
  }
}

// Check if path is within allowed root (path traversal protection)
function isPathWithinRoot(filePath: string, root: string): boolean {
  const resolvedPath = path.resolve(filePath)
  const resolvedRoot = path.resolve(root)
  return resolvedPath.startsWith(resolvedRoot + path.sep) || resolvedPath === resolvedRoot
}

const MAX_UPLOAD_SIZE = 50 * 1024 * 1024 // 50 MB
const MAX_FILENAME_LENGTH = 255

// Directories to exclude from tree traversal (large dependency/build directories)
const EXCLUDED_DIRECTORIES = new Set([
  'node_modules',
  'vendor',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '__pycache__',
  'target',
  '.venv',
  'venv',
  'env',
  '.tox',
  'coverage',
  '.cache',
  'bower_components',
])

// Build recursive directory tree
function buildTree(dirPath: string, root: string, depth: number = 0, maxDepth: number = 20): TreeEntry[] {
  if (depth >= maxDepth) return []

  const entries: TreeEntry[] = []

  try {
    const items = fs.readdirSync(dirPath)

    for (const name of items) {
      // Skip excluded directories (large dependency/build directories)
      if (EXCLUDED_DIRECTORIES.has(name)) continue

      try {
        const itemPath = path.join(dirPath, name)
        const relativePath = path.relative(root, itemPath)
        const itemStat = fs.statSync(itemPath)

        if (itemStat.isDirectory()) {
          entries.push({
            name,
            path: relativePath,
            type: 'directory',
            children: buildTree(itemPath, root, depth + 1, maxDepth),
          })
        } else if (itemStat.isFile()) {
          entries.push({
            name,
            path: relativePath,
            type: 'file',
          })
        }
      } catch {
        // Skip items we can't access
      }
    }
  } catch {
    // Return empty if can't read directory
  }

  // Sort: directories first, then alphabetically
  entries.sort((a, b) => {
    if (a.type === 'directory' && b.type === 'file') return -1
    if (a.type === 'file' && b.type === 'directory') return 1
    return a.name.localeCompare(b.name)
  })

  return entries
}

// Detect if content is binary
function isBinaryContent(buffer: Buffer): boolean {
  // Check first 8000 bytes for null bytes
  const checkLength = Math.min(buffer.length, 8000)
  for (let i = 0; i < checkLength; i++) {
    if (buffer[i] === 0) return true
  }
  return false
}

// Get MIME type from file extension
function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  const mimeTypes: Record<string, string> = {
    '.ts': 'text/typescript',
    '.tsx': 'text/typescript',
    '.js': 'text/javascript',
    '.jsx': 'text/javascript',
    '.json': 'application/json',
    '.md': 'text/markdown',
    '.css': 'text/css',
    '.html': 'text/html',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain',
    '.yaml': 'text/yaml',
    '.yml': 'text/yaml',
    '.toml': 'text/toml',
    '.sh': 'text/x-shellscript',
    '.py': 'text/x-python',
    '.rs': 'text/x-rust',
    '.go': 'text/x-go',
    '.sql': 'text/x-sql',
    '.pdf': 'application/pdf',
  }
  return mimeTypes[ext] || 'text/plain'
}

const app = new Hono()

// GET /api/fs/list?path=/home/user
app.get('/list', (c) => {
  let dirPath = c.req.query('path') || os.homedir()

  // Expand ~ to home directory
  if (dirPath === '~') {
    dirPath = os.homedir()
  } else if (dirPath.startsWith('~/')) {
    dirPath = path.join(os.homedir(), dirPath.slice(2))
  }

  // Resolve to absolute path
  dirPath = path.resolve(dirPath)

  try {
    if (!fs.existsSync(dirPath)) {
      return c.json({ error: 'Path does not exist' }, 404)
    }

    const stat = fs.statSync(dirPath)
    if (!stat.isDirectory()) {
      return c.json({ error: 'Path is not a directory' }, 400)
    }

    const entries: DirectoryEntry[] = []
    const items = fs.readdirSync(dirPath)

    for (const name of items) {
      // Skip hidden files/directories
      if (name.startsWith('.')) continue

      try {
        const itemPath = path.join(dirPath, name)
        const itemStat = fs.statSync(itemPath)

        if (itemStat.isDirectory()) {
          entries.push({
            name,
            type: 'directory',
            isGitRepo: isGitRepo(itemPath),
          })
        } else if (itemStat.isFile()) {
          entries.push({
            name,
            type: 'file',
            isGitRepo: false,
          })
        }
      } catch {
        // Skip items we can't access
      }
    }

    // Sort: directories first (git repos at top), then files
    entries.sort((a, b) => {
      if (a.type === 'directory' && b.type === 'file') return -1
      if (a.type === 'file' && b.type === 'directory') return 1
      if (a.type === 'directory' && b.type === 'directory') {
        if (a.isGitRepo && !b.isGitRepo) return -1
        if (!a.isGitRepo && b.isGitRepo) return 1
      }
      return a.name.localeCompare(b.name)
    })

    return c.json({
      path: dirPath,
      parent: path.dirname(dirPath),
      entries,
    })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to list directory' }, 500)
  }
})

// GET /api/fs/tree?root=/path/to/worktree
app.get('/tree', (c) => {
  const root = c.req.query('root')

  if (!root) {
    return c.json({ error: 'root parameter is required' }, 400)
  }

  const resolvedRoot = path.resolve(root)

  try {
    if (!fs.existsSync(resolvedRoot)) {
      return c.json({ error: 'Root path does not exist' }, 404)
    }

    const stat = fs.statSync(resolvedRoot)
    if (!stat.isDirectory()) {
      return c.json({ error: 'Root path is not a directory' }, 400)
    }

    const entries = buildTree(resolvedRoot, resolvedRoot)

    return c.json({
      root: resolvedRoot,
      entries,
    })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to build tree' }, 500)
  }
})

// GET /api/fs/read?path=/path/to/file&root=/worktree/root&maxLines=5000
app.get('/read', (c) => {
  const filePath = c.req.query('path')
  const root = c.req.query('root')
  const maxLines = parseInt(c.req.query('maxLines') || '5000', 10)

  if (!filePath) {
    return c.json({ error: 'path parameter is required' }, 400)
  }

  if (!root) {
    return c.json({ error: 'root parameter is required' }, 400)
  }

  const resolvedRoot = path.resolve(root)
  const resolvedPath = path.resolve(resolvedRoot, filePath)

  // Security: validate path is within root
  if (!isPathWithinRoot(resolvedPath, resolvedRoot)) {
    return c.json({ error: 'Access denied: path outside root' }, 403)
  }

  try {
    if (!fs.existsSync(resolvedPath)) {
      return c.json({ error: 'File not found' }, 404)
    }

    const stat = fs.statSync(resolvedPath)
    if (!stat.isFile()) {
      return c.json({ error: 'Path is not a file' }, 400)
    }

    const mimeType = getMimeType(resolvedPath)

    // Handle images - return as base64
    if (mimeType.startsWith('image/')) {
      const buffer = fs.readFileSync(resolvedPath)
      const base64 = buffer.toString('base64')
      return c.json({
        content: `data:${mimeType};base64,${base64}`,
        mimeType,
        size: stat.size,
        lineCount: 0,
        truncated: false,
        mtime: stat.mtime.toISOString(),
      } satisfies FileReadResponse)
    }

    // Handle PDFs - return metadata only (rendered via /api/fs/raw endpoint)
    if (mimeType === 'application/pdf') {
      return c.json({
        content: '',
        mimeType,
        size: stat.size,
        lineCount: 0,
        truncated: false,
        mtime: stat.mtime.toISOString(),
      } satisfies FileReadResponse)
    }

    // Read file content
    const buffer = fs.readFileSync(resolvedPath)

    // Check if binary
    if (isBinaryContent(buffer)) {
      return c.json({
        content: '',
        mimeType: 'application/octet-stream',
        size: stat.size,
        lineCount: 0,
        truncated: false,
        mtime: stat.mtime.toISOString(),
      } satisfies FileReadResponse)
    }

    // Text file
    const fullContent = buffer.toString('utf-8')
    const lines = fullContent.split('\n')
    const totalLines = lines.length
    const truncated = totalLines > maxLines
    const content = truncated ? lines.slice(0, maxLines).join('\n') : fullContent

    return c.json({
      content,
      mimeType,
      size: stat.size,
      lineCount: totalLines,
      truncated,
      mtime: stat.mtime.toISOString(),
    } satisfies FileReadResponse)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to read file' }, 500)
  }
})

// GET /api/fs/file-stat?path=/path/to/file&root=/worktree/root
// Returns file modification time without reading content (for change detection polling)
app.get('/file-stat', (c) => {
  const filePath = c.req.query('path')
  const root = c.req.query('root')

  if (!filePath) {
    return c.json({ error: 'path parameter is required' }, 400)
  }

  if (!root) {
    return c.json({ error: 'root parameter is required' }, 400)
  }

  const resolvedRoot = path.resolve(root)
  const resolvedPath = path.resolve(resolvedRoot, filePath)

  // Security: validate path is within root
  if (!isPathWithinRoot(resolvedPath, resolvedRoot)) {
    return c.json({ error: 'Access denied: path outside root' }, 403)
  }

  try {
    if (!fs.existsSync(resolvedPath)) {
      return c.json({
        path: filePath,
        mtime: '',
        size: 0,
        exists: false,
      } satisfies FileStatResponse)
    }

    const stat = fs.statSync(resolvedPath)
    if (!stat.isFile()) {
      return c.json({ error: 'Path is not a file' }, 400)
    }

    return c.json({
      path: filePath,
      mtime: stat.mtime.toISOString(),
      size: stat.size,
      exists: true,
    } satisfies FileStatResponse)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to stat file' }, 500)
  }
})

// GET /api/fs/image?path=/path/to/image&root=/worktree/root
// Returns raw image data with proper content-type (for use in <img> tags)
app.get('/image', (c) => {
  const filePath = c.req.query('path')
  const root = c.req.query('root')

  if (!filePath) {
    return c.json({ error: 'path parameter is required' }, 400)
  }

  if (!root) {
    return c.json({ error: 'root parameter is required' }, 400)
  }

  const resolvedRoot = path.resolve(root)
  const resolvedPath = path.resolve(resolvedRoot, filePath)

  // Security: validate path is within root
  if (!isPathWithinRoot(resolvedPath, resolvedRoot)) {
    return c.json({ error: 'Access denied: path outside root' }, 403)
  }

  try {
    if (!fs.existsSync(resolvedPath)) {
      return c.json({ error: 'File not found' }, 404)
    }

    const stat = fs.statSync(resolvedPath)
    if (!stat.isFile()) {
      return c.json({ error: 'Path is not a file' }, 400)
    }

    const mimeType = getMimeType(resolvedPath)

    // Only serve images
    if (!mimeType.startsWith('image/')) {
      return c.json({ error: 'Not an image file' }, 400)
    }

    const buffer = fs.readFileSync(resolvedPath)

    return new Response(buffer, {
      headers: {
        'Content-Type': mimeType,
        'Content-Length': buffer.length.toString(),
        'Cache-Control': 'public, max-age=3600',
      },
    })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to read image' }, 500)
  }
})

// Allowed MIME types for the raw endpoint
const RAW_ALLOWED_TYPES = new Set(['application/pdf'])

// GET /api/fs/raw?path=/path/to/file&root=/worktree/root
// Returns raw file data with proper content-type (for use in <iframe>, <embed>, etc.)
app.get('/raw', (c) => {
  const filePath = c.req.query('path')
  const root = c.req.query('root')

  if (!filePath) {
    return c.json({ error: 'path parameter is required' }, 400)
  }

  if (!root) {
    return c.json({ error: 'root parameter is required' }, 400)
  }

  const resolvedRoot = path.resolve(root)
  const resolvedPath = path.resolve(resolvedRoot, filePath)

  // Security: validate path is within root
  if (!isPathWithinRoot(resolvedPath, resolvedRoot)) {
    return c.json({ error: 'Access denied: path outside root' }, 403)
  }

  try {
    if (!fs.existsSync(resolvedPath)) {
      return c.json({ error: 'File not found' }, 404)
    }

    const stat = fs.statSync(resolvedPath)
    if (!stat.isFile()) {
      return c.json({ error: 'Path is not a file' }, 400)
    }

    const mimeType = getMimeType(resolvedPath)

    if (!RAW_ALLOWED_TYPES.has(mimeType)) {
      return c.json({ error: 'File type not supported for raw serving' }, 400)
    }

    const buffer = fs.readFileSync(resolvedPath)

    return new Response(buffer, {
      headers: {
        'Content-Type': mimeType,
        'Content-Disposition': `inline; filename="${path.basename(resolvedPath)}"`,
        'Content-Length': buffer.length.toString(),
        'Cache-Control': 'public, max-age=3600',
      },
    })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to read file' }, 500)
  }
})

// POST /api/fs/write
// Body: { path: string, root: string, content: string }
app.post('/write', async (c) => {
  const body = await c.req.json<{ path?: string; root?: string; content?: string; create?: boolean }>()
  const { path: filePath, root, content, create } = body

  if (!filePath) {
    return c.json({ error: 'path is required' }, 400)
  }

  if (!root) {
    return c.json({ error: 'root is required' }, 400)
  }

  if (content === undefined) {
    return c.json({ error: 'content is required' }, 400)
  }

  const resolvedRoot = path.resolve(root)
  const resolvedPath = path.resolve(resolvedRoot, filePath)

  // Security: validate path is within root
  if (!isPathWithinRoot(resolvedPath, resolvedRoot)) {
    return c.json({ error: 'Access denied: path outside root' }, 403)
  }

  try {
    if (!fs.existsSync(resolvedPath)) {
      if (!create) {
        return c.json({ error: 'File not found' }, 404)
      }
      // Create parent directories and write new file
      fs.mkdirSync(path.dirname(resolvedPath), { recursive: true })
    } else {
      const stat = fs.statSync(resolvedPath)
      if (!stat.isFile()) {
        return c.json({ error: 'Path is not a file' }, 400)
      }
    }

    // Write the content
    fs.writeFileSync(resolvedPath, content, 'utf-8')

    // Get the new mtime so client can update its tracking
    const newStat = fs.statSync(resolvedPath)

    return c.json({
      success: true,
      size: Buffer.byteLength(content, 'utf-8'),
      mtime: newStat.mtime.toISOString(),
    })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to write file' }, 500)
  }
})

// POST /api/fs/upload
// Multipart form: file (binary), root (string), targetDir (string), overwrite ('true' | undefined)
// Uploads a binary file into the worktree at root/targetDir.
app.post('/upload', async (c) => {
  try {
    const form = await c.req.formData()
    const file = form.get('file')
    const root = form.get('root')
    const targetDirRaw = form.get('targetDir')
    const overwrite = form.get('overwrite') === 'true'

    if (!(file instanceof File) || typeof file.name !== 'string') {
      return c.json({ error: 'file is required' }, 400)
    }
    if (typeof root !== 'string' || !root) {
      return c.json({ error: 'root is required' }, 400)
    }
    if (typeof targetDirRaw !== 'string') {
      return c.json({ error: 'targetDir is required' }, 400)
    }

    if (file.size > MAX_UPLOAD_SIZE) {
      return c.json(
        { error: `File too large. Maximum size is ${MAX_UPLOAD_SIZE / 1024 / 1024} MB` },
        413
      )
    }

    const safeName = path.basename(file.name)
    if (!safeName || safeName === '.' || safeName === '..') {
      return c.json({ error: 'invalid filename' }, 400)
    }
    if (safeName.length > MAX_FILENAME_LENGTH) {
      return c.json({ error: 'filename too long' }, 400)
    }

    const resolvedRoot = path.resolve(root)
    const resolvedDir = path.resolve(resolvedRoot, targetDirRaw || '')

    if (!isPathWithinRoot(resolvedDir, resolvedRoot)) {
      return c.json({ error: 'Access denied: targetDir outside root' }, 403)
    }

    if (!fs.existsSync(resolvedDir)) {
      return c.json({ error: 'targetDir does not exist' }, 400)
    }
    const dirStat = fs.statSync(resolvedDir)
    if (!dirStat.isDirectory()) {
      return c.json({ error: 'targetDir is not a directory' }, 400)
    }

    const resolvedPath = path.resolve(resolvedDir, safeName)
    if (!isPathWithinRoot(resolvedPath, resolvedRoot)) {
      return c.json({ error: 'Access denied: path outside root' }, 403)
    }

    const relPath = path.relative(resolvedRoot, resolvedPath)

    if (fs.existsSync(resolvedPath) && !overwrite) {
      return c.json({ error: 'File already exists', path: relPath, conflict: true }, 409)
    }

    const buffer = Buffer.from(await file.arrayBuffer())
    fs.writeFileSync(resolvedPath, buffer)

    const stat = fs.statSync(resolvedPath)
    return c.json(
      {
        path: relPath,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
      },
      201
    )
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to upload file' }, 500)
  }
})

// POST /api/fs/edit
// Body: { path: string, root: string, old_string: string, new_string: string }
// Performs exact string replacement (old_string must appear exactly once)
app.post('/edit', async (c) => {
  const body = await c.req.json<{
    path?: string
    root?: string
    old_string?: string
    new_string?: string
  }>()
  const { path: filePath, root, old_string, new_string } = body

  if (!filePath) {
    return c.json({ error: 'path is required' }, 400)
  }

  if (!root) {
    return c.json({ error: 'root is required' }, 400)
  }

  if (old_string === undefined) {
    return c.json({ error: 'old_string is required' }, 400)
  }

  if (new_string === undefined) {
    return c.json({ error: 'new_string is required' }, 400)
  }

  const resolvedRoot = path.resolve(root)
  const resolvedPath = path.resolve(resolvedRoot, filePath)

  // Security: validate path is within root
  if (!isPathWithinRoot(resolvedPath, resolvedRoot)) {
    return c.json({ error: 'Access denied: path outside root' }, 403)
  }

  try {
    if (!fs.existsSync(resolvedPath)) {
      return c.json({ error: 'File not found' }, 404)
    }

    const stat = fs.statSync(resolvedPath)
    if (!stat.isFile()) {
      return c.json({ error: 'Path is not a file' }, 400)
    }

    // Read current content
    const content = fs.readFileSync(resolvedPath, 'utf-8')

    // Count occurrences
    let count = 0
    let index = 0
    while ((index = content.indexOf(old_string, index)) !== -1) {
      count++
      index += old_string.length
    }

    if (count === 0) {
      return c.json({ error: 'String not found in file' }, 400)
    }

    if (count > 1) {
      return c.json(
        { error: `String found ${count} times, provide more context to make it unique` },
        400
      )
    }

    // Replace and write
    const newContent = content.replace(old_string, new_string)
    fs.writeFileSync(resolvedPath, newContent, 'utf-8')

    // Get the new mtime
    const newStat = fs.statSync(resolvedPath)

    return c.json({
      success: true,
      size: Buffer.byteLength(newContent, 'utf-8'),
      mtime: newStat.mtime.toISOString(),
    })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to edit file' }, 500)
  }
})

// POST /api/fs/rename
// Body: { path: string, root: string, newName: string }
// Renames a file to a sibling with `newName` (no directory traversal)
app.post('/rename', async (c) => {
  const body = await c.req.json<{ path?: string; root?: string; newName?: string }>()
  const { path: filePath, root, newName } = body

  if (!filePath) {
    return c.json({ error: 'path is required' }, 400)
  }

  if (!root) {
    return c.json({ error: 'root is required' }, 400)
  }

  if (!newName || newName.trim() === '') {
    return c.json({ error: 'newName is required' }, 400)
  }

  // Reject path separators and traversal in the new name
  if (newName.includes('/') || newName.includes('\\') || newName === '.' || newName === '..') {
    return c.json({ error: 'newName must be a plain file name (no path separators)' }, 400)
  }

  const resolvedRoot = path.resolve(root)
  const resolvedPath = path.resolve(resolvedRoot, filePath)
  const resolvedNewPath = path.resolve(path.dirname(resolvedPath), newName)

  if (!isPathWithinRoot(resolvedPath, resolvedRoot) || !isPathWithinRoot(resolvedNewPath, resolvedRoot)) {
    return c.json({ error: 'Access denied: path outside root' }, 403)
  }

  try {
    if (!fs.existsSync(resolvedPath)) {
      return c.json({ error: 'File not found' }, 404)
    }

    if (resolvedPath === resolvedNewPath) {
      return c.json({
        success: true,
        path: path.relative(resolvedRoot, resolvedNewPath),
      })
    }

    if (fs.existsSync(resolvedNewPath)) {
      return c.json({ error: 'A file with that name already exists' }, 409)
    }

    fs.renameSync(resolvedPath, resolvedNewPath)

    return c.json({
      success: true,
      path: path.relative(resolvedRoot, resolvedNewPath),
    })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to rename file' }, 500)
  }
})

// POST /api/fs/delete
// Body: { path: string, root: string }
// Deletes a file (not a directory).
app.post('/delete', async (c) => {
  const body = await c.req.json<{ path?: string; root?: string }>()
  const { path: filePath, root } = body

  if (!filePath) {
    return c.json({ error: 'path is required' }, 400)
  }

  if (!root) {
    return c.json({ error: 'root is required' }, 400)
  }

  const resolvedRoot = path.resolve(root)
  const resolvedPath = path.resolve(resolvedRoot, filePath)

  if (!isPathWithinRoot(resolvedPath, resolvedRoot)) {
    return c.json({ error: 'Access denied: path outside root' }, 403)
  }

  // Refuse to delete the root itself
  if (resolvedPath === resolvedRoot) {
    return c.json({ error: 'Cannot delete the root directory' }, 400)
  }

  try {
    if (!fs.existsSync(resolvedPath)) {
      return c.json({ error: 'File not found' }, 404)
    }

    const stat = fs.statSync(resolvedPath)
    if (!stat.isFile()) {
      return c.json({ error: 'Path is not a file' }, 400)
    }

    fs.unlinkSync(resolvedPath)

    return c.json({ success: true })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to delete file' }, 500)
  }
})

// GET /api/fs/download?path=/path/to/file&root=/worktree/root
// Returns the file as an attachment so the browser downloads it.
app.get('/download', (c) => {
  const filePath = c.req.query('path')
  const root = c.req.query('root')

  if (!filePath) {
    return c.json({ error: 'path parameter is required' }, 400)
  }

  if (!root) {
    return c.json({ error: 'root parameter is required' }, 400)
  }

  const resolvedRoot = path.resolve(root)
  const resolvedPath = path.resolve(resolvedRoot, filePath)

  if (!isPathWithinRoot(resolvedPath, resolvedRoot)) {
    return c.json({ error: 'Access denied: path outside root' }, 403)
  }

  try {
    if (!fs.existsSync(resolvedPath)) {
      return c.json({ error: 'File not found' }, 404)
    }

    const stat = fs.statSync(resolvedPath)
    if (!stat.isFile()) {
      return c.json({ error: 'Path is not a file' }, 400)
    }

    const buffer = fs.readFileSync(resolvedPath)
    const filename = path.basename(resolvedPath)
    // Encode the filename for non-ASCII characters per RFC 5987
    const encodedFilename = encodeURIComponent(filename)

    return new Response(buffer, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${filename.replace(/"/g, '\\"')}"; filename*=UTF-8''${encodedFilename}`,
        'Content-Length': buffer.length.toString(),
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to download file' }, 500)
  }
})

// GET /api/fs/stat?path=/path/to/check
// Returns type and existence info for a path
app.get('/stat', (c) => {
  let targetPath = c.req.query('path')

  if (!targetPath) {
    return c.json({ error: 'path parameter is required' }, 400)
  }

  // Expand ~ to home directory
  if (targetPath === '~') {
    targetPath = os.homedir()
  } else if (targetPath.startsWith('~/')) {
    targetPath = path.join(os.homedir(), targetPath.slice(2))
  }

  // Resolve to absolute path
  targetPath = path.resolve(targetPath)

  try {
    if (!fs.existsSync(targetPath)) {
      return c.json({
        path: targetPath,
        exists: false,
        type: null,
        isDirectory: false,
        isFile: false,
      })
    }

    const stat = fs.statSync(targetPath)
    const isDir = stat.isDirectory()
    const isFile = stat.isFile()

    return c.json({
      path: targetPath,
      exists: true,
      type: isDir ? 'directory' : isFile ? 'file' : 'other',
      isDirectory: isDir,
      isFile: isFile,
    })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to stat path' }, 500)
  }
})

// GET /api/fs/is-git-repo?path=/path/to/check
app.get('/is-git-repo', (c) => {
  let dirPath = c.req.query('path')

  if (!dirPath) {
    return c.json({ error: 'path parameter is required' }, 400)
  }

  // Expand ~ to home directory
  if (dirPath === '~') {
    dirPath = os.homedir()
  } else if (dirPath.startsWith('~/')) {
    dirPath = path.join(os.homedir(), dirPath.slice(2))
  }

  // Resolve to absolute path
  dirPath = path.resolve(dirPath)

  try {
    if (!fs.existsSync(dirPath)) {
      return c.json({ error: 'Path does not exist' }, 404)
    }

    const stat = fs.statSync(dirPath)
    if (!stat.isDirectory()) {
      return c.json({ error: 'Path is not a directory' }, 400)
    }

    const isRepo = isGitRepo(dirPath)

    return c.json({
      path: dirPath,
      isGitRepo: isRepo,
    })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to check path' }, 500)
  }
})

export default app
