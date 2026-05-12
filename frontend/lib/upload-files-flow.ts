import {
  UploadConflictError,
  type UploadFileArgs,
  type UploadResult,
} from '@/hooks/use-upload-to-filesystem'

interface ToastAction {
  label: string
  onClick: () => void
}

interface ToastWarningOptions {
  action?: ToastAction
}

interface ToastErrorOptions {
  description?: string
}

export interface UploadFlowToast {
  success: (message: string) => void
  warning: (message: string, options?: ToastWarningOptions) => void
  error: (message: string, options?: ToastErrorOptions) => void
}

export type UploadFlowTranslate = (
  key: string,
  options?: Record<string, unknown>
) => string

export interface UploadFlowDeps {
  worktreePath: string
  uploadFile: (args: UploadFileArgs) => Promise<UploadResult>
  refreshTree: () => Promise<void> | void
  closeFile: (path: string) => void
  toast: UploadFlowToast
  t: UploadFlowTranslate
}

export async function uploadOneFile(
  deps: UploadFlowDeps,
  file: File,
  targetDir: string,
  overwrite: boolean
): Promise<boolean> {
  try {
    const result = await deps.uploadFile({
      worktreePath: deps.worktreePath,
      targetDir,
      file,
      overwrite,
    })
    if (overwrite) {
      deps.closeFile(result.path)
    }
    return true
  } catch (err) {
    if (err instanceof UploadConflictError) {
      deps.toast.warning(
        deps.t('detailView.fileTree.uploadToast.conflict', {
          name: file.name,
          defaultValue: '{{name}} already exists',
        }),
        {
          action: {
            label: deps.t('detailView.fileTree.uploadToast.overwrite', {
              defaultValue: 'Overwrite',
            }),
            onClick: () => {
              void uploadOneFile(deps, file, targetDir, true).then((ok) => {
                if (ok) void deps.refreshTree()
              })
            },
          },
        }
      )
      return false
    }
    deps.toast.error(
      deps.t('detailView.fileTree.uploadToast.error', {
        defaultValue: 'Upload failed',
      }),
      {
        description: err instanceof Error ? err.message : 'Unknown error',
      }
    )
    return false
  }
}

export async function handleFilesDroppedFlow(
  deps: UploadFlowDeps,
  files: File[],
  targetDir: string
): Promise<void> {
  if (files.length === 0) return
  let successCount = 0
  for (const file of files) {
    const ok = await uploadOneFile(deps, file, targetDir, false)
    if (ok) successCount += 1
  }
  if (successCount > 0) {
    await deps.refreshTree()
    deps.toast.success(
      deps.t('detailView.fileTree.uploadToast.success', {
        count: successCount,
        defaultValue: 'Uploaded {{count}} file(s)',
      })
    )
  }
}
