import type { Task, TaskStatus } from '../../shared/types'

const STATUS_ORDER: Record<TaskStatus, number> = {
  IN_PROGRESS: 0,
  IN_REVIEW: 1,
  TO_DO: 2,
  DONE: 3,
  CANCELED: 4,
}

function compareDerived(a: Task, b: Task): number {
  const orderDiff = STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
  if (orderDiff !== 0) return orderDiff
  return b.createdAt.localeCompare(a.createdAt)
}

export function selectDerivedTasks(tasks: readonly Task[] | undefined, taskId: string): Task[] {
  return (tasks ?? [])
    .filter((task) => task.derivedFromTaskId === taskId)
    .slice()
    .sort(compareDerived)
}
