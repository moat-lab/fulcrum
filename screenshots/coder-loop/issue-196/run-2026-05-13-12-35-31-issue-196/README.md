# run-2026-05-13-12-35-31-issue-196 evidence (retry #5)

本轮目标：修复 prior review (run-2026-05-13-12-10-28) 提出的 evidence-gate #3 失败点 —
`server/terminal/dtach-service.ts:38-52` `getDescendantPids` 用了 GNU-only `ps --ppid <pid>`，在 macOS 上整条 SIGKILL 链断在第一步。这是 #196 D4 deliverable 的核心前提（task DONE → SIGKILL claude → MCP child 跟着塌 → 心跳停 → exchange evict → PM 收 `mailbox_deregistered`）。

## artifacts

- `macos-pgrep-probe.txt` — 三级 bash 子进程树 + 新 `getDescendantPids` 在 darwin/arm64 上拿到 2 个 transitive descendant PID（root → bash → sleep）。最后两行同时复现 prior bug：旧代码 `ps --ppid 1` 返 `ps: illegal option -- -`。
- `macos-kill-tree-probe.txt` — 端到端 SIGKILL chain 模拟：构造 4 级深度进程树 `bash -> bash -> bash -> sleep`，全部 PID 在 kill 前 alive=true，调用 `killProcessTree(rootPid)` 后全部 alive=false，verdict `PASS — kill walked tree, all 4 PIDs dead`。这一条证明 D4 业务前提（fulcrum SIGKILL task claude → claude 的 MCP child 跟着塌）在 macOS 上真能触发。
- `test-channel-prompt.txt` — `shared/channel-prompt.test.ts`：8 pass / 0 fail（mailbox_deregistered prompt 条款双 role 断言保留）。
- `test-channel-launch.txt` — `server/services/channel-launch-service.test.ts`：7 pass / 0 fail（cleanupMcpConfigForTerminal 幂等 + no-launch terminal no-op）。

## 修法 (diff scope)

`server/terminal/dtach-service.ts`：把旧 `getDescendantPids` 拆成两段——

- 新 `getChildPids(pid)`：用 `pgrep -P <pid> || true`（macOS + Linux 都有），exit 1 / no-match 时返 `[]`；
- 新 `getDescendantPids(pid)`：直接调用 `getChildPids` 做 transitive closure，不再 shell-out 到 ps。

旧 BSD `ps` 的兼容假设 (`2>/dev/null || true`) 在 macOS 上不成立——`ps` 把 `--ppid` 当 `-` 短旗标解析、报 `illegal option`、整个命令在 `||` 之前就 fail，stderr 被 redirect 但 stdout 是空，函数永远 return `[]`。换 `pgrep -P` 直接走 BSD libproc，跨平台一致。

## 仍未补强的 prior-review 失败点（诚实披露）

- **evidence-gate #1（04-settings-messaging.png 是 404）**：本轮未替换。下一轮如能起 dev-server，应换成真正能渲染 messaging 配置的页面（或 `/monitoring/channels`），并把 prod build `/settings/messaging` 404 单独 file 一个新 issue 跟踪。
- **evidence-gate #2（acceptance #6 PM transcript anchor）**：本轮未跑真 PM Agent Mode session。原因：sandbox 内 fulcrum prod server 启动不稳（prior run 已观测 `bun run server/index.ts` 启动后 1-3s 内 exit）+ D2 `create-task-modal.tsx:740` aiMode reset bug 阻碍 PM session 起飞。须在 sandbox 外或专门治理这两条之后才能补 `pm-tool-result-deregistered.json` + `pm-transcript-3turn-after-done.txt`。
- **evidence-gate #4（DONE 转移专门帧 agent-browser PNG）**：依赖上一条 PM session 真能跑。本轮未补；prior run 4 张 PNG（含 404）已在 commit `9aa56385` 里，本轮不动。

## review hint

evidence-gate #3 这条（macOS pre-existing bug 断 D4 整条业务链）按 prior retry comment 是「不能继续把 #196 当 done 推」的硬阻断；本轮 Step 1 已修，并附 runtime probe + kill-tree 端到端 anchor。其他三条 evidence-gate 失败点本轮**未**完成，按 caveat-honesty 原则诚实披露在此 README + PR-thread comment 里，请 reviewer 按规则继续 retry，不要错把这条单独修复当成全部 evidence-gate 通过。
