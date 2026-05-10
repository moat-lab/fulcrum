import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ContextMenu } from '@base-ui/react/context-menu'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  Folder01Icon,
  FolderOpenIcon,
  DocumentCodeIcon,
  File01Icon,
  Image01Icon,
  MenuCollapseIcon,
  Cancel01Icon,
  PencilEdit02Icon,
  Download01Icon,
  Delete02Icon,
} from '@hugeicons/core-free-icons'
import { cn } from '@/lib/utils'
import { fuzzyScore } from '@/lib/fuzzy-search'
import type { FileTreeEntry } from '@/types'

interface FileTreeProps {
  entries: FileTreeEntry[]
  selectedFile: string | null
  expandedDirs: string[]
  onSelectFile: (path: string) => void
  onToggleDir: (path: string) => void
  onCollapseAll: () => void
  onRenameFile?: (path: string) => void
  onDownloadFile?: (path: string) => void
  onDeleteFile?: (path: string) => void
  onFilesDropped?: (files: File[], targetDir: string) => void | Promise<void>
}

/** Flatten tree to get all file paths */
function flattenFiles(entries: FileTreeEntry[]): { name: string; path: string }[] {
  const files: { name: string; path: string }[] = []
  function traverse(nodes: FileTreeEntry[]) {
    for (const node of nodes) {
      if (node.type === 'file') {
        files.push({ name: node.name, path: node.path })
      } else if (node.children) {
        traverse(node.children)
      }
    }
  }
  traverse(entries)
  return files
}

function getFileIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase() || ''

  // Image extensions
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico'].includes(ext)) {
    return Image01Icon
  }

  // Code extensions
  if (
    [
      'ts',
      'tsx',
      'js',
      'jsx',
      'json',
      'css',
      'html',
      'md',
      'yaml',
      'yml',
      'toml',
      'sh',
      'py',
      'rs',
      'go',
      'sql',
    ].includes(ext)
  ) {
    return DocumentCodeIcon
  }

  return File01Icon
}

function isFilesDrag(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files')
}

interface FileContextMenuProps {
  path: string
  onRename?: (path: string) => void
  onDownload?: (path: string) => void
  onDelete?: (path: string) => void
  children: ReactNode
}

/**
 * Wraps a file row with a right-click / long-press context menu.
 * If no action callbacks are provided, the children render with no menu.
 */
function FileContextMenu({ path, onRename, onDownload, onDelete, children }: FileContextMenuProps) {
  const { t } = useTranslation('repositories')

  if (!onRename && !onDownload && !onDelete) {
    return <>{children}</>
  }

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="isolate z-50 outline-none">
          <ContextMenu.Popup
            className={cn(
              'data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0',
              'data-closed:zoom-out-95 data-open:zoom-in-95 ring-foreground/10 bg-popover text-popover-foreground',
              'min-w-40 rounded-lg p-1 shadow-md ring-1 duration-100 outline-none'
            )}
          >
            {onRename && (
              <ContextMenu.Item
                onClick={() => onRename(path)}
                className="focus:bg-accent focus:text-accent-foreground min-h-7 gap-2 rounded-md px-2 py-1 text-xs/relaxed flex cursor-default items-center outline-hidden select-none [&_svg]:pointer-events-none [&_svg]:shrink-0"
              >
                <HugeiconsIcon icon={PencilEdit02Icon} size={14} strokeWidth={2} />
                {t('detailView.fileTree.contextMenu.rename')}
              </ContextMenu.Item>
            )}
            {onDownload && (
              <ContextMenu.Item
                onClick={() => onDownload(path)}
                className="focus:bg-accent focus:text-accent-foreground min-h-7 gap-2 rounded-md px-2 py-1 text-xs/relaxed flex cursor-default items-center outline-hidden select-none [&_svg]:pointer-events-none [&_svg]:shrink-0"
              >
                <HugeiconsIcon icon={Download01Icon} size={14} strokeWidth={2} />
                {t('detailView.fileTree.contextMenu.download')}
              </ContextMenu.Item>
            )}
            {onDelete && (
              <ContextMenu.Item
                onClick={() => onDelete(path)}
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

interface TreeNodeProps {
  entry: FileTreeEntry
  depth: number
  selectedFile: string | null
  expandedDirs: string[]
  dragOverPath: string | null
  onSelectFile: (path: string) => void
  onToggleDir: (path: string) => void
  onRenameFile?: (path: string) => void
  onDownloadFile?: (path: string) => void
  onDeleteFile?: (path: string) => void
  onDirectoryDragOver?: (path: string) => void
  onDirectoryDrop?: (path: string, files: File[]) => void
}

function TreeNode({
  entry,
  depth,
  selectedFile,
  expandedDirs,
  dragOverPath,
  onSelectFile,
  onToggleDir,
  onRenameFile,
  onDownloadFile,
  onDeleteFile,
  onDirectoryDragOver,
  onDirectoryDrop,
}: TreeNodeProps) {
  const isExpanded = expandedDirs.includes(entry.path)
  const isSelected = selectedFile === entry.path
  const isDirectory = entry.type === 'directory'
  const isDropTarget = isDirectory && dragOverPath === entry.path

  const handleClick = useCallback(() => {
    if (isDirectory) {
      onToggleDir(entry.path)
    } else {
      onSelectFile(entry.path)
    }
  }, [isDirectory, entry.path, onSelectFile, onToggleDir])

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!isDirectory || !onDirectoryDragOver || !isFilesDrag(e)) return
      e.preventDefault()
      e.stopPropagation()
      onDirectoryDragOver(entry.path)
    },
    [isDirectory, onDirectoryDragOver, entry.path]
  )

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      if (!isDirectory || !onDirectoryDrop || !isFilesDrag(e)) return
      e.preventDefault()
      e.stopPropagation()
      const files = Array.from(e.dataTransfer.files)
      if (files.length > 0) onDirectoryDrop(entry.path, files)
    },
    [isDirectory, onDirectoryDrop, entry.path]
  )

  const row = (
    <div
      className={cn(
        'flex items-center gap-1.5 px-2 py-0.5 cursor-pointer text-sm hover:bg-muted/50',
        isSelected && 'bg-primary/10 text-primary',
        isDropTarget && 'bg-primary/15 ring-1 ring-primary ring-inset'
      )}
      style={{ paddingLeft: `${depth * 12 + 8}px` }}
      onClick={handleClick}
      onDragOver={isDirectory && onDirectoryDragOver ? handleDragOver : undefined}
      onDrop={isDirectory && onDirectoryDrop ? handleDrop : undefined}
    >
      <HugeiconsIcon
        icon={
          isDirectory
            ? isExpanded
              ? FolderOpenIcon
              : Folder01Icon
            : getFileIcon(entry.name)
        }
        size={14}
        strokeWidth={2}
        className={cn(
          'shrink-0',
          isDirectory ? 'text-accent' : 'text-muted-foreground'
        )}
      />
      <span className="break-all">{entry.name}</span>
    </div>
  )

  return (
    <div>
      {isDirectory ? (
        row
      ) : (
        <FileContextMenu
          path={entry.path}
          onRename={onRenameFile}
          onDownload={onDownloadFile}
          onDelete={onDeleteFile}
        >
          {row}
        </FileContextMenu>
      )}

      {isDirectory && isExpanded && entry.children && (
        <div>
          {entry.children.map((child) => (
            <TreeNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              selectedFile={selectedFile}
              expandedDirs={expandedDirs}
              dragOverPath={dragOverPath}
              onSelectFile={onSelectFile}
              onToggleDir={onToggleDir}
              onRenameFile={onRenameFile}
              onDownloadFile={onDownloadFile}
              onDeleteFile={onDeleteFile}
              onDirectoryDragOver={onDirectoryDragOver}
              onDirectoryDrop={onDirectoryDrop}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export function FileTree({
  entries,
  selectedFile,
  expandedDirs,
  onSelectFile,
  onToggleDir,
  onCollapseAll,
  onRenameFile,
  onDownloadFile,
  onDeleteFile,
  onFilesDropped,
}: FileTreeProps) {
  const { t } = useTranslation('repositories')
  const [searchQuery, setSearchQuery] = useState('')
  const [dragOverPath, setDragOverPath] = useState<string | null>(null)
  const dragCounterRef = useRef(0)
  const wrapperRef = useRef<HTMLDivElement | null>(null)

  const allFiles = useMemo(() => flattenFiles(entries), [entries])

  const filteredFiles = useMemo(() => {
    if (!searchQuery.trim()) return null
    const query = searchQuery.trim()
    return allFiles
      .map((file) => ({
        ...file,
        score: Math.max(fuzzyScore(file.name, query), fuzzyScore(file.path, query)),
      }))
      .filter((file) => file.score > 0)
      .sort((a, b) => b.score - a.score)
  }, [allFiles, searchQuery])

  const handleClearSearch = useCallback(() => {
    setSearchQuery('')
  }, [])

  const dropEnabled = !!onFilesDropped

  const handleWrapperDragEnter = useCallback(
    (e: React.DragEvent) => {
      if (!dropEnabled || !isFilesDrag(e)) return
      e.preventDefault()
      dragCounterRef.current += 1
      setDragOverPath((prev) => (prev === null ? '' : prev))
    },
    [dropEnabled]
  )

  const handleWrapperDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!dropEnabled || !isFilesDrag(e)) return
      e.preventDefault()
      // Reset to root when not over a directory row (directory rows stopPropagation).
      setDragOverPath((prev) => (prev === null ? '' : prev === '' ? prev : ''))
    },
    [dropEnabled]
  )

  const handleWrapperDragLeave = useCallback(
    (e: React.DragEvent) => {
      if (!dropEnabled) return
      dragCounterRef.current = Math.max(0, dragCounterRef.current - 1)
      if (dragCounterRef.current === 0) {
        setDragOverPath(null)
      }
      e.preventDefault()
    },
    [dropEnabled]
  )

  const handleWrapperDrop = useCallback(
    (e: React.DragEvent) => {
      if (!dropEnabled || !isFilesDrag(e)) return
      e.preventDefault()
      dragCounterRef.current = 0
      setDragOverPath(null)
      const files = Array.from(e.dataTransfer.files)
      if (files.length > 0) onFilesDropped?.(files, '')
    },
    [dropEnabled, onFilesDropped]
  )

  const handleDirectoryDragOver = useCallback(
    (path: string) => {
      setDragOverPath(path)
    },
    []
  )

  const handleDirectoryDrop = useCallback(
    (path: string, files: File[]) => {
      dragCounterRef.current = 0
      setDragOverPath(null)
      if (files.length > 0) onFilesDropped?.(files, path)
    },
    [onFilesDropped]
  )

  const dropHandlers = dropEnabled
    ? {
        onDragEnter: handleWrapperDragEnter,
        onDragOver: handleWrapperDragOver,
        onDragLeave: handleWrapperDragLeave,
        onDrop: handleWrapperDrop,
      }
    : {}

  const showDropHighlight = dropEnabled && dragOverPath !== null

  if (entries.length === 0) {
    return (
      <div
        ref={wrapperRef}
        className={cn(
          'flex items-center justify-center h-full text-muted-foreground text-sm relative',
          showDropHighlight && 'ring-2 ring-primary ring-inset bg-primary/5'
        )}
        {...dropHandlers}
      >
        {showDropHighlight
          ? t('detailView.fileTree.uploadToast.dropHint', 'Drop files to upload')
          : t('detailView.fileTree.noFiles')}
      </div>
    )
  }

  return (
    <div
      ref={wrapperRef}
      className={cn(
        'flex flex-col h-full relative',
        showDropHighlight && 'ring-2 ring-primary ring-inset'
      )}
      style={{ background: 'var(--gradient-card)' }}
      {...dropHandlers}
    >
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between px-2 py-1 border-b border-border bg-card">
        <span className="text-xs text-muted-foreground">{t('detailView.fileTree.title')}</span>
        <button
          onClick={onCollapseAll}
          className="p-1 text-muted-foreground hover:text-foreground rounded hover:bg-muted/50"
          title={t('detailView.fileTree.collapseAll')}
        >
          <HugeiconsIcon icon={MenuCollapseIcon} size={14} strokeWidth={2} />
        </button>
      </div>

      {/* Search */}
      <div className="shrink-0 px-2 py-1.5 border-b border-border bg-card">
        <div className="relative">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('detailView.fileTree.searchPlaceholder')}
            className="w-full text-sm bg-muted/50 border border-border rounded px-2 py-1 pr-7 placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
          {searchQuery && (
            <button
              onClick={handleClearSearch}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 text-muted-foreground hover:text-foreground rounded hover:bg-muted"
            >
              <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={2} />
            </button>
          )}
        </div>
      </div>

      {/* Search Results or Tree */}
      <div className="py-1 flex-1 overflow-auto">
        {filteredFiles ? (
          filteredFiles.length > 0 ? (
            filteredFiles.map((file) => (
              <FileContextMenu
                key={file.path}
                path={file.path}
                onRename={onRenameFile}
                onDownload={onDownloadFile}
                onDelete={onDeleteFile}
              >
                <div
                  className={cn(
                    'flex items-center gap-1.5 px-2 py-0.5 cursor-pointer text-sm hover:bg-muted/50',
                    selectedFile === file.path && 'bg-primary/10 text-primary'
                  )}
                  onClick={() => onSelectFile(file.path)}
                >
                  <HugeiconsIcon
                    icon={getFileIcon(file.name)}
                    size={14}
                    strokeWidth={2}
                    className="shrink-0 text-muted-foreground"
                  />
                  <span className="truncate" title={file.path}>
                    {file.name}
                  </span>
                  <span className="text-xs text-muted-foreground truncate ml-auto">
                    {file.path.split('/').slice(0, -1).join('/')}
                  </span>
                </div>
              </FileContextMenu>
            ))
          ) : (
            <div className="px-2 py-4 text-center text-sm text-muted-foreground">
              No matching files
            </div>
          )
        ) : (
          entries.map((entry) => (
            <TreeNode
              key={entry.path}
              entry={entry}
              depth={0}
              selectedFile={selectedFile}
              expandedDirs={expandedDirs}
              dragOverPath={dragOverPath}
              onSelectFile={onSelectFile}
              onToggleDir={onToggleDir}
              onRenameFile={onRenameFile}
              onDownloadFile={onDownloadFile}
              onDeleteFile={onDeleteFile}
              onDirectoryDragOver={dropEnabled ? handleDirectoryDragOver : undefined}
              onDirectoryDrop={dropEnabled ? handleDirectoryDrop : undefined}
            />
          ))
        )}
      </div>

      {showDropHighlight && dragOverPath === '' && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-primary/5">
          <div className="rounded-md bg-card/90 px-3 py-1.5 text-xs text-foreground shadow-sm border border-primary/40">
            {t('detailView.fileTree.uploadToast.dropHint', 'Drop files to upload')}
          </div>
        </div>
      )}
    </div>
  )
}
