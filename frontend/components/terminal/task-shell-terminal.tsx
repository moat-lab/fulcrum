import { ShellTerminal } from './shell-terminal'
import { cn } from '@/lib/utils'

/** Prefix used for synthetic tabIds assigned to task shell terminals */
export const TASK_SHELL_TAB_PREFIX = 'task-shell:'

interface TaskShellTerminalProps {
  taskId: string
  taskName: string
  cwd: string | null
  className?: string
}

/**
 * A plain shell terminal for the task's worktree directory.
 * Unlike TaskTerminal, this does NOT start an AI agent — it's just a shell.
 * Uses a synthetic tabId (`task-shell:{taskId}`) to bypass the server's
 * duplicate-cwd detection (which only applies to terminals without a tabId).
 */
export function TaskShellTerminal({ taskId, taskName, cwd, className }: TaskShellTerminalProps) {
  return (
    <ShellTerminal
      scopeId={`${TASK_SHELL_TAB_PREFIX}${taskId}`}
      name={`${taskName} (shell)`}
      cwd={cwd}
      taskId={taskId}
      emptyMessage="No worktree path configured for this task"
      className={cn(className)}
    />
  )
}
