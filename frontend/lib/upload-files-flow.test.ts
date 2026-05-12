import { describe, expect, test } from 'bun:test'
import {
  UploadConflictError,
  type UploadFileArgs,
  type UploadResult,
} from '../hooks/use-upload-to-filesystem'
import {
  handleFilesDroppedFlow,
  uploadOneFile,
  type UploadFlowDeps,
  type UploadFlowToast,
  type UploadFlowTranslate,
} from './upload-files-flow'

interface ToastWarningCall {
  message: string
  actionLabel?: string
  actionOnClick?: () => void
}

interface ToastErrorCall {
  message: string
  description?: string
}

interface RecordedToast {
  successCalls: string[]
  warningCalls: ToastWarningCall[]
  errorCalls: ToastErrorCall[]
  toast: UploadFlowToast
}

function recordToast(): RecordedToast {
  const successCalls: string[] = []
  const warningCalls: ToastWarningCall[] = []
  const errorCalls: ToastErrorCall[] = []
  const toast: UploadFlowToast = {
    success: (message) => {
      successCalls.push(message)
    },
    warning: (message, options) => {
      warningCalls.push({
        message,
        actionLabel: options?.action?.label,
        actionOnClick: options?.action?.onClick,
      })
    },
    error: (message, options) => {
      errorCalls.push({ message, description: options?.description })
    },
  }
  return { successCalls, warningCalls, errorCalls, toast }
}

const echoTranslate: UploadFlowTranslate = (key, options) => {
  if (options && 'count' in options) return `${key}:${options.count as number}`
  if (options && 'name' in options) return `${key}:${options.name as string}`
  return key
}

interface UploadStubControl {
  uploadFile: UploadFlowDeps['uploadFile']
  calls: UploadFileArgs[]
}

function stubUploadFile(
  responses: ReadonlyArray<UploadResult | Error>
): UploadStubControl {
  const calls: UploadFileArgs[] = []
  let i = 0
  const uploadFile: UploadFlowDeps['uploadFile'] = async (args) => {
    calls.push(args)
    const r = responses[i++]
    if (r === undefined) {
      throw new Error(`uploadFile stub exhausted at call ${i}`)
    }
    if (r instanceof Error) throw r
    return r
  }
  return { uploadFile, calls }
}

function makeFile(name: string, content = 'hello'): File {
  return new File([content], name, { type: 'text/plain' })
}

interface DepsHandle {
  deps: UploadFlowDeps
  closeFileCalls: string[]
  refreshTreeCount: () => number
}

function makeDeps(
  uploadFile: UploadFlowDeps['uploadFile'],
  toast: UploadFlowToast
): DepsHandle {
  const closeFileCalls: string[] = []
  const counters = { refreshTreeCalls: 0 }
  const deps: UploadFlowDeps = {
    worktreePath: '/repo',
    uploadFile,
    refreshTree: async () => {
      counters.refreshTreeCalls += 1
    },
    closeFile: (path) => {
      closeFileCalls.push(path)
    },
    toast,
    t: echoTranslate,
  }
  return {
    deps,
    closeFileCalls,
    refreshTreeCount: () => counters.refreshTreeCalls,
  }
}

describe('uploadOneFile', () => {
  test('returns true and sends overwrite=false on first successful upload', async () => {
    const stub = stubUploadFile([
      { path: '/repo/dropped.txt', size: 5, mtime: '2026-05-12T00:00:00Z' },
    ])
    const rec = recordToast()
    const h = makeDeps(stub.uploadFile, rec.toast)

    const ok = await uploadOneFile(h.deps, makeFile('dropped.txt'), '', false)

    expect(ok).toBe(true)
    expect(stub.calls).toHaveLength(1)
    expect(stub.calls[0].targetDir).toBe('')
    expect(stub.calls[0].worktreePath).toBe('/repo')
    expect(stub.calls[0].overwrite).toBe(false)
    expect(stub.calls[0].file.name).toBe('dropped.txt')
    expect(rec.successCalls).toHaveLength(0)
    expect(rec.warningCalls).toHaveLength(0)
    expect(rec.errorCalls).toHaveLength(0)
    expect(h.closeFileCalls).toHaveLength(0)
  })

  test('overwrite=true closes any cached editor buffer for the overwritten path', async () => {
    const stub = stubUploadFile([
      { path: '/repo/src/dup.txt', size: 3, mtime: '2026-05-12T00:00:00Z' },
    ])
    const rec = recordToast()
    const h = makeDeps(stub.uploadFile, rec.toast)

    const ok = await uploadOneFile(h.deps, makeFile('dup.txt'), 'src', true)

    expect(ok).toBe(true)
    expect(stub.calls[0].overwrite).toBe(true)
    expect(h.closeFileCalls).toEqual(['/repo/src/dup.txt'])
  })

  test('shows a conflict toast with an Overwrite action when the server returns 409', async () => {
    const stub = stubUploadFile([new UploadConflictError('/repo/dup.txt')])
    const rec = recordToast()
    const h = makeDeps(stub.uploadFile, rec.toast)

    const ok = await uploadOneFile(h.deps, makeFile('dup.txt'), '', false)

    expect(ok).toBe(false)
    expect(rec.warningCalls).toHaveLength(1)
    expect(rec.warningCalls[0].message).toBe(
      'detailView.fileTree.uploadToast.conflict:dup.txt'
    )
    expect(rec.warningCalls[0].actionLabel).toBe(
      'detailView.fileTree.uploadToast.overwrite'
    )
    expect(typeof rec.warningCalls[0].actionOnClick).toBe('function')
    expect(rec.errorCalls).toHaveLength(0)
    expect(rec.successCalls).toHaveLength(0)
  })

  test('Overwrite toast action retries with overwrite=true and triggers refreshTree on success', async () => {
    const stub = stubUploadFile([
      new UploadConflictError('/repo/dup.txt'),
      { path: '/repo/dup.txt', size: 3, mtime: '2026-05-12T00:00:00Z' },
    ])
    const rec = recordToast()
    const h = makeDeps(stub.uploadFile, rec.toast)

    await uploadOneFile(h.deps, makeFile('dup.txt'), '', false)
    expect(rec.warningCalls).toHaveLength(1)

    const action = rec.warningCalls[0].actionOnClick
    expect(action).toBeDefined()
    action!()
    // The toast action schedules an async retry; let the microtask queue drain.
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    expect(stub.calls).toHaveLength(2)
    expect(stub.calls[1].overwrite).toBe(true)
    expect(h.closeFileCalls).toEqual(['/repo/dup.txt'])
    expect(h.refreshTreeCount()).toBe(1)
  })

  test('shows an error toast with the failure description on non-conflict failures', async () => {
    const stub = stubUploadFile([new Error('upload too large')])
    const rec = recordToast()
    const h = makeDeps(stub.uploadFile, rec.toast)

    const ok = await uploadOneFile(h.deps, makeFile('big.bin'), '', false)

    expect(ok).toBe(false)
    expect(rec.errorCalls).toHaveLength(1)
    expect(rec.errorCalls[0].message).toBe(
      'detailView.fileTree.uploadToast.error'
    )
    expect(rec.errorCalls[0].description).toBe('upload too large')
    expect(rec.warningCalls).toHaveLength(0)
  })
})

describe('handleFilesDroppedFlow', () => {
  test('no-ops on an empty file list', async () => {
    const stub = stubUploadFile([])
    const rec = recordToast()
    const h = makeDeps(stub.uploadFile, rec.toast)

    await handleFilesDroppedFlow(h.deps, [], '')

    expect(stub.calls).toHaveLength(0)
    expect(rec.successCalls).toHaveLength(0)
    expect(h.refreshTreeCount()).toBe(0)
  })

  test('uploads each dropped file sequentially, then refreshes tree and toasts success', async () => {
    const stub = stubUploadFile([
      { path: '/repo/dir/a.txt', size: 1, mtime: '2026-05-12T00:00:00Z' },
      { path: '/repo/dir/b.txt', size: 1, mtime: '2026-05-12T00:00:00Z' },
    ])
    const rec = recordToast()
    const h = makeDeps(stub.uploadFile, rec.toast)

    await handleFilesDroppedFlow(
      h.deps,
      [makeFile('a.txt'), makeFile('b.txt')],
      'dir'
    )

    expect(stub.calls).toHaveLength(2)
    expect(stub.calls[0].targetDir).toBe('dir')
    expect(stub.calls[0].overwrite).toBe(false)
    expect(stub.calls[1].targetDir).toBe('dir')
    expect(h.refreshTreeCount()).toBe(1)
    expect(rec.successCalls).toEqual([
      'detailView.fileTree.uploadToast.success:2',
    ])
  })

  test('a per-file conflict surfaces a warning toast but does not block other files or the success toast', async () => {
    const stub = stubUploadFile([
      new UploadConflictError('/repo/a.txt'),
      { path: '/repo/b.txt', size: 1, mtime: '2026-05-12T00:00:00Z' },
    ])
    const rec = recordToast()
    const h = makeDeps(stub.uploadFile, rec.toast)

    await handleFilesDroppedFlow(
      h.deps,
      [makeFile('a.txt'), makeFile('b.txt')],
      ''
    )

    expect(stub.calls).toHaveLength(2)
    expect(rec.warningCalls).toHaveLength(1)
    expect(rec.warningCalls[0].message).toBe(
      'detailView.fileTree.uploadToast.conflict:a.txt'
    )
    expect(rec.successCalls).toEqual([
      'detailView.fileTree.uploadToast.success:1',
    ])
    expect(h.refreshTreeCount()).toBe(1)
  })

  test('all files conflicting yields no success toast and no refreshTree', async () => {
    const stub = stubUploadFile([
      new UploadConflictError('/repo/a.txt'),
      new UploadConflictError('/repo/b.txt'),
    ])
    const rec = recordToast()
    const h = makeDeps(stub.uploadFile, rec.toast)

    await handleFilesDroppedFlow(
      h.deps,
      [makeFile('a.txt'), makeFile('b.txt')],
      ''
    )

    expect(rec.successCalls).toHaveLength(0)
    expect(h.refreshTreeCount()).toBe(0)
    expect(rec.warningCalls).toHaveLength(2)
  })
})
