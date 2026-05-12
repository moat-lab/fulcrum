export interface UploadResult {
  path: string
  size: number
  mtime: string
}

export interface UploadFileArgs {
  worktreePath: string
  targetDir: string
  file: File
  overwrite?: boolean
}

export class UploadConflictError extends Error {
  readonly path: string
  constructor(path: string) {
    super(`File already exists: ${path}`)
    this.name = 'UploadConflictError'
    this.path = path
  }
}

export function useUploadToFilesystem() {
  const uploadFile = async ({
    worktreePath,
    targetDir,
    file,
    overwrite,
  }: UploadFileArgs): Promise<UploadResult> => {
    const formData = new FormData()
    formData.append('file', file)
    formData.append('root', worktreePath)
    formData.append('targetDir', targetDir)
    if (overwrite) formData.append('overwrite', 'true')

    const response = await fetch('/api/fs/upload', {
      method: 'POST',
      body: formData,
    })

    if (response.status === 409) {
      const data = await response.json().catch(() => ({}))
      throw new UploadConflictError(data.path ?? file.name)
    }

    if (!response.ok) {
      const data = await response.json().catch(() => ({}))
      throw new Error(data.error || `Upload failed (${response.status})`)
    }

    return (await response.json()) as UploadResult
  }

  return { uploadFile }
}
