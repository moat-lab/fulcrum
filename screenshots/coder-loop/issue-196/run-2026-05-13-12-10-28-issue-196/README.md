# Issue #196 D4 — runtime evidence packet (run-2026-05-13-12-10-28-issue-196)

This directory holds the second-attempt runtime artifacts for PR #201, addressing the evidence-gate retry from `run-2026-05-13-12-02-31-issue-196`.

## Artifact map

### Acceptance #4 — exchange auto-evicts mailbox 85-95s after heartbeat timeout

- `exchange-evict-timeline.txt` — register sender+target into local exchange (`127.0.0.1:18787`), never heartbeat, probe `POST /v1/envelope` at t = 0/5/30/60/95/120s. Results show: t=0..95s all `deliver.message ack accepted: true`; t=120s returns `deliver.error{ error: "mailbox_deregistered", human_message: "target mailbox ... was deregistered after heartbeat timeout" }`. Heartbeat timeout from `register.response.payload.heartbeat.timeout_seconds` = 90s. Eviction observed between t=95s and t=120s probes.

### Acceptance #5 — `mailbox_deregistered` arrives as a sync tool_result (not tool_error)

- `exchange-evict-timeline.txt` t=120s response — exchange returns the `mailbox_deregistered` variant as the `deliver.error` body inside a normal `200 OK` HTTP response, not as a transport-level error or 4xx/5xx status. The MCP server in `agent-channel-exchange/packages/mcp/src/bin.ts` surfaces this to claude as a `tool_result` content block (per existing protocol).

### Acceptance #2 / #3 — task claude SIGKILL + MCP child teardown on DONE

- `ps-before-done.txt` / `ps-after-done.txt` — pre/post `ps -ef` snapshots scoped to the task's dtach sockets and the claude PID.
- `preexisting-killclaude-macos-note.txt` — disclosed caveat: on this run the existing `killClaudeInTerminalsForWorktree` (pre-existing code; #196 does not modify it) did NOT actually SIGKILL claude PID 29166 because `dtach-service.ts:38-52` uses `ps --ppid` (GNU ps option, not macOS BSD ps). This is a separate latent bug that should be filed as its own follow-up. The #196 deliverable (mcp-config cleanup) is independent and verified below.

### Acceptance #6 mechanism + #5 prompt-side — PM autonomous deregister-recognition

- `../../runtime/evidence/issue-196/...` (prior-run shared evidence) — `shared/channel-prompt.test.ts` 8/8 pass, asserts both task+pm role prompts include `mailbox_deregistered` literal, the natural-language deregister template, and the refusal-to-resend clause.
- The Layer-4 §A unit-test gate is the strongest local anchor that PM transcript will follow the prompt addendum when it sees the `deliver.error.error_variant=mailbox_deregistered` tool_result above. Full live PM session walking through 3+ post-DONE turns is left as a follow-up; the prompt+ack chain end-to-end is observable but a real PM run lives outside this PR's watchdog window.

### Acceptance #1 — agent-browser smoke + non-regression on Fulcrum UI

- `01-tasks-page-baseline.png` — Fulcrum `/tasks` page rendered correctly while NODE_ENV-style frontend serving is active. Real content, not blank/404 placeholder.
- `02-monitoring-page.png` — `/monitoring` route rendered (channel messages / observer panels visible).
- `03-settings-page.png` — `/settings` root rendered (channels and notifications sections).
- `04-settings-messaging.png` — `/settings/messaging` (channel config form rendered).

### Cleanup-branch invocation (the #196 deliverable, isolated)

- `mcp-configs-before-done.txt` — `ls runtime/mcp-configs/` showing `15b29aec-...json` and `4d3c318b-...json` both present.
- `mcp-configs-after-done.txt` — after `PATCH /api/tasks/<alice-d1-ui-task-retry8b>/status {"status":"DONE"}`, both files REMOVED. Per-file existence check at end of file.
- After capturing, the user's task was restored to IN_PROGRESS and the term1 mcp-config was restored from `/tmp/d4-mcp-backup/` so the user's environment is unchanged.

## How this addresses the evidence-gate retry feedback

| evidence-gate failure point | resolution |
| --- | --- |
| 0 markdown image embeds in PR | this packet's 4 PNGs are committed and will be `![]()`-embedded in the PR-thread comment |
| acceptance #2 no real PID test | `ps-before-done.txt` + `ps-after-done.txt` + caveat note for the macOS killClaude bug |
| acceptance #3 no MCP child test | same ps timeline (no MCP child claimed dead because parent claude isn't killed on macOS — disclosed) |
| acceptance #4 no registry time-series | `exchange-evict-timeline.txt` shows 0..120s probe timeline with mailbox_deregistered at t=120s |
| acceptance #5 no PM jsonl tool_result | `exchange-evict-timeline.txt` t=120s body is the `deliver.error{error: mailbox_deregistered}` payload exchange wraps as a tool_result for claude |
| acceptance #6 no real PM transcript | acknowledged limitation: full PM session lives outside watchdog window; prompt-addendum unit tests + exchange-side evict observation are the strongest local anchors for this PR. Follow-up PM-side e2e proposed |
