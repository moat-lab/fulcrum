import { and, eq, isNotNull, ne } from 'drizzle-orm'
import { db, terminals } from '../db'
import { getDtachService } from '../terminal/dtach-service'
import { getHerdrService, HerdrService } from '../terminal/herdr-service'
import { resolveWorkspaceForTaskId } from './herdr-workspace-mapper'
import { getSetting } from '../lib/settings'
import { log } from '../lib/logger'
import { waitForMirrorAttached } from './herdr-winsize-sync'
import { getPTYManager } from '../terminal/pty-instance'

/**
 * Mirror a fulcrum dtach-backed terminal into a herdr tab so the same shell
 * is reachable from a plain SSH client via `herdr --session <name>`.
 *
 * Implementation:
 *   1. Ensure the herdr workspace for this task exists (one per project;
 *      "scratch" for non-git tasks).
 *   2. If another terminal for the same task already has a herdr pane, split
 *      that pane vertically and reuse its tab — one task = one tab. Otherwise
 *      create a fresh tab labeled with the task title.
 *   3. In the (new or existing) pane, run `dtach -a <socket-path>` — that
 *      pane is now a second attached client to the same dtach session the
 *      browser uses.
 *   4. Persist {workspaceId, tabId, paneId} onto the terminals row.
 *
 * Idempotent: if the row already has a herdrTabId it's a no-op. All errors
 * are logged but never propagated — mirror failure must not break the
 * browser path.
 *
 * Race-tolerance: if the right-column shell mirrors before the left-column
 * agent has finished mirroring, no sibling is found and we fall through to
 * the createTab branch — same as if there were no agent terminal at all.
 * Worst case the user briefly sees two tabs; harmless.
 */
export async function mirrorTerminal(terminalId: string): Promise<void> {
  if (!isMirrorEnabled()) return

  const row = db.select().from(terminals).where(eq(terminals.id, terminalId)).get()
  if (!row) {
    log.terminal.warn('mirrorTerminal: terminal row not found', { terminalId })
    return
  }
  if (row.herdrTabId) {
    // Already mirrored
    return
  }
  if (!row.taskId) {
    // Terminals that aren't tied to a task (ad-hoc tabs) aren't mirrored
    return
  }

  const target = resolveWorkspaceForTaskId(row.taskId)
  if (!target) return

  try {
    const svc = getHerdrService()
    const reachable = await svc.ensureServerRunning()
    if (!reachable) {
      log.terminal.warn('mirrorTerminal: herdr server unreachable; skipping', {
        terminalId,
        session: (getSetting('terminal.herdr.session') as string) || 'fulcrum',
      })
      return
    }

    const sibling = findSiblingWithPane(row.taskId, terminalId)

    let workspaceId: string
    let tabId: string
    let paneId: string
    let isSplit = false

    if (sibling) {
      const split = await svc.splitPane({
        targetPaneId: sibling.herdrPaneId!,
        direction: 'right',
        cwd: target.workspaceCwd,
        focus: false,
      })
      workspaceId = sibling.herdrWorkspaceId!
      tabId = sibling.herdrTabId!
      paneId = split.pane.pane_id
      isSplit = true
    } else {
      const { workspace } = await svc.ensureWorkspace({
        label: target.workspaceLabel,
        cwd: target.workspaceCwd,
      })
      const tab = await svc.createTab({
        workspaceId: workspace.workspace_id,
        label: target.tabLabel,
        cwd: target.workspaceCwd,
      })
      workspaceId = workspace.workspace_id
      tabId = tab.tab.tab_id
      paneId = tab.root_pane.pane_id
    }

    const dtach = getDtachService()
    const socketPath = dtach.getSocketPath(terminalId)
    // Match the existing attach command shape (see dtach-service.ts:188-191).
    // `-z` makes dtach pass control characters straight through.
    await svc.runInPane(paneId, `stty -echoctl && exec dtach -a ${socketPath} -z`)

    // The herdr-side dtach -a will SIGWINCH the master to herdr's pane size
    // as soon as it attaches, which leaves the browser-side rendering against
    // a mismatched master. Wait for the dtach -a to appear, then re-trigger
    // resize at the browser's known dimensions — TerminalSession.resize then
    // clips to min(browser, herdr) so both views fit. Fire-and-forget.
    void waitForMirrorAttached(terminalId).then(() => {
      const info = getPTYManager().getInfo(terminalId)
      if (info) getPTYManager().resize(terminalId, info.cols, info.rows)
    })

    // Only the primary pane (created via tab.create) hosts the AI agent.
    // Split panes are plain shells — reporting them as agents would lie to
    // herdr's agents sidebar.
    if (!isSplit) {
      try {
        await svc.reportAgent(paneId, {
          source: 'fulcrum',
          agent: target.agent,
          state: 'working',
          message: target.tabLabel,
        })
        log.terminal.info('herdr agent reported', {
          terminalId,
          paneId,
          agent: target.agent,
        })
      } catch (err) {
        // Non-fatal — agent labeling is a nicety, not load-bearing.
        log.terminal.warn('reportAgent failed (non-fatal)', {
          terminalId,
          paneId,
          error: String(err),
        })
      }
    }

    const now = new Date().toISOString()
    db.update(terminals)
      .set({
        herdrWorkspaceId: workspaceId,
        herdrTabId: tabId,
        herdrPaneId: paneId,
        updatedAt: now,
      })
      .where(eq(terminals.id, terminalId))
      .run()

    log.terminal.info('herdr mirror created', {
      terminalId,
      taskId: row.taskId,
      workspaceLabel: target.workspaceLabel,
      tabLabel: target.tabLabel,
      paneId,
      split: isSplit,
    })
  } catch (err) {
    log.terminal.warn('mirrorTerminal: failed (continuing without mirror)', {
      terminalId,
      taskId: row.taskId,
      error: String(err),
    })
  }
}

function findSiblingWithPane(taskId: string, selfTerminalId: string) {
  return db
    .select()
    .from(terminals)
    .where(
      and(
        eq(terminals.taskId, taskId),
        ne(terminals.id, selfTerminalId),
        isNotNull(terminals.herdrPaneId),
        isNotNull(terminals.herdrTabId),
        isNotNull(terminals.herdrWorkspaceId)
      )
    )
    .get()
}

/**
 * Close the herdr pane created for a terminal. Honors the
 * `terminal.herdr.autoCloseTab` setting; no-op when disabled.
 *
 * Closes the pane rather than the whole tab so that sibling panes (e.g. the
 * agent pane when destroying the right-column shell, or vice versa) survive.
 * Herdr cleans up the parent tab automatically when its last pane closes,
 * so single-pane tabs behave the same as before.
 */
export async function closeMirror(terminalId: string): Promise<void> {
  if (!isMirrorEnabled()) return
  const autoClose = getSetting('terminal.herdr.autoCloseTab')
  if (autoClose === false) return

  const row = db.select().from(terminals).where(eq(terminals.id, terminalId)).get()
  if (!row?.herdrPaneId) return

  try {
    const svc = getHerdrService()
    if (!svc.isServerRunning()) {
      log.terminal.debug('closeMirror: herdr server not running; skipping close', { terminalId })
      // Still clear the stale ids so future mirror attempts don't think
      // a pane already exists.
      clearMirrorIds(terminalId)
      return
    }
    await svc.closePane(row.herdrPaneId)
    log.terminal.info('herdr mirror closed', { terminalId, paneId: row.herdrPaneId })
  } catch (err) {
    log.terminal.warn('closeMirror: failed', {
      terminalId,
      paneId: row.herdrPaneId,
      error: String(err),
    })
  } finally {
    clearMirrorIds(terminalId)
  }
}

/** Test-friendly: re-mirror any task-bound terminals that have lost their pane. */
export async function reconcileMirrorOnRestore(terminalId: string): Promise<void> {
  if (!isMirrorEnabled()) return
  const row = db.select().from(terminals).where(eq(terminals.id, terminalId)).get()
  if (!row?.herdrPaneId) {
    // Not yet mirrored — try a fresh mirror now.
    if (row?.taskId) await mirrorTerminal(terminalId)
    return
  }

  try {
    const svc = getHerdrService()
    if (!svc.isServerRunning()) return
    const alive = await svc.paneExists(row.herdrPaneId)
    if (alive) return
    clearMirrorIds(terminalId)
    await mirrorTerminal(terminalId)
  } catch (err) {
    log.terminal.warn('reconcileMirrorOnRestore: failed', {
      terminalId,
      error: String(err),
    })
  }
}

/**
 * Close every herdr tab that was mirrored from any terminal belonging to the
 * given task. Used when a task is deleted, so the user doesn't end up with an
 * orphan tab in herdr after the worktree and DB row are gone.
 *
 * Unlike {@link closeMirror} this ignores the per-terminal `autoCloseTab`
 * setting — deleting the task is an explicit user action that should always
 * tear the tab down regardless of the auto-close-on-terminal-destroy preference.
 *
 * Fire-and-forget: errors are logged but never thrown. The DB rows are not
 * touched here; the task delete path drops the terminal rows separately.
 */
export async function closeHerdrTabsForTask(taskId: string): Promise<void> {
  if (!isMirrorEnabled()) return

  const rows = db
    .select()
    .from(terminals)
    .where(and(eq(terminals.taskId, taskId), isNotNull(terminals.herdrTabId)))
    .all()

  const tabIds = new Set<string>()
  for (const r of rows) {
    if (r.herdrTabId) tabIds.add(r.herdrTabId)
  }
  if (tabIds.size === 0) return

  try {
    const svc = getHerdrService()
    if (!svc.isServerRunning()) {
      log.terminal.debug('closeHerdrTabsForTask: herdr server not running; skipping', { taskId })
      return
    }
    for (const tabId of tabIds) {
      try {
        await svc.closeTab(tabId)
        log.terminal.info('herdr tab closed for deleted task', { taskId, tabId })
      } catch (err) {
        log.terminal.warn('closeHerdrTabsForTask: closeTab failed', {
          taskId,
          tabId,
          error: String(err),
        })
      }
    }
  } catch (err) {
    log.terminal.warn('closeHerdrTabsForTask: failed', { taskId, error: String(err) })
  }
}

function clearMirrorIds(terminalId: string): void {
  db.update(terminals)
    .set({
      herdrWorkspaceId: null,
      herdrTabId: null,
      herdrPaneId: null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(terminals.id, terminalId))
    .run()
}

function isMirrorEnabled(): boolean {
  const enabled = getSetting('terminal.herdr.enabled')
  if (enabled !== true) return false
  // Cheap pre-check: if the binary isn't installed, don't even try.
  const binary = (getSetting('terminal.herdr.binary') as string) || 'herdr'
  return HerdrService.isAvailable(binary)
}
