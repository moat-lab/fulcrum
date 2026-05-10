import { useRef, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ContextMenu } from '@base-ui/react/context-menu'
import { draggable, dropTargetForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter'
import { setCustomNativeDragPreview } from '@atlaskit/pragmatic-drag-and-drop/element/set-custom-native-drag-preview'
import { pointerOutsideOfPreview } from '@atlaskit/pragmatic-drag-and-drop/element/pointer-outside-of-preview'
import { attachClosestEdge, extractClosestEdge, type Edge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge'
import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { DeleteTaskDialog } from '@/components/delete-task-dialog'
import { useDrag } from './drag-context'
import { useSelection } from './selection-context'
import type { Task, TaskStatus } from '@/types'
import { cn } from '@/lib/utils'
import { HugeiconsIcon } from '@hugeicons/react'
import { FolderLibraryIcon, GitPullRequestIcon, Calendar03Icon, AlertDiamondIcon, Alert02Icon, RepeatIcon, Clock01Icon, ArrowUp01Icon, ArrowDown01Icon, PinIcon, PinOffIcon, Delete02Icon, ArrowRight01Icon, ArrowLeftRightIcon } from '@hugeicons/core-free-icons'
import { useRepositories } from '@/hooks/use-repositories'
import { usePinTask, useUpdateTaskStatus } from '@/hooks/use-tasks'
import { formatDateString } from '../../../shared/date-utils'
import { useIsOverdue, useIsDueToday } from '@/hooks/use-date-utils'
import { getTaskTypeCssVar } from '@/lib/task-type-colors'
import { getTaskType } from '../../../shared/types'

const STATUS_LABELS: Record<TaskStatus, string> = {
  TO_DO: 'To Do',
  IN_PROGRESS: 'In Progress',
  IN_REVIEW: 'In Review',
  DONE: 'Done',
  CANCELED: 'Canceled',
}

const MENU_ITEM_CLASS =
  'focus:bg-accent focus:text-accent-foreground data-disabled:opacity-50 data-disabled:pointer-events-none min-h-7 gap-2 rounded-md px-2 py-1 text-xs/relaxed flex cursor-default items-center outline-hidden select-none [&_svg]:pointer-events-none [&_svg]:shrink-0'

const MENU_ITEM_DESTRUCTIVE_CLASS =
  'text-destructive focus:bg-destructive/10 dark:focus:bg-destructive/20 [&_svg]:text-destructive min-h-7 gap-2 rounded-md px-2 py-1 text-xs/relaxed flex cursor-default items-center outline-hidden select-none [&_svg]:pointer-events-none [&_svg]:shrink-0'

const MENU_POPUP_CLASS = cn(
  'data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0',
  'data-closed:zoom-out-95 data-open:zoom-in-95 ring-foreground/10 bg-popover text-popover-foreground',
  'min-w-40 rounded-lg p-1 shadow-md ring-1 duration-100 outline-none'
)

interface TaskCardProps {
  task: Task
  isDragPreview?: boolean
  isBlocked?: boolean
  isBlocking?: boolean
  showTypeLabel?: boolean
}

export function TaskCard({ task, isDragPreview, isBlocked, isBlocking, showTypeLabel }: TaskCardProps) {
  const { t } = useTranslation('tasks')
  const { setActiveTask } = useDrag()
  const { isSelected, toggleSelection } = useSelection()
  const navigate = useNavigate()
  const pinTask = usePinTask()
  const updateTaskStatus = useUpdateTaskStatus()
  const queryClient = useQueryClient()
  const { data: repositories } = useRepositories()
  const selected = isSelected(task.id)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)

  const ref = useRef<HTMLDivElement>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [closestEdge, setClosestEdge] = useState<Edge | null>(null)
  const [previewContainer, setPreviewContainer] = useState<HTMLElement | null>(null)

  // Determine if this is a code task (has worktree, repository, or is scratch)
  const isCodeTask = !!(task.worktreePath || task.repositoryId || task.type === 'scratch')
  const isActiveWorktreeTask = !!task.worktreePath
  const isPendingCodeTask = !task.worktreePath && !!task.repositoryId

  // Get repository info for pending code tasks
  const pendingRepo = isPendingCodeTask
    ? repositories?.find((r) => r.id === task.repositoryId)
    : null

  // Check if task is overdue or due today using configured timezone
  const isOverdue = useIsOverdue(task.dueDate, task.status)
  const isDueToday = useIsDueToday(task.dueDate, task.status)

  // Track if drag occurred to distinguish from click
  const hasDragged = useRef(false)

  useEffect(() => {
    const el = ref.current
    if (!el || isDragPreview) return

    return combine(
      draggable({
        element: el,
        getInitialData: () => ({
          type: 'task',
          taskId: task.id,
          status: task.status,
        }),
        onGenerateDragPreview: ({ nativeSetDragImage }) => {
          setCustomNativeDragPreview({
            nativeSetDragImage,
            getOffset: pointerOutsideOfPreview({
              x: '16px',
              y: '8px',
            }),
            render: ({ container }) => {
              setPreviewContainer(container)
            },
          })
        },
        onDragStart: () => {
          setIsDragging(true)
          setActiveTask(task)
          hasDragged.current = true
        },
        onDrop: () => {
          setIsDragging(false)
          setActiveTask(null)
          setPreviewContainer(null)
        },
      }),
      dropTargetForElements({
        element: el,
        getData: ({ input, element }) => {
          const data = {
            type: 'task',
            taskId: task.id,
            status: task.status,
          }
          return attachClosestEdge(data, {
            input,
            element,
            allowedEdges: ['top', 'bottom'],
          })
        },
        canDrop: ({ source }) => {
          return source.data.taskId !== task.id
        },
        onDragEnter: ({ self }) => {
          setClosestEdge(extractClosestEdge(self.data))
        },
        onDrag: ({ self }) => {
          setClosestEdge(extractClosestEdge(self.data))
        },
        onDragLeave: () => {
          setClosestEdge(null)
        },
        onDrop: () => {
          setClosestEdge(null)
        },
      })
    )
  }, [task, isDragPreview, setActiveTask])

  const handlePointerDown = () => {
    hasDragged.current = false
  }

  const handleClick = () => {
    // Only navigate if we didn't drag
    if (hasDragged.current) {
      hasDragged.current = false
      return
    }

    // For active code tasks (has worktree), navigate to detail page
    // For non-code tasks and pending code tasks, open the modal via URL param
    if (isActiveWorktreeTask) {
      navigate({ to: '/tasks/$taskId', params: { taskId: task.id } })
    } else {
      navigate({
        to: '/tasks',
        search: (prev) => ({ ...prev, task: task.id }),
        replace: true,
      })
    }
    hasDragged.current = false
  }

  const handleStatusChange = (newStatus: TaskStatus) => {
    if (newStatus === task.status) return
    const allTasks = queryClient.getQueryData<Task[]>(['tasks']) ?? []
    const position = allTasks.filter((t) => t.status === newStatus && t.id !== task.id).length
    updateTaskStatus.mutate({ taskId: task.id, status: newStatus, position })
  }


  const cardContent = (
    <div className="group/card relative">
      {/* Selection checkbox - OUTSIDE the draggable Card */}
      {!isDragPreview && (
        <div
          className={cn(
            'absolute left-2 top-2 z-20 transition-opacity duration-150',
            selected ? 'opacity-100' : 'opacity-0 group-hover/card:opacity-100'
          )}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <Checkbox
            checked={selected}
            onCheckedChange={() => toggleSelection(task.id)}
          />
        </div>
      )}
      {/* Pin toggle button - appears on hover */}
      {!isDragPreview && (
        <button
          type="button"
          className={cn(
            'absolute right-2 top-2 z-20 p-0.5 rounded transition-opacity duration-150 hover:bg-muted cursor-pointer',
            task.pinned ? 'opacity-100' : 'opacity-0 group-hover/card:opacity-100'
          )}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            pinTask.mutate({ taskId: task.id, pinned: !task.pinned })
          }}
          title={task.pinned ? 'Unpin task' : 'Pin task to top'}
        >
          <HugeiconsIcon
            icon={task.pinned ? PinOffIcon : PinIcon}
            size={14}
            strokeWidth={2}
            className={task.pinned ? 'text-primary' : 'text-muted-foreground'}
          />
        </button>
      )}

      <Card
        ref={isDragPreview ? undefined : ref}
        onPointerDown={handlePointerDown}
        onClick={handleClick}
        className={cn(
          'relative cursor-grab active:cursor-grabbing',
          'transition-all duration-200 ease-out',
          'hover:shadow-md hover:scale-[1.02] hover:-translate-y-0.5',
          isDragging && 'opacity-50',
          selected && 'ring-2 ring-primary bg-primary/5'
        )}
      >

        {/* Drop indicator line */}
        {closestEdge && (
          <div
            className={cn(
              'absolute left-0 right-0 h-0.5 bg-primary z-10',
              closestEdge === 'top' && '-top-1',
              closestEdge === 'bottom' && '-bottom-1'
            )}
          />
        )}

        <CardHeader className={cn(
          'p-3 pb-1 flex flex-row items-start justify-between gap-2',
          !isDragPreview && 'pl-8' // Make room for checkbox
        )}>
        <CardTitle className="text-sm font-medium leading-tight flex-1">
          {task.title}
        </CardTitle>
      </CardHeader>
      <CardContent className={cn('p-3 pt-1', !isDragPreview && 'pl-8')}>
        {task.description && (
          <p className="line-clamp-2 text-xs text-muted-foreground">
            {task.description}
          </p>
        )}
        {/* Tags row */}
        {task.tags.length > 0 && (
          <div className="mt-2 flex items-center gap-1 flex-wrap">
            {task.tags.slice(0, 3).map((tag) => (
              <span
                key={tag}
                className="rounded-full border border-border bg-card px-1.5 py-0.5 text-[10px] font-medium"
              >
                {tag}
              </span>
            ))}
            {task.tags.length > 3 && (
              <span className="text-[10px] text-muted-foreground">+{task.tags.length - 3}</span>
            )}
          </div>
        )}
        {/* Metadata row */}
        <div className={cn(
          'flex items-center gap-1 text-xs text-muted-foreground/70 flex-wrap',
          task.tags.length > 0 ? 'mt-1.5' : 'mt-2'
        )}>
          {/* Blocked indicator (red) */}
          {isBlocked && (
            <>
              <span className="inline-flex items-center gap-0.5 whitespace-nowrap text-destructive font-medium">
                <HugeiconsIcon icon={AlertDiamondIcon} size={12} strokeWidth={2} />
                <span>Blocked</span>
              </span>
              <span className="text-muted-foreground/30">•</span>
            </>
          )}
          {/* Blocking indicator (accent/blue) */}
          {isBlocking && (
            <>
              <span className="inline-flex items-center gap-0.5 whitespace-nowrap text-accent font-medium">
                <HugeiconsIcon icon={Alert02Icon} size={12} strokeWidth={2} />
                <span>Blocking</span>
              </span>
              <span className="text-muted-foreground/30">•</span>
            </>
          )}
          {/* Code task metadata - active (has worktree) */}
          {isActiveWorktreeTask && (
            <span className="inline-flex items-center gap-1 whitespace-nowrap">
              <HugeiconsIcon icon={FolderLibraryIcon} size={12} strokeWidth={2} />
              <span className="truncate max-w-24">{task.repoName}</span>
              {task.prUrl && (
                <>
                  <span className="text-muted-foreground/30">•</span>
                  <HugeiconsIcon icon={GitPullRequestIcon} size={12} strokeWidth={2} className="text-foreground" />
                </>
              )}
            </span>
          )}
          {/* Code task metadata - pending (has repositoryId but no worktree yet) */}
          {isPendingCodeTask && pendingRepo && (
            <span className="inline-flex items-center gap-1 whitespace-nowrap">
              <HugeiconsIcon icon={FolderLibraryIcon} size={12} strokeWidth={2} />
              <span className="truncate max-w-24">{pendingRepo.displayName}</span>
            </span>
          )}
          {/* Due date - shown for all tasks */}
          {task.dueDate && (
            <>
              {isCodeTask && <span className="text-muted-foreground/30">•</span>}
              <span className={cn(
                'inline-flex items-center gap-1 whitespace-nowrap',
                isOverdue ? 'text-destructive' : isDueToday ? 'text-amber-600 dark:text-amber-500' : ''
              )}>
                <HugeiconsIcon icon={Calendar03Icon} size={12} strokeWidth={2} />
                <span>{formatDateString(task.dueDate)}</span>
              </span>
            </>
          )}
          {/* Time estimate */}
          {task.timeEstimate != null && (
            <>
              {(isCodeTask || task.dueDate) && <span className="text-muted-foreground/30">•</span>}
              <span className="inline-flex items-center gap-0.5 whitespace-nowrap">
                <HugeiconsIcon icon={Clock01Icon} size={12} strokeWidth={2} />
                <span>{task.timeEstimate}h</span>
              </span>
            </>
          )}
          {/* Priority indicator (only for non-medium) */}
          {task.priority && task.priority !== 'medium' && (
            <>
              {(isCodeTask || task.dueDate || task.timeEstimate != null) && <span className="text-muted-foreground/30">•</span>}
              <span className={cn(
                'inline-flex items-center gap-0.5 whitespace-nowrap',
                task.priority === 'high' ? 'text-destructive' : 'text-muted-foreground/50'
              )}>
                <HugeiconsIcon icon={task.priority === 'high' ? ArrowUp01Icon : ArrowDown01Icon} size={12} strokeWidth={2} />
              </span>
            </>
          )}
          {/* Recurrence indicator */}
          {task.recurrenceRule && (
            <>
              {(isCodeTask || task.dueDate || task.timeEstimate != null) && <span className="text-muted-foreground/30">•</span>}
              <span className="inline-flex items-center gap-0.5 whitespace-nowrap">
                <HugeiconsIcon icon={RepeatIcon} size={12} strokeWidth={2} />
              </span>
            </>
          )}
          {/* Fallback for non-code tasks with no metadata */}
          {!isCodeTask && !isBlocked && !isBlocking && task.tags.length === 0 && !task.dueDate && task.timeEstimate == null && (!task.priority || task.priority === 'medium') && !task.recurrenceRule && (
            <span className="italic">Non-code task</span>
          )}
        </div>
        {/* Task type label - always visible when toggled on, otherwise on hover */}
        <span
          className={cn(
            'absolute bottom-1.5 right-2 text-[10px] font-medium transition-opacity duration-200',
            showTypeLabel ? 'opacity-100' : 'opacity-0 group-hover/card:opacity-100'
          )}
          style={{ color: getTaskTypeCssVar(task) }}
        >
          {t(`typeFilter.types.${getTaskType(task)}`)}
        </span>
      </CardContent>
      </Card>
    </div>
  )

  if (isDragPreview) {
    return cardContent
  }

  return (
    <>
      <ContextMenu.Root>
        <ContextMenu.Trigger>{cardContent}</ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Positioner className="isolate z-50 outline-none">
            <ContextMenu.Popup className={MENU_POPUP_CLASS}>
              <ContextMenu.Item
                className={MENU_ITEM_CLASS}
                onClick={() => pinTask.mutate({ taskId: task.id, pinned: !task.pinned })}
              >
                <HugeiconsIcon icon={task.pinned ? PinOffIcon : PinIcon} size={14} strokeWidth={2} />
                {task.pinned ? 'Unpin' : 'Pin to top'}
              </ContextMenu.Item>
              <ContextMenu.SubmenuRoot>
                <ContextMenu.SubmenuTrigger className={MENU_ITEM_CLASS}>
                  <HugeiconsIcon icon={ArrowLeftRightIcon} size={14} strokeWidth={2} />
                  <span className="flex-1">Move to status</span>
                  <HugeiconsIcon icon={ArrowRight01Icon} size={12} strokeWidth={2} className="opacity-60" />
                </ContextMenu.SubmenuTrigger>
                <ContextMenu.Portal>
                  <ContextMenu.Positioner className="isolate z-50 outline-none">
                    <ContextMenu.Popup className={MENU_POPUP_CLASS}>
                      {(Object.entries(STATUS_LABELS) as [TaskStatus, string][]).map(([value, label]) => (
                        <ContextMenu.Item
                          key={value}
                          className={MENU_ITEM_CLASS}
                          disabled={value === task.status}
                          onClick={() => handleStatusChange(value)}
                        >
                          <span className="w-3 text-primary">{value === task.status ? '✓' : ''}</span>
                          {label}
                        </ContextMenu.Item>
                      ))}
                    </ContextMenu.Popup>
                  </ContextMenu.Positioner>
                </ContextMenu.Portal>
              </ContextMenu.SubmenuRoot>
              <div role="separator" className="my-1 h-px bg-border" />
              <ContextMenu.Item
                className={MENU_ITEM_DESTRUCTIVE_CLASS}
                onClick={() => setDeleteDialogOpen(true)}
              >
                <HugeiconsIcon icon={Delete02Icon} size={14} strokeWidth={2} />
                Delete…
              </ContextMenu.Item>
            </ContextMenu.Popup>
          </ContextMenu.Positioner>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      <DeleteTaskDialog
        task={task}
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
      />
      {previewContainer && createPortal(
        <div className="w-72 max-w-[90vw]">
          <TaskCard task={task} isDragPreview />
        </div>,
        previewContainer
      )}
    </>
  )
}
