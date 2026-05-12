import { useCallback, useEffect, useState, createContext, useContext } from 'react'
import { observer } from 'mobx-react-lite'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ContextMenu } from '@base-ui/react/context-menu'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  PencilEdit02Icon,
  Download01Icon,
  Delete02Icon,
} from '@hugeicons/core-free-icons'
import {
  FilesStoreContext,
  useCreateFilesStore,
  useFilesStoreActions,
} from '@/stores'
import { useFileTreePolling } from '@/hooks/use-file-tree-polling'
import { useUploadToFilesystem } from '@/hooks/use-upload-to-filesystem'
import {
  handleFilesDroppedFlow,
  type UploadFlowDeps,
} from '@/lib/upload-files-flow'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { FileTree } from './file-tree'
import { FileContent } from './file-content'

interface FilesViewerProps {
  worktreePath: string | null
  readOnly?: boolean
  initialSelectedFile?: string | null
  onFileChange?: (file: string | null) => void
  onFileSaved?: (file: string) => void
}

// Context to pass callbacks to inner components
interface FilesViewerCallbacks {
  onFileChange?: (file: string | null) => void
  onFileSaved?: (file: string) => void
}
const CallbacksContext = createContext<FilesViewerCallbacks>({})

// Export context for FileContent to access onFileSaved
export { CallbacksContext }

function basename(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx >= 0 ? path.slice(idx + 1) : path
}

/**
 * Inner component that uses the files store context
 */
const FilesViewerInner = observer(function FilesViewerInner() {
  const { t } = useTranslation('repositories')
  const { onFileChange } = useContext(CallbacksContext)
  const {
    worktreePath,
    readOnly,
    selectedFile,
    expandedDirs,
    fileTree,
    isLoadingTree,
    treeError,
    selectFile,
    loadFile,
    closeFile,
    toggleDir,
    collapseAll,
    updateFileTree,
    refreshTree,
  } = useFilesStoreActions()

  const [renameTarget, setRenameTarget] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [isRenaming, setIsRenaming] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)

  const { uploadFile } = useUploadToFilesystem()

  useEffect(() => {
    if (renameTarget) {
      setRenameValue(basename(renameTarget))
    }
  }, [renameTarget])

  // Poll for file tree changes (files added/removed externally)
  useFileTreePolling({
    worktreePath,
    currentTree: fileTree,
    onTreeChanged: updateFileTree,
    enabled: !isLoadingTree,
  })

  const handleSelectFile = useCallback(
    (path: string) => {
      selectFile(path)
      loadFile(path)
      onFileChange?.(path)
    },
    [selectFile, loadFile, onFileChange]
  )

  const handleToggleDir = useCallback(
    (path: string) => {
      toggleDir(path)
    },
    [toggleDir]
  )

  const handleBack = useCallback(() => {
    selectFile(null)
    onFileChange?.(null)
  }, [selectFile, onFileChange])

  const handleDownload = useCallback(
    async (path: string) => {
      if (!worktreePath) return
      const params = new URLSearchParams({ path, root: worktreePath })
      const url = `/api/fs/download?${params}`
      try {
        const res = await fetch(url)
        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          throw new Error(data.error || `Failed to download (${res.status})`)
        }
        const blob = await res.blob()
        const blobUrl = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = blobUrl
        a.download = basename(path)
        a.rel = 'noopener'
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        // Defer revocation so Firefox/Safari have time to start the download
        setTimeout(() => URL.revokeObjectURL(blobUrl), 1000)
      } catch (err) {
        toast.error(t('detailView.fileTree.downloadToast.error'), {
          description: err instanceof Error ? err.message : 'Unknown error',
        })
      }
    },
    [worktreePath, t]
  )

  const openRename = useCallback((path: string) => {
    setRenameTarget(path)
  }, [])

  const closeRename = useCallback(() => {
    if (isRenaming) return
    setRenameTarget(null)
    setRenameValue('')
  }, [isRenaming])

  const submitRename = useCallback(async () => {
    if (!worktreePath || !renameTarget) return
    const trimmed = renameValue.trim()
    if (!trimmed) return
    if (trimmed === basename(renameTarget)) {
      setRenameTarget(null)
      return
    }

    setIsRenaming(true)
    try {
      const res = await fetch('/api/fs/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: renameTarget, root: worktreePath, newName: trimmed }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to rename file')
      }
      const data = (await res.json()) as { path: string }

      const wasSelected = selectedFile === renameTarget
      // Drop any cached open copy under the old path
      closeFile(renameTarget)
      await refreshTree()
      if (wasSelected) {
        handleSelectFile(data.path)
      }
      toast.success(t('detailView.fileTree.renameToast.success'))
      setRenameTarget(null)
      setRenameValue('')
    } catch (err) {
      toast.error(t('detailView.fileTree.renameToast.error'), {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setIsRenaming(false)
    }
  }, [
    worktreePath,
    renameTarget,
    renameValue,
    selectedFile,
    closeFile,
    refreshTree,
    handleSelectFile,
    t,
  ])

  const openDelete = useCallback((path: string) => {
    setDeleteTarget(path)
  }, [])

  const closeDelete = useCallback(() => {
    if (isDeleting) return
    setDeleteTarget(null)
  }, [isDeleting])

  const handleFilesDropped = useCallback(
    async (files: File[], targetDir: string) => {
      if (!worktreePath) return
      const deps: UploadFlowDeps = {
        worktreePath,
        uploadFile,
        refreshTree,
        closeFile,
        toast,
        t,
      }
      await handleFilesDroppedFlow(deps, files, targetDir)
    },
    [worktreePath, uploadFile, refreshTree, closeFile, t]
  )

  const confirmDelete = useCallback(async () => {
    if (!worktreePath || !deleteTarget) return
    setIsDeleting(true)
    try {
      const res = await fetch('/api/fs/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: deleteTarget, root: worktreePath }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to delete file')
      }
      closeFile(deleteTarget)
      await refreshTree()
      toast.success(t('detailView.fileTree.deleteToast.success'))
      setDeleteTarget(null)
    } catch (err) {
      toast.error(t('detailView.fileTree.deleteToast.error'), {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setIsDeleting(false)
    }
  }, [worktreePath, deleteTarget, closeFile, refreshTree, t])

  if (isLoadingTree) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        Loading files...
      </div>
    )
  }

  if (treeError) {
    return (
      <div className="flex h-full items-center justify-center text-destructive text-sm">
        {treeError}
      </div>
    )
  }

  // Show file content when a file is selected, otherwise show the tree
  if (selectedFile) {
    const fileContent = (
      <div className="flex h-full flex-col" style={{ background: 'var(--gradient-card)' }}>
        <FileContent onBack={handleBack} />
      </div>
    )

    const onRenameCurrent = readOnly ? undefined : openRename
    const onDeleteCurrent = readOnly ? undefined : openDelete

    if (!onRenameCurrent && !onDeleteCurrent) {
      return (
        <>
          <ContextMenu.Root>
            <ContextMenu.Trigger>{fileContent}</ContextMenu.Trigger>
            <ContextMenu.Portal>
              <ContextMenu.Positioner className="isolate z-50 outline-none">
                <ContextMenu.Popup
                  className={cn(
                    'data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0',
                    'data-closed:zoom-out-95 data-open:zoom-in-95 ring-foreground/10 bg-popover text-popover-foreground',
                    'min-w-40 rounded-lg p-1 shadow-md ring-1 duration-100 outline-none'
                  )}
                >
                  <ContextMenu.Item
                    onClick={() => handleDownload(selectedFile)}
                    className="focus:bg-accent focus:text-accent-foreground min-h-7 gap-2 rounded-md px-2 py-1 text-xs/relaxed flex cursor-default items-center outline-hidden select-none [&_svg]:pointer-events-none [&_svg]:shrink-0"
                  >
                    <HugeiconsIcon icon={Download01Icon} size={14} strokeWidth={2} />
                    {t('detailView.fileTree.contextMenu.download')}
                  </ContextMenu.Item>
                </ContextMenu.Popup>
              </ContextMenu.Positioner>
            </ContextMenu.Portal>
          </ContextMenu.Root>
        </>
      )
    }

    return (
      <ContextMenu.Root>
        <ContextMenu.Trigger>{fileContent}</ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Positioner className="isolate z-50 outline-none">
            <ContextMenu.Popup
              className={cn(
                'data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0',
                'data-closed:zoom-out-95 data-open:zoom-in-95 ring-foreground/10 bg-popover text-popover-foreground',
                'min-w-40 rounded-lg p-1 shadow-md ring-1 duration-100 outline-none'
              )}
            >
              {onRenameCurrent && (
                <ContextMenu.Item
                  onClick={() => onRenameCurrent(selectedFile)}
                  className="focus:bg-accent focus:text-accent-foreground min-h-7 gap-2 rounded-md px-2 py-1 text-xs/relaxed flex cursor-default items-center outline-hidden select-none [&_svg]:pointer-events-none [&_svg]:shrink-0"
                >
                  <HugeiconsIcon icon={PencilEdit02Icon} size={14} strokeWidth={2} />
                  {t('detailView.fileTree.contextMenu.rename')}
                </ContextMenu.Item>
              )}
              <ContextMenu.Item
                onClick={() => handleDownload(selectedFile)}
                className="focus:bg-accent focus:text-accent-foreground min-h-7 gap-2 rounded-md px-2 py-1 text-xs/relaxed flex cursor-default items-center outline-hidden select-none [&_svg]:pointer-events-none [&_svg]:shrink-0"
              >
                <HugeiconsIcon icon={Download01Icon} size={14} strokeWidth={2} />
                {t('detailView.fileTree.contextMenu.download')}
              </ContextMenu.Item>
              {onDeleteCurrent && (
                <ContextMenu.Item
                  onClick={() => onDeleteCurrent(selectedFile)}
                  className="text-destructive focus:bg-destructive/10 dark:focus:bg-destructive/20 [&_svg]:text-destructive min-h-7 gap-2 rounded-md px-2 py-1 text-xs/relaxed flex cursor-default items-center outline-hidden select-none [&_svg]:pointer-events-none [&_svg]:shrink-0"
                >
                  <HugeiconsIcon icon={Delete02Icon} size={14} strokeWidth={2} />
                  {t('detailView.fileTree.contextMenu.delete')}
                </ContextMenu.Item>
              )}
            </ContextMenu.Popup>
          </ContextMenu.Positioner>
        </ContextMenu.Portal>
      </ContextMenu.Root>
    )
  }

  return (
    <>
      <FileTree
        entries={fileTree || []}
        selectedFile={selectedFile}
        expandedDirs={expandedDirs}
        onSelectFile={handleSelectFile}
        onToggleDir={handleToggleDir}
        onCollapseAll={collapseAll}
        onRenameFile={readOnly ? undefined : openRename}
        onDownloadFile={handleDownload}
        onDeleteFile={readOnly ? undefined : openDelete}
        onFilesDropped={readOnly || !worktreePath ? undefined : handleFilesDropped}
      />

      <Dialog
        open={renameTarget !== null}
        onOpenChange={(open) => {
          if (!open) closeRename()
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('detailView.fileTree.renameDialog.title')}</DialogTitle>
            <DialogDescription>
              {t('detailView.fileTree.renameDialog.description', {
                name: renameTarget ? basename(renameTarget) : '',
              })}
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              submitRename()
            }}
            className="flex flex-col gap-3"
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="file-rename-input">
                {t('detailView.fileTree.renameDialog.label')}
              </Label>
              <Input
                id="file-rename-input"
                autoFocus
                value={renameValue}
                disabled={isRenaming}
                onChange={(e) => setRenameValue(e.target.value)}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={closeRename} disabled={isRenaming}>
                {t('detailView.fileTree.renameDialog.cancel')}
              </Button>
              <Button
                type="submit"
                disabled={
                  isRenaming ||
                  !renameValue.trim() ||
                  (renameTarget !== null && renameValue.trim() === basename(renameTarget))
                }
              >
                {isRenaming
                  ? t('detailView.fileTree.renameDialog.renaming')
                  : t('detailView.fileTree.renameDialog.submit')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) closeDelete()
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('detailView.fileTree.deleteDialog.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('detailView.fileTree.deleteDialog.description', {
                name: deleteTarget ? basename(deleteTarget) : '',
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>
              {t('detailView.fileTree.deleteDialog.cancel')}
            </AlertDialogCancel>
            <Button variant="destructive" onClick={confirmDelete} disabled={isDeleting}>
              {isDeleting
                ? t('detailView.fileTree.deleteDialog.deleting')
                : t('detailView.fileTree.deleteDialog.confirm')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
})

/**
 * FilesViewer component with its own MST store context
 */
export function FilesViewer({
  worktreePath,
  readOnly = false,
  initialSelectedFile,
  onFileChange,
  onFileSaved,
}: FilesViewerProps) {
  const store = useCreateFilesStore(worktreePath, readOnly, initialSelectedFile)

  if (!worktreePath) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        No worktree selected
      </div>
    )
  }

  return (
    <FilesStoreContext.Provider value={store}>
      <CallbacksContext.Provider value={{ onFileChange, onFileSaved }}>
        <FilesViewerInner />
      </CallbacksContext.Provider>
    </FilesStoreContext.Provider>
  )
}
