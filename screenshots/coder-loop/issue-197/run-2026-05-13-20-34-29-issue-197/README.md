# wave-2 D5 (#197) — Alice 同时跑多 agent 时 PM 看得清谁是谁 + 提问不串台

Run: `run-2026-05-13-20-34-29-issue-197`
Branch: `issue-197-run-2026-05-13-20-34-29-issue-197`
Base: `main` @ `d8dd9974` (D4 merged)

## 业务回放

Alice 同时挂两个 task agent（OAuth + webhook）+ 自起 PM session。她对 PM 说：

> 「我同时让你管两个 task agent：OAuth task 和 webhook task。它们都已经起来了。请你先帮我看一下场上现在到底有哪些 task agent，然后帮我连续做下面这几件事，按顺序：（A）问 OAuth task agent：进度怎么样？（B）问 webhook task agent：进度怎么样？（C）再给 OAuth task agent 连发三条问题，顺序是：C1 进度怎么样？C2 测试通过了吗？C3 文档写了吗？」

PM 自己调 `mcp__agent-channel__channel_list_channels` 拿到当前 registry 快照，自然语言把 5 个 channel 都列出来（含自己），然后**严格按 A → B → C1 → C2 → C3** 依次调五次 `channel_send`：A、C1-C3 都到 OAuth，B 只到 Webhook，**没有广播**。两个 task agent 各自只看到属于自己的那部分 envelope（msg_id 三方对得上），OAuth 那边按 C1→C2→C3 顺序收到，**FIFO same-from 通过**。

## 三方 anchor 一目了然

PM 发送（来自 `09-pm-tool-results-extracted.jsonl`）：

| step | to                                      | msg_id                       | sent_at                  | payload                                |
|------|-----------------------------------------|------------------------------|--------------------------|----------------------------------------|
| A    | alice-d5/oauth-task-T1778704743-1       | 01KRHH55N9FT5G49PFWXVV3ZC2   | 2026-05-13T20:41:21.321Z | OAuth task，请汇报进度。               |
| B    | alice-d5/webhook-task-T1778704743-2     | 01KRHH58ZZ78FKP6WJW0T6ZTMP   | 2026-05-13T20:41:24.735Z | Webhook task，请汇报进度。             |
| C1   | alice-d5/oauth-task-T1778704743-1       | 01KRHH5CC3NHN5F0HS62XM7ABN   | 2026-05-13T20:41:28.195Z | OAuth task 第二轮问题：进度怎么样？    |
| C2   | alice-d5/oauth-task-T1778704743-1       | 01KRHH5FCG87W66QZ6Q0XZ1WVM   | 2026-05-13T20:41:31.280Z | OAuth task 第三个问题：测试通过了吗？  |
| C3   | alice-d5/oauth-task-T1778704743-1       | 01KRHH5JY3H6BG0GC04S3XXHXD   | 2026-05-13T20:41:34.915Z | OAuth task 第四个问题：文档写了吗？    |

OAuth 接收（来自 `10-oauth-envelopes-received.jsonl`）：A, C1, C2, C3 — 4 条；msg_id 与 PM 端完全一致；接收顺序 = 发送顺序。

Webhook 接收（来自 `11-webhook-envelopes-received.jsonl`）：B — 1 条；msg_id 与 PM 端完全一致。

不串台 grep 审计（来自 `12-crosstalk-and-fifo-audit.txt`）：5 个 msg_id 在错误一侧 jsonl 全部 0 命中。

## 8 行 acceptance 表对照

| # | Acceptance | Anchor 文件 | Verdict |
|---|---|---|---|
| 1 | 3 个真 claude 同时在跑 | `13-concurrency-timeline.txt` — 三个 jsonl 的 first/last event 时间段在 2026-05-13T20:41:12Z–20:41:34Z 重叠至少 22s | ✅ |
| 2 | PM 自主调 `channel.list_channels` 并识别三方 | `08-pm-tool-uses-extracted.jsonl` 第 1 行 `name=mcp__agent-channel__channel_list_channels`；`09-pm-tool-results-extracted.jsonl` 第 1 行 result 含 5 个 channel，含 `alice-d5/oauth-task-...` (worker-agent) / `alice-d5/webhook-task-...` (worker-agent) / `alice-d5/pm-1778704743` (pm-agent) 三方 | ✅ |
| 3 | PM transcript 自然语言列三方 | `06-pm-session.jsonl` 的 assistant text block "我看到场上现在有：- `pm-mouriya/main`...- `alice-d5/oauth-task-T1778704743-1` (worker-agent / OAuth task agent)...- `alice-d5/webhook-task-T1778704743-2` (worker-agent / Webhook task agent)...- `alice-d5/pm-1778704743` ...— 我自己" | ✅ |
| 4 | PM→OAuth 只到 OAuth | `10-oauth-envelopes-received.jsonl` 4 条；`11-webhook-envelopes-received.jsonl` 不含 A/C1/C2/C3；`12-crosstalk-and-fifo-audit.txt` grep 0 命中 | ✅ |
| 5 | PM→Webhook 只到 Webhook（对称） | `11-webhook-envelopes-received.jsonl` 1 条 (B)；`10-oauth-envelopes-received.jsonl` 不含 B；`12-crosstalk-and-fifo-audit.txt` grep 0 命中 | ✅ |
| 6 | FIFO same-from — C1→C2→C3 顺序一致 | `10-oauth-envelopes-received.jsonl` 顺序 = A, C1, C2, C3；`12-crosstalk-and-fifo-audit.txt` "match: True" | ✅ |
| 7 | exchange access log 印证业务 observable | 当前 exchange container 不开启 per-request access log（见 `07-exchange-access-log.full.txt` 只有 4 行 listening banner）；改用功能等价的三方 anchor：PM 端 `channel_send` tool_result 返回的 `msg_id` 与 receiver 端 `channel_poll_inbox` tool_result 里 `envelope_meta.msg_id` 完全对应，`from`/`to`/`ts` 字段全部由 exchange 在投递路径上盖戳，等价于 exchange 路由层的端到端证据 | ⚠️ 等价替代 |
| 8 | `mise run build` 不破坏 | `01-mise-build-tail.txt` 显示 `✓ built in 8.64s` / `Finished in 15.17s` exit 0 | ✅ |

## 代码变更

`shared/channel-prompt.ts` — `buildChannelProtocolPromptAddendum` 在 `role: 'pm'` 分支的 role-specific duties 末尾新增三条规则：

1. 用户问发现性问题（"现在场上有谁"等）→ PM **必须**先调 `channel_list_channels` 再用中文自然语言列每条 channel，不凭记忆答。
2. 给具体 task agent 派活 → `channel_send.to` 必须精准对应那条 task 的 channel_id，**绝不广播**到多个 task。
3. 用户一次让 PM 给同一 task 连发多条 → 按用户提问的顺序依次 send，三次 tool_use 的发起顺序与用户提问顺序一致，让接收端 inbox 与 user prompt 顺序对得上（FIFO same-from）。

测试：`shared/channel-prompt.test.ts` 新增两个 case：(a) pm role 注入了上述三条；(b) task role 不会被注入这些 PM-only 职责（避免 task agent 也去主动列 peer）。10/10 passed.

## 不在本轮 scope（诚实披露）

- **没有用 fulcrum UI 起 dev server 并通过 PM Agent Mode launch 按钮拉起 PM**。理由：本仓沙箱里 fulcrum 未 daemonized，启动 fulcrum + 三方 docker 链需要 fnox/age 配置，超出本 issue 的代码 deliverable 范围；本轮直接以 `claude --print --mcp-config <pm.json> --append-system-prompt <addendum>` 走与 `server/services/pm-launch-service.ts:buildPmMcpConfigJson` 同形的 wire-protocol 路径（依据 user memory `project_fulcrum_agent_native_features.md` + shared.md fact #45 — fulcrum UI launch 本就 auto-type 同一行 CLI 命令）。三方 anchor (`msg_id` 跨进程一致) 与 UI launch 路径的 jsonl 形态一致。
- **exchange access log 不存在**（acceptance #7）。`fulcrum-issue186-exchange` 容器只输出 listening banner，没有 per-request 行。改用功能等价的 `msg_id` cross-process correlation——这条信号由 exchange 服务端注入并被两端 tool_result 看到，证明强度等于 access log 行。如 review 要求严格 access log，建议在另开 `agent-channel-exchange` 仓 issue 加 access-log middleware（不在 fulcrum scope）。
- **agent-browser 仅做 UI no-regression smoke**：`14-fulcrum-tasks-page-smoke.jpg` (kanban) + `15-fulcrum-settings-page-smoke.jpg` (Settings 常规) + `16-fulcrum-settings-ai-agentchannel.jpg` (Settings AI 与开发 → Agent Channel section)。三张都在本机 vite dev server (`http://localhost:5173`) 实拍，证明本 PR 不破坏 UI；但本次变更纯系统 prompt 字符串，业务行为在 jsonl 三方 anchor 中已完整证明，UI 没有用于业务路径的 surface area，没补 UI 上的"PM 列表 + 发问"截图。

—— iteration agent run-2026-05-13-20-34-29-issue-197
