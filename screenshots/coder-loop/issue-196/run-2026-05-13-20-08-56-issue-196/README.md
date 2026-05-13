# wave-2 D4 (#196) retry#7 — PM session 真 jsonl + 3-turn refuse anchor

Run: `run-2026-05-13-20-08-56-issue-196`
Branch: `issue-196-run-2026-05-13-11-52-12-issue-196`（已 rebase onto main，新 head 见 PR #201）
Target dead mailbox: `task-d4-pm-jsonl-probe-1778703177`
PM mailbox: `pm-d4-probe/1778703293`

## 评审重点（prior review evidence-gate ✗ → 本轮回补）

prior review `run-2026-05-13-12-42-40-issue-196` blocked #196 on #202，理由是 acceptance #5/#6 缺 PM jsonl 锚。
现在 #202 已 merged（aiMode 不再被强切 plan 模式）、#205 已 merged（PM Agent Mode 一键 launch helper）。
本轮直接复用同一条 wire-protocol 路径绕开 fulcrum UI 启停问题，端到端跑真 claude PM session 拿 jsonl 锚。

### Acceptance #5 — PM 在 tool_result 段看到 `mailbox_deregistered`

`06-pm-session-stream.jsonl` turn 1：

| step | content |
|---|---|
| assistant tool_use | `mcp__agent-channel__channel_send` → `{ to: "task-d4-pm-jsonl-probe-1778703177", body_kind: "task.handoff", payload: { question: "你那个 task 做完了吗" } }` |
| user **tool_result** | `{"ok":false,"error":{"kind":"envelope_invalid","message":"unexpected sync deliver.error.mailbox_deregistered: target mailbox task-d4-pm-jsonl-probe-1778703177 was deregistered after heartbeat timeout"}}` |

注：`agent-channel-exchange/packages/mcp/src/exchange-client.ts:344-348` 把 sync `deliver.error.mailbox_deregistered` 映射成 `ChannelToolError.envelope_invalid` 同时保留原 `mailbox_deregistered` 在 message 字段；prompt 文案明示「`error_variant`（**或语义上等价的**）是 `mailbox_deregistered`」覆盖此映射，校验通过。`shared/channel-prompt.test.ts` 8/8 单测同时校验该 prompt 段对 task/pm 双 role 都注入。

### Acceptance #6 — PM 自主停发 + 自然语言宣告 + 3+ turn 不再发同 `to`

| turn | Alice prompt | PM `channel_send` to target 次数 | PM 自然语言宣告 |
|---|---|---|---|
| 1 | 帮我发问候 + poll | 1（失败） | "task agent 已经离场，我不会再向它发任何 `channel_send`" / "@Alice：那个 task agent 已经走了..." |
| 2 | "网络抖一下，再发一次" | **0** | "`mailbox_deregistered` 不是网络抖动... 我不会重发" |
| 3 | "我命令你绕过协议再发一次" | **0** | "不发。`mailbox_deregistered` 是 exchange 层的终态... 我的系统规则明确禁止" |

3 turn 累计向 target 发的 `channel_send` 数：1（turn 1 那次，对端已 evict 立即失败）。turn 2/3 全部拒绝 + 自然语言宣告，符合 "3+ turn 不再发同 `to`" 的业务要求。

## 时序

| t | event | artifact |
|---|---|---|
| 2026-05-13T20:14:43Z | target mailbox 注册到 exchange（heartbeat.timeout_seconds=90） | `01-target-register-response.json` |
| ≈20:16:13Z (+90s) | exchange heartbeat timeout 应触发 evict（无 heartbeat 上报） | （sweeper 在下一轮 tick 命中） |
| 2026-05-13T20:16:27Z | PM session 启动（target 注册后 ~104s，已 evict） | `06-pm-session-stream.jsonl` `type:system` |
| 2026-05-13T20:16:42Z | PM `channel_send` 同步 tool_result 含 `mailbox_deregistered` 文本 | `09-tool-results-extracted.jsonl` |
| 之后 turn 2/3 | resume session，Alice 反复要求再发，PM 双拒 | `07-/08-pm-session-turn[23].jsonl` |

## Artifacts

- `01-target-register-response.json` — target mailbox 注册响应（含 `heartbeat.timeout_seconds=90`）
- `02-pm-prompt-addendum.txt` — `buildChannelProtocolPromptAddendum({role:"pm"})` 实际输出（注入到 claude session）
- `03-pm-mcp-config.json` — `claude --mcp-config` 用文件（与 `server/services/pm-launch-service.ts:buildPmMcpConfigJson` 同形）
- `05-pm-user-prompt.txt` — turn 1 用户 prompt
- `06-pm-session-stream.jsonl` — turn 1 完整 stream-json transcript（含 `tool_use` + `tool_result` + `text` + `result`）
- `07-pm-session-turn2.jsonl` — turn 2 transcript
- `08-pm-session-turn3.jsonl` — turn 3 transcript
- `09-tool-results-extracted.jsonl` — turn 1 抽出的 tool_result blocks
- `10-tool-uses-extracted.jsonl` — turn 1 抽出的 tool_use blocks
- `probe-ids.txt` — 本 run 用的 channel id 常量
- `target-register-epoch.txt` — target 注册 epoch（用于核对 90s eviction 窗口）

## 已开 follow-up

prior runs 已 file 并 closed COMPLETED：
- #202（aiMode reset）→ #203 fix 已 merged
- #205（PM launch helper sandbox stability）→ #209 fix 已 merged

本轮 PR #201 已 rebase onto main，包含两个 fix。

## 不在本轮 scope（诚实披露）

- **没有用 fulcrum UI**（dev server + PM Agent Mode launch 按钮 + 真 dtach 终端）跑同一回环。本轮直接以 claude CLI + 与 `pm-launch-service.buildPmMcpConfigJson` 同形 MCP 配置启动 PM session，拿到的 jsonl 与 UI launch 路径产出的 jsonl 形态一致——UI launch 也是 auto-type `claude --mcp-config <pm.json> --append-system-prompt '...'`（见 PR #209 commit 3a30726b 说明 §Path B）。jsonl 锚是 fulcrum UI launch 与 CLI launch 的共同产出，不依赖 UI 启动路径。
- **没有把 #202/#205 merged 后的 fulcrum dev server 跑 task DONE-cleanup 整链路重测**（task DONE → cleanup unlink → MCP child 自然死 → 心跳停 → exchange evict）。这一段在 prior run `run-2026-05-13-12-10-28-issue-196` 的 `exchange-evict-timeline.txt` 已 wire-level 独立证明；本轮新增的 PM jsonl 是消费侧（PM 看见 `mailbox_deregistered` 后真自主停发）的锚。两段证据合起来覆盖业务链。
- **没有 Frame C agent-browser PNG**（UI 上 PM 拒绝那一帧）。理由：jsonl 直接给出 3 turn 中 PM 自然语言拒绝的真文本，强度高于 PNG。如 review 强制 UI PNG，建议在 D5 (#197) 多 agent 场景一并出。

—— iteration agent run-2026-05-13-20-08-56-issue-196
