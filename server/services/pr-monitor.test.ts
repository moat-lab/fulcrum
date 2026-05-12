import { describe, test, expect, beforeEach } from 'bun:test'
import { pullAfterMerge } from './pr-monitor'

type GitPullResult = { success: boolean; error?: string }
type NotificationPayload = {
  title: string
  message: string
  type: string
  taskId?: string
  taskTitle?: string
}

let gitPullCalls: string[] = []
let gitPullResult: GitPullResult = { success: true }
let notificationCalls: NotificationPayload[] = []

const deps = {
  gitPull: (repoPath: string): GitPullResult => {
    gitPullCalls.push(repoPath)
    return gitPullResult
  },
  sendNotification: async (payload: NotificationPayload) => {
    notificationCalls.push(payload)
    return []
  },
}

beforeEach(() => {
  gitPullCalls = []
  gitPullResult = { success: true }
  notificationCalls = []
})

describe('pullAfterMerge', () => {
  test('hostId 非空时跳过 gitPull 且不发 deployment_failed 通知', () => {
    pullAfterMerge(
      {
        id: 'task-remote',
        title: 'remote task',
        repoPath: '/remote/path/that/does/not/exist/locally',
        hostId: 'host-1',
      },
      deps
    )

    expect(gitPullCalls).toEqual([])
    expect(notificationCalls).toEqual([])
  })

  test('hostId 非空 + repoPath 为 null 也静默跳过', () => {
    pullAfterMerge(
      {
        id: 'task-remote-no-path',
        title: 'remote task no path',
        repoPath: null,
        hostId: 'host-1',
      },
      deps
    )

    expect(gitPullCalls).toEqual([])
    expect(notificationCalls).toEqual([])
  })

  test('hostId 为空且 gitPull 失败仍发 deployment_failed 通知', async () => {
    gitPullResult = { success: false, error: 'No such file or directory' }

    pullAfterMerge(
      {
        id: 'task-local',
        title: 'local task',
        repoPath: '/local/missing/repo',
        hostId: null,
      },
      deps
    )

    // sendNotification 通过 .catch 链异步消费；让出一次 microtask 等待 push。
    await Promise.resolve()

    expect(gitPullCalls).toEqual(['/local/missing/repo'])
    expect(notificationCalls.length).toBe(1)
    expect(notificationCalls[0].type).toBe('deployment_failed')
    expect(notificationCalls[0].taskId).toBe('task-local')
  })

  test('hostId 为空且 gitPull 成功不发通知', async () => {
    gitPullResult = { success: true }

    pullAfterMerge(
      {
        id: 'task-local-ok',
        title: 'local task ok',
        repoPath: '/local/ok/repo',
        hostId: null,
      },
      deps
    )

    await Promise.resolve()

    expect(gitPullCalls).toEqual(['/local/ok/repo'])
    expect(notificationCalls).toEqual([])
  })

  test('hostId 与 repoPath 同为 null 走 no-op', () => {
    pullAfterMerge(
      {
        id: 'task-noop',
        title: 'noop task',
        repoPath: null,
        hostId: null,
      },
      deps
    )

    expect(gitPullCalls).toEqual([])
    expect(notificationCalls).toEqual([])
  })
})
