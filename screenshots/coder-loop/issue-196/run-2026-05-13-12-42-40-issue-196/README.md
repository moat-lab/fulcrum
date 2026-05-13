# Issue #196 D4 — runtime evidence packet (run-2026-05-13-12-42-40)

第六轮 evidence-gate retry。前轮 (#5, head `2e07b606`) 修了 macOS `getDescendantPids` GNU-only bug；本轮按 review feedback 4441074489 §"下一轮 iteration 必做" 处理 evidence-gate 剩余 #1 (settings/messaging 截图标注错误)、#2 (PM transcript) 与 #4 (DONE-transition 专门帧)。

## 关键修正：`/settings/messaging` 不是 prod build regression

iteration #4 抓到的 "Not Found" 截图是因为 URL 写错。Fulcrum settings 页面的 messaging tab **正确 URL 是 `/settings?tab=messaging`**（query-param tab，见 `frontend/routes/settings/index.tsx:104` `VALID_TABS`），路由表中**从未存在** `/settings/messaging` 路径段。iteration #4 把它当 "prod build regression" 是误判，没有需要在 #196 修也没有需要单独 file regression 的真问题。

## Artifact map

### Acceptance #1 — agent-browser smoke + non-regression（PNG）

- `01-settings-messaging-corrected.png` — `http://127.0.0.1:7778/settings?tab=messaging` 真渲染：邮件与消息 tab，启用通知 toggle、Slack/Discord/Pushover/WhatsApp 4 个 channel 行、保存更改按钮，全中文 UI。**替换** prior run `04-settings-messaging.png` 的 404 截图。
- `02-tasks-page-baseline.png` — DONE 前 `/tasks` 看板：进行中 6（含 `alice-d1-ui-task-retry8b`）/ 已完成 1 / 已取消 1。
- `03-monitoring-page.png` — `/monitoring` 真渲染（observer + channel-messages panel 可见，非空白）。
- `04-tasks-page-after-done.png` — DONE **后** `/tasks` 看板：进行中 5（少了 retry8b）/ 已完成 2（多了 retry8b）/ 已取消 1。**专门帧 1**（DONE 前 / 后同框对比，第 #4 evidence-gate 失败点的部分回应）。

### Acceptance #1+#2+#3 — DONE-cleanup branch end-to-end runtime（本轮真跑）

- `mcp-configs-before-done.txt` — PATCH DONE 前 `runtime/mcp-configs/` 列表，含 `15b29aec-...json`（alice-d1-ui-task-retry8b 的 terminal mcp-config）。
- `patch-done-response.txt` — `PATCH /api/tasks/50583350.../status {"status":"DONE","position":0}` 返回 `{status: "DONE"}`，API 端真生效。
- `mcp-configs-after-done.txt` — DONE 后同目录列表，`15b29aec-...json` **REMOVED**（cleanup branch 文件系统层面真生效）。末行显式 `test -e ... && STILL_PRESENT || REMOVED` 验证。
- `ps-before-done.txt` / `ps-after-done.txt` — pre/post `ps -ef | grep -E "dtach|claude"` snapshots。

捕获完成后 task 已 restore 回 `IN_PROGRESS`，`15b29aec-...json` 从 `/tmp/d4r6/mcp-backup/` 复原（不动用户环境）。

### Acceptance #2+#3 — SIGKILL chain（依赖 prior commit `2e07b606`）

`server/terminal/dtach-service.ts` 现用 `pgrep -P` 替 GNU-only `ps --ppid`；prior run probe `screenshots/coder-loop/issue-196/run-2026-05-13-12-35-31-issue-196/macos-pgrep-probe.txt` + `macos-kill-tree-probe.txt` 显示 darwin/arm64 上 3-4 级子树 kill 后 300ms 全 dead，verdict `PASS — kill walked tree, all 4 PIDs dead`。

### Acceptance #4+#5 — exchange evict + mailbox_deregistered tool_result（依赖 prior run）

`screenshots/coder-loop/issue-196/run-2026-05-13-12-10-28-issue-196/exchange-evict-timeline.txt` 真跑 `127.0.0.1:18787` 注册/停心跳/t=0..120s deliver 序列，t=120s 出 `deliver.error{error: "mailbox_deregistered"}`。

### Acceptance #6 — PM 自然语言宣告 + 3+ turn 不再发同 to（本轮诚实披露未完成）

未抓到真 PM jsonl `tool_result.content[].error.error_variant == "mailbox_deregistered"`，也未抓 PM 自然语言宣告 transcript。原因：

1. PM Agent Mode session 起飞被环境/UX 耦合阻碍（详见新 file 的 follow-up issue **#202**：`frontend/components/kanban/create-task-modal.tsx:740-744` aiMode auto-switch 把 PM description 输入触发 plan-mode + PM Agent Mode launch helper 环境耦合不稳）；
2. 已 file #202 跟踪；按 prior review comment 4441074489 §"约束" 第三条「若 D2 aiMode reset bug 真的挡死 PM session，**首选** file 新 issue + 把 #196 标 blocked on 它」，本 PR 在该约束下处理。
3. 最强本地 anchor 仍是 `shared/channel-prompt.test.ts` 8/8（task & pm role 双 role 三段断言 `mailbox_deregistered` + 拒绝继续发同 channel id 模板）+ 上方 exchange evict timeline。

### 与 evidence-gate 失败 4 点对应

| # | prior retry (4441074489) 失败点 | 本轮处理 |
|---|---|---|
| 1 | `04-settings-messaging.png` 实际 "Not Found" 404 页 | **已处理**：`01-settings-messaging-corrected.png` 替换；iteration #4 把 `/settings/messaging` 当 prod regression 是误判，正确 URL = `/settings?tab=messaging`，不存在路由 regression。 |
| 2 | acceptance #6 零真 PM transcript | **未跑**；改 file #202 跟踪 + 推荐 `#196 blocked on #202` 路径。 |
| 3 | macOS `getDescendantPids` GNU-only `ps --ppid` | prior commit `2e07b606` 已处理。 |
| 4 | 三张专门帧 PNG（DONE 前 / 后 / Alice 让 PM 再问被拒） | **部分处理**：`02-tasks-page-baseline.png` (DONE 前) + `04-tasks-page-after-done.png` (DONE 后) 同框对比已抓；第三帧「Alice 让 PM 再问被拒」依赖 #202 解封 PM session 后才能抓。 |

## 推荐 review verdict

按 caveat-honesty 原则 + retry feedback 4441074489 §"约束" 第三条：本 PR 解了 #1（截图标注 + URL 修正）+ #4（部分，2/3 帧）+ #3（prior round），但 #2/#4-3 (acceptance #6 完整 transcript) 没法在 #196 范围内闭环，应 **block #196 on #202**，#202 解了再回头补 acceptance #6 anchor。

不要把 #196 当 done 推；也不要在 #196 PR 内顺手修 #202 范围的 aiMode reset bug。
