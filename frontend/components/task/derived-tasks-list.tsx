import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { HugeiconsIcon } from '@hugeicons/react'
import { GitForkIcon } from '@hugeicons/core-free-icons'
import { useTasks } from '@/hooks/use-tasks'
import { selectDerivedTasks } from '@/lib/derived-tasks'

interface DerivedTasksListProps {
  taskId: string
}

const STATUS_CLASS = {
  TO_DO: 'bg-muted text-muted-foreground',
  IN_PROGRESS: 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300',
  IN_REVIEW: 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
  DONE: 'bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-300',
  CANCELED: 'bg-muted text-muted-foreground line-through',
} as const

export function DerivedTasksList({ taskId }: DerivedTasksListProps) {
  const { t } = useTranslation('tasks')
  const { t: tc } = useTranslation('common')
  const { data: allTasks } = useTasks()
  const children = selectDerivedTasks(allTasks, taskId)

  return (
    <div className="rounded-lg border bg-card p-4">
      <h3 className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground mb-2">
        <HugeiconsIcon icon={GitForkIcon} size={14} className="text-purple-600 dark:text-purple-400" />
        {t('derivedTasks.heading', { count: children.length })}
      </h3>
      {children.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('derivedTasks.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {children.map((child) => (
            <li key={child.id} className="flex items-center gap-2 text-sm">
              <Link
                to="/tasks/$taskId"
                params={{ taskId: child.id }}
                className="truncate hover:underline flex-1"
              >
                {child.title}
              </Link>
              <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${STATUS_CLASS[child.status]}`}>
                {tc(`statuses.${child.status}`)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
