# coder-loop workflow for Fulcrum

## Goal

尽可能解决所有可实现的 open issue。优先级只用于排序，不限制范围。不要只处理前几个 issue；完成一个后继续队列中的下一个 actionable leaf issue。

## Source of truth

- Queue/order/state: `.coder-loop/state.json`
- Current issue handoff: `.coder-loop/issues/<issue>.md`
- Shared durable facts: `.coder-loop/shared.md`
- Live GitHub issue/PR state verifies reality
- `CLAUDE.md` is Fulcrum project reference only. It is not the loop workflow.

If this workflow conflicts with target `CLAUDE.md` about loop process, queue state, PR evidence, or browser evidence, follow this workflow.

## Non-negotiable PR rules

- One PR closes exactly one issue.
- PR body first line must be `Closes #N`.
- PR title and body must be Chinese.
- PR body must include four evidence layers and an `Analysis` section.
- Every PR must include local agent-browser E2E screenshot evidence saved directly under `screenshots/coder-loop/issue-N/<runId>/` or another clearly scoped tracked `screenshots/` path in the PR branch, committed with the PR, and embedded in the PR body as public GitHub raw/blob image URLs.
- PR body must paste concise build/test log excerpts in the relevant evidence layer; do not require reviewers to checkout the branch or inspect local files for basic evidence.
- Once an implementation PR exists, implementation feedback and retry/acceptance discussion must stay on the PR thread. Use issue comments only for the issue topic itself, no-PR blocked/moot classifications, or explicitly closing an invalid PR and explaining replacement.
- Review owns the final gate for the current PR: accepted PRs are commented on and merged by the review agent when checks/evidence/mergeability pass; rejected PRs are sent back on the PR thread with actionable feedback.
- Review is evidence-first: it does not run tests, start servers, capture screenshots, or repair evidence itself. It first checks whether the PR body/thread contains enough evidence to judge reality; insufficient evidence is rejected before code review.
- Unit tests alone are not enough for UI/runtime/integration changes. Evidence must prove the change lands in the running product through build/test excerpts, startup/runtime ordering where relevant, and browser screenshots.
- Screenshots are decisive evidence: they must show the actual changed behavior and relevant positive/negative/disabled/error states. Nearby smoke screenshots, missing elements, wrong visual states, or ambiguous screenshots are insufficient.
- Do not stage `.coder-loop/`, `.dev-loop`, or `.dev-trace.txt` into feature PRs.

## Required PR body skeleton

```markdown
Closes #N

## 摘要

<1-3 句中文。>

## 变更预演（Layer 1）

<dry-run / diff / migration preview / not applicable reason + 中文分析。>

## 落地核对（Layer 2）

<files, code paths, tests, config, migration checks + 中文分析。>

## 启动 / 运行时顺序（Layer 3）

<dev server / service / startup / CI / deploy ordering evidence or not applicable reason + 中文分析。>

## 端到端业务行为（Layer 4）

<local agent-browser E2E evidence. Include public GitHub raw/blob image URLs for screenshots committed in this PR branch under `screenshots/coder-loop/issue-N/<runId>/` or another clearly scoped tracked `screenshots/` path, plus what each screenshot proves. Include positive and negative/error/disabled cases where applicable. Screenshots must show the actual changed behavior; unrelated smoke pages or visually incorrect/ambiguous captures are insufficient.>

## Analysis

<2-4 句中文说明证据是否足够可信、还剩什么风险。>
```

## Verification commands

Use project commands from Fulcrum `CLAUDE.md`:

- Build/type validation: `mise run build`
- Full tests: `mise run test`
- Focused tests: `mise run test:file <path>`

Critical rule: never run `bun test` directly in Fulcrum. The mise test tasks isolate `HOME` and `FULCRUM_DIR` before Bun starts.

## Browser/E2E evidence

Every PR must use local agent-browser E2E and save reviewer-visible screenshots directly under `screenshots/coder-loop/issue-N/<runId>/` or another clearly scoped tracked `screenshots/` path in the PR branch. Review does not create missing evidence; iteration must provide it in the PR body/thread.

Minimum expectation:

- Start the Fulcrum dev server when UI/browser behavior is involved.
- Use local agent-browser to exercise the golden path.
- Exercise at least one negative/error/disabled path when applicable.
- Ensure screenshots visibly show the changed feature and state. If they do not show the changed element, show the wrong visual state, or only prove an unrelated smoke page, review must reject the PR for insufficient evidence.
- Save screenshots directly under `screenshots/coder-loop/issue-N/<runId>/...` in the PR branch and commit them with the PR.
- Embed public GitHub raw/blob image URLs for those committed screenshots in PR Layer 4.
- Paste concise build/test log excerpts directly in the PR evidence layers.

For backend/config/CLI-only issues, still use agent-browser to open the closest relevant Fulcrum UI/status/settings page or a smoke page and capture a no-regression screenshot, unless impossible. If impossible, block for review instead of waiving the requirement.

## Issue queue policy

Preserve the concrete recommendation order from `.coder-loop/state.json`:

1. Backlog hygiene / close or classify already implemented and moot issues.
2. Baseline/global reliability: #76, #74, #70, #71.
3. Mattermost foundation: #65, #73, #72, #67, #68.
4. Mattermost productization: #15, #75, #69, #66, #10, #11, #12, #13, #14, #17.
5. CICD/container/remote-only: #33, #34, #35, then parent wrappers #38, #39, #40, #37.
6. Remote host visibility: #23, #22, then wrappers #48, #51.
7. Long-term: #19.

Skip parent/umbrella/moot issues as implementation targets unless their children are complete and the action is only documentation/comment/closure. Review may mark invalid, duplicate, parent/wrapper-only, moot, no-code, or explicitly out-of-scope issues as `moot` after posting the reason on the issue.

Already-satisfied issues on `main` may be marked `done` only after review verifies live evidence and posts the evidence on the issue. PR-backed work becomes `done` only after review accepts and successfully merges the PR.

## Implementation behavior

- Work only on the selected issue for the current invocation.
- Prefer small, direct changes over abstractions.
- Follow existing Fulcrum patterns.
- Prefer type-driven ADT-style modeling where practical.
- Validate only at system boundaries; do not add defensive checks for impossible internal states.
- If a task is too large, implement the smallest complete slice that closes the selected issue or record why review should classify it as blocked/skipped.
- If external services are unavailable, record the blocker so review can decide whether immediate retry would help.

## Review behavior

Review is phase-gated:

1. Phase A — PR conversation gate: one PR closes one issue, first line `Closes #N`, Chinese title/body, four evidence layers plus `Analysis`, and all implementation/review discussion stays on the PR thread once a PR exists.
2. Phase B — evidence gate: build/test excerpts, runtime/startup evidence where relevant, screenshots committed in the PR branch under `screenshots/` and embedded in the PR body via public GitHub raw/blob URLs, and screenshots that visibly prove the changed behavior and relevant negative/disabled/error states.
3. Phase C — code/check/mergeability gate: only after Phase A and B pass, inspect code/diff scope, test weakening, conventions, GitHub checks, and mergeability.

Review rejects PRs that lack:

- `Closes #N` as first line
- Chinese body
- four evidence layers
- `mise run build`
- `mise run test` or focused test plus rationale
- local agent-browser screenshots committed under `screenshots/` in the PR branch and embedded as public GitHub raw/blob URLs
- credible positive and negative-path evidence where applicable
- passing GitHub checks before merge

Review merges complete work only when all phases pass; otherwise it requests changes on the PR, marks a verified blocker, or skips a verified non-actionable issue. Accepted PRs must be merged by review with `gh pr merge`; if merge is unavailable because checks are pending/failing, required review is missing, conflicts exist, mergeability is unknown, or GitHub returns an error, review requests changes instead of waiting for a human.
