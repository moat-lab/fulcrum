import { eq } from 'drizzle-orm'
import { db, terminals } from '../db'
import { getDtachService } from '../terminal/dtach-service'
import { getHerdrService, HerdrService } from '../terminal/herdr-service'
import { resolveWorkspaceForTaskId } from './herdr-workspace-mapper'
import { getSetting } from '../lib/settings'
import { log } from '../lib/logger'

/**
 * Mirror a fulcrum dtach-backed terminal into a herdr tab so the same shell
 * is reachable from a plain SSH client via `herdr --session <name>`.
 *
 * Implementation:
 *   1. Ensure the herdr workspace for this task exists (one per project;
 *      "scratch" for non-git tasks).
 *   2. Create a tab labeled with the task title.
 *   3. In the tab's root pane, run `dtach -a <socket-path>` — that pane is
 *      now a second attached client to the same dtach session the browser
 *      uses.
 *   4. Persist {workspaceId, tabId, paneId} onto the terminals row.
 *
 * Idempotent: if the row already has a herdrTabId it's a no-op. All errors
 * are logged but never propagated — mirror failure must not break the
 * browser path.
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

    const { workspace } = await svc.ensureWorkspace({
      label: target.workspaceLabel,
      cwd: target.workspaceCwd,
    })

    const tab = await svc.createTab({
      workspaceId: workspace.workspace_id,
      label: target.tabLabel,
      cwd: target.workspaceCwd,
    })

    const dtach = getDtachService()
    const socketPath = dtach.getSocketPath(terminalId)
    // Match the existing attach command shape (see dtach-service.ts:188-191).
    // `-z` makes dtach pass control characters straight through.
    await svc.runInPane(tab.root_pane.pane_id, `stty -echoctl && exec dtach -a ${socketPath} -z`)

    // Tell herdr what agent is running inside this pane. Herdr's own
    // process-introspection only sees `dtach -a` since the real agent
    // lives on the other side of the socket — without this, the agents
    // sidebar would be empty even though Claude/OpenCode/Codex is alive.
    // We report `working` because the agent is being launched right now;
    // herdr's own output_matched heuristics will refine it from there.
    try {
      await svc.reportAgent(tab.root_pane.pane_id, {
        source: 'fulcrum',
        agent: target.agent,
        state: 'working',
        message: target.tabLabel,
      })
    } catch (err) {
      // Non-fatal — agent labeling is a nicety, not load-bearing.
      log.terminal.debug('reportAgent failed (non-fatal)', {
        terminalId,
        paneId: tab.root_pane.pane_id,
        error: String(err),
      })
    }

    const now = new Date().toISOString()
    db.update(terminals)
      .set({
        herdrWorkspaceId: workspace.workspace_id,
        herdrTabId: tab.tab.tab_id,
        herdrPaneId: tab.root_pane.pane_id,
        updatedAt: now,
      })
      .where(eq(terminals.id, terminalId))
      .run()

    log.terminal.info('herdr mirror created', {
      terminalId,
      taskId: row.taskId,
      workspaceLabel: target.workspaceLabel,
      tabLabel: target.tabLabel,
      paneId: tab.root_pane.pane_id,
    })
  } catch (err) {
    log.terminal.warn('mirrorTerminal: failed (continuing without mirror)', {
      terminalId,
      taskId: row.taskId,
      error: String(err),
    })
  }
}

/**
 * Close the herdr tab created for a terminal. Honors the
 * `terminal.herdr.autoCloseTab` setting; no-op when disabled.
 */
export async function closeMirror(terminalId: string): Promise<void> {
  if (!isMirrorEnabled()) return
  const autoClose = getSetting('terminal.herdr.autoCloseTab')
  if (autoClose === false) return

  const row = db.select().from(terminals).where(eq(terminals.id, terminalId)).get()
  if (!row?.herdrTabId) return

  try {
    const svc = getHerdrService()
    if (!svc.isServerRunning()) {
      log.terminal.debug('closeMirror: herdr server not running; skipping close', { terminalId })
      // Still clear the stale ids so future mirror attempts don't think
      // a tab already exists.
      clearMirrorIds(terminalId)
      return
    }
    await svc.closeTab(row.herdrTabId)
    log.terminal.info('herdr mirror closed', { terminalId, tabId: row.herdrTabId })
  } catch (err) {
    log.terminal.warn('closeMirror: failed', {
      terminalId,
      tabId: row.herdrTabId,
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
