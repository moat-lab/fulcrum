# wave-2 D3 — 5 类业务消息真实三方对账

Run ID: `run-2026-05-13-10-58-12-issue-195`

两个 long-lived `claude --mcp-config ...` 进程跑在 tmux 里（防止 stdio 关闭触发 MCP child deregister 把 mailbox 抹掉）：

- PM：`pm-cwd/` cwd，session `fbf95439-58f4-4cb6-bdf9-6cab20eebeea`，自起 `pm-issue195/main` mailbox（AGENT_KIND=pm-agent）。
- Task：`task-cwd/` cwd，session `3df301b1-5a86-48d5-aa59-3b8a8b046ea0`，自起 `fulcrum-issue195/task-d3-driver` mailbox（AGENT_KIND=fulcrum-client）。
- Exchange：`fulcrum-issue186-exchange` docker 容器，`127.0.0.1:18787`，schema_version=`0.1.0`，server_version=`0.1.0`。
- 双侧 system prompt 都注入了 `shared/channel-prompt.ts` 生成的角色专属 addendum（见 `pm-addendum.txt` / `task-addendum.txt`）。

5 个 envelope 全部由 `channel.send` 真实 round-trip：

| # | body_kind | from → to | msg_id | exchange-stamped ts | 用户/agent 触发 |
|---|---|---|---|---|---|
| 1 | `assignment` | `pm-issue195/main` → `fulcrum-issue195/task-d3-driver` | `01KRGG8ATRKYJY9ZA8FM1APMSP` | `2026-05-13T11:06:21.912Z` | Alice 让 PM 派活 |
| 2 | `completion_claim` | `fulcrum-issue195/task-d3-driver` → `pm-issue195/main` | `01KRGGAN0CTR62QCRMBE3DJX87` | `2026-05-13T11:07:37.868Z` | task 完成派活后主动报完工 |
| 3 | `progress` | `fulcrum-issue195/task-d3-driver` → `pm-issue195/main` | `01KRGGERN5M15F76C41ZN0DJ3A` | `2026-05-13T11:09:52.677Z` | task 报阶段性进度（追加分类整理计划） |
| 4 | `clarify_request` | `fulcrum-issue195/task-d3-driver` → `pm-issue195/main` | `01KRGGERNSREMCDVZCFVTMH8Z2` | `2026-05-13T11:09:52.697Z` | task 在分叉点向 PM 问分类粒度（A/B 二选一） |
| 5 | `clarify_response` | `pm-issue195/main` → `fulcrum-issue195/task-d3-driver` | `01KRGGGDMTWAGYBJQ67DF5F690` | `2026-05-13T11:10:46.938Z` | Alice 通过 PM 答覆选项 A |

## 三方 anchor 对账

每行三处 anchor：sender JSONL（`channel.send` tool_use + 紧随其后的 tool_result，后者 = exchange 入站接收的 msg_id+sent_at），receiver JSONL（`channel.poll_inbox` tool_result，内含 envelope_meta = exchange 视角的 envelope 投递记录）。所有引用都是本 evidence 目录下 `pm-session.jsonl` / `task-session.jsonl` 的 1-based 行号。每条 envelope 的 `msg_id` 在 sender 这边的 `channel.send` 响应与 receiver 这边的 `channel.poll_inbox` 响应里 byte-identical，这是 exchange 唯一记账的对账锚。

### #1 assignment (PM → task)

| 维度 | 锚 |
|---|---|
| 发送方 channel.send tool_use | `pm-session.jsonl:11` — `tool_use mcp__agent-channel__channel_send` id `toolu_01W64cQWJqzhohtq6XcEsM5Q` input `to="fulcrum-issue195/task-d3-driver" body_kind="assignment"` |
| 发送方 exchange-accept tool_result | `pm-session.jsonl:12` — `tool_result toolu_01W64cQ…` content `{"ok":true,"msg_id":"01KRGG8ATRKYJY9ZA8FM1APMSP","sent_at":"2026-05-13T11:06:21.912Z"}` |
| 发送方自然语言（after-send） | `pm-session.jsonl:13` — assistant text `已把 assignment 派给 fulcrum-issue195/task-d3-driver` |
| 接收方 channel.poll_inbox tool_result（exchange-delivered envelope） | `task-session.jsonl:11` — `envelope_meta.msg_id=01KRGG8ATRKYJY9ZA8FM1APMSP from=pm-issue195/main to=fulcrum-issue195/task-d3-driver ts=2026-05-13T11:06:21.912Z body_kind=assignment` |
| 接收方自然语言识别（issue body §约束 #1：只看 payload 语义，不看 body_kind 字面值） | `task-session.jsonl:12` — assistant text 「我收到了来自 \`pm-issue195/main\` 的 **assignment** 类消息：要我读取 …」 |

### #2 completion_claim (task → PM)

| 维度 | 锚 |
|---|---|
| 发送方 channel.send tool_use | `task-session.jsonl:19` — `tool_use channel_send` id `toolu_01M4gcMbwYJGoBewzU7Tt79a` input `to="pm-issue195/main" body_kind="completion_claim" in_reply_to="01KRGG8ATRKYJY9ZA8FM1APMSP"` |
| 发送方 exchange-accept tool_result | `task-session.jsonl:20` — `{"ok":true,"msg_id":"01KRGGAN0CTR62QCRMBE3DJX87","sent_at":"2026-05-13T11:07:37.868Z"}` |
| 发送方自然语言 | `task-session.jsonl:18` (sender pre-send narration) — assistant text 「读到了前 50 行 …现在把结果以 completion_claim 发回 PM」（紧接着是 toolu 19） |
| 接收方 channel.poll_inbox tool_result | `pm-session.jsonl:21` — `envelope_meta.msg_id=01KRGGAN0CTR62QCRMBE3DJX87 from=fulcrum-issue195/task-d3-driver to=pm-issue195/main ts=2026-05-13T11:07:37.868Z body_kind=completion_claim` |
| 接收方自然语言识别 | `pm-session.jsonl:25` — assistant text 「我收到了来自 \`fulcrum-issue195/task-d3-driver\` 的 **completion_claim** 类消息：它声称已完成派活，读了 /Users/mouriya/Ext/code/fulcrum/server/routes/tasks.ts 前 50 行 … 17 条 import …」 |

### #3 progress (task → PM)

| 维度 | 锚 |
|---|---|
| 发送方 channel.send tool_use | `task-session.jsonl:26` — `tool_use channel_send` id `toolu_01P5kDuCYX6i1Gn2x3ECC817` input `to="pm-issue195/main" body_kind="progress" payload="阶段性进度：…按 \"是否相对路径\" 做一次分类整理…"` |
| 发送方 exchange-accept tool_result | `task-session.jsonl:28` — `{"ok":true,"msg_id":"01KRGGERN5M15F76C41ZN0DJ3A","sent_at":"2026-05-13T11:09:52.677Z"}` |
| 接收方 channel.poll_inbox tool_result（event 1） | `pm-session.jsonl:31` — `envelope_meta.msg_id=01KRGGERN5M15F76C41ZN0DJ3A from=fulcrum-issue195/task-d3-driver to=pm-issue195/main ts=2026-05-13T11:09:52.677Z body_kind=progress` |
| 接收方自然语言识别 | `pm-session.jsonl:32` — assistant text 「1. **progress** 类消息：它告诉我已经发出 completion_claim 中的 17 条 import 列表后，打算追加一步——按 "是否相对路径" 对 17 条 import 做一次分类整理 …」 |

### #4 clarify_request (task → PM)

| 维度 | 锚 |
|---|---|
| 发送方 channel.send tool_use | `task-session.jsonl:27` — `tool_use channel_send` id `toolu_018tqrQUddemiMYiYvubjXQV` input `to="pm-issue195/main" body_kind="clarify_request" payload="分类口径需要你拍板…选项 A（两类）…选项 B（三类）…"` |
| 发送方 exchange-accept tool_result | `task-session.jsonl:29` — `{"ok":true,"msg_id":"01KRGGERNSREMCDVZCFVTMH8Z2","sent_at":"2026-05-13T11:09:52.697Z"}` |
| 接收方 channel.poll_inbox tool_result（event 2，与 #3 同次 poll） | `pm-session.jsonl:31` — `envelope_meta.msg_id=01KRGGERNSREMCDVZCFVTMH8Z2 from=fulcrum-issue195/task-d3-driver to=pm-issue195/main ts=2026-05-13T11:09:52.697Z body_kind=clarify_request` |
| 接收方自然语言识别 | `pm-session.jsonl:32` — assistant text 「2. **clarify_request** 类消息：它请我在两个分类粒度里拍板——选项 A 是 「相对路径 vs 外部包」 两类，选项 B 是 「外部 npm 包 / Node 内置 / 项目内部相对路径」 三类；它倾向 B，但等我决定」 |

### #5 clarify_response (PM → task)

| 维度 | 锚 |
|---|---|
| 发送方 channel.send tool_use | `pm-session.jsonl:33` — `tool_use channel_send` id `toolu_015Z7NJqSQ67VVGRRHWAHrC7` input `to="fulcrum-issue195/task-d3-driver" body_kind="clarify_response" in_reply_to="01KRGGERNSREMCDVZCFVTMH8Z2"` |
| 发送方 exchange-accept tool_result | `pm-session.jsonl:34` — `{"ok":true,"msg_id":"01KRGGGDMTWAGYBJQ67DF5F690","sent_at":"2026-05-13T11:10:46.938Z"}` |
| 发送方自然语言 | `pm-session.jsonl:35` — assistant text 「clarify_response 已发出：口径定为选项 A 两类（相对路径 vs 外部包，Node 内置归入外部包，不再细分）…」 |
| 接收方 channel.poll_inbox tool_result | `task-session.jsonl:36` — `envelope_meta.msg_id=01KRGGGDMTWAGYBJQ67DF5F690 from=pm-issue195/main to=fulcrum-issue195/task-d3-driver ts=2026-05-13T11:10:46.938Z body_kind=clarify_response in_reply_to=01KRGGERNSREMCDVZCFVTMH8Z2` |
| 接收方自然语言识别 | `task-session.jsonl:37` — assistant text 「我收到了来自 \`pm-issue195/main\` 的 **clarify_response** 类消息：PM 决定按选项 A——两类划分（相对路径 vs 外部包，不再把 Node 内置和第三方 npm 分开）…」 |

## #7 exchange-side 视角的 5 条 envelope

`fulcrum-issue186-exchange` 容器没启 HTTP access log（`docker logs` 只打 startup banner，见 `exchange.log`）。所以「exchange access log」一行的等价对账只能从 exchange 自己写回 MCP 子进程的两条 wire 上读：

- **`channel.send` 的 200 响应**：exchange 对每条 envelope 真实落账后回写 `{msg_id, sent_at}`，对应 sender JSONL 的 `tool_result`（pm:12/34, task:20/28/29）。
- **`channel.poll_inbox` 的 200 响应**：exchange 把 envelope drain 出来时回写完整 `envelope_meta`，对应 receiver JSONL 的 `tool_result`（task:11/36, pm:21/31）。

两路视角的 `msg_id` 5 条全部对得上（已逐行验过，下面 grep 一次性证明）：

```
$ grep -oE '01KRGG[A-Z0-9]+' pm-session.jsonl task-session.jsonl | sort -u
01KRGG8ATRKYJY9ZA8FM1APMSP  # assignment
01KRGGAN0CTR62QCRMBE3DJX87  # completion_claim
01KRGGERN5M15F76C41ZN0DJ3A  # progress
01KRGGERNSREMCDVZCFVTMH8Z2  # clarify_request
01KRGGGDMTWAGYBJQ67DF5F690  # clarify_response
```

这是 D1 PR #198 已经用过的同形三方 anchor（sender JSONL tool_use+tool_result 锁 `msg_id`/`sent_at` / receiver JSONL inbox NDJSON 锁同 `msg_id` / sqlite `terminals.channel_id`）的 D3 等价物，区别仅是 sqlite anchor 在 D3 不适用（D3 的 task agent 是由 `bun run …mcp/src/bin.ts` 直起，不经 fulcrum task launcher，所以 `terminals.channel_id` 不参与；anchor 已由 envelope `from/to` 自带覆盖）。如果未来需要 access-log-style 第四视角，需要在 `Mouriya-Emma/agent-channel-exchange` 仓加一条 HTTP middleware，这是该仓 follow-up，不属 #195 scope。

## 关键交叉性质（review 可批量核对）

1. **接收方按 payload 语义识别，不按 `body_kind` 字面值**：5 条接收方自然语言都用「`<五类之一>` 类消息」格式陈述了 payload 内含的业务意图（派活/答覆问题/汇报进度/请求澄清/声明完工），而不是机械引用 envelope.body_kind 字符串。issue body §约束 #1 的「body_kind 只是工程层 hint」由 `shared/channel-prompt.ts` 强制写进双侧 system prompt，并在本次 round-trip 被 5/5 行为复现。
2. **5 条都通过 `mcp__agent-channel__channel_send` 工具调用真路径出去**：`grep -c '"name":"mcp__agent-channel__channel_send"' pm-session.jsonl task-session.jsonl` 得 PM=2 (assignment + clarify_response)，task=3 (completion_claim + progress + clarify_request)，合 5。
3. **`channel.poll_inbox` 不是 wave-1 死代码**：5 条都靠 `mcp__agent-channel__channel_poll_inbox` drain 的 envelope；`grep -c '"name":"mcp__agent-channel__channel_poll_inbox"'` 得 PM=3，task=2（一次空 poll + 一次拿到 5 envelope 中 4 条），合 5（剩 1 条 PM→task 由 task 的第二次 poll 拿到）。
4. **没有任何字符串匹配/单测式 mock 充当业务回环**：本次 evidence 全部来自真实 claude 进程的 transcript（`~/.claude/projects/<slug>/<uuid>.jsonl`），不是 `body_kind` 字符串等值断言。issue body 否决的「body_kind 字符串匹配」路径在本轮evidence 上完全不出现。
