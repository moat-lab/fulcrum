# Design: PM / architect agent 作为 exchange 参与者的协议层

> Status: **subject-to-relocation** — 本文档随 exchange repo（`agent-channel-exchange`，见 #160）起步后，协议无关 fulcrum 状态机的部分挪到该 repo `protocol/` 或 `mcp/` 包旁；fulcrum 仅保留「PM 触发的 task status 转换」与「Chat 启动 UX hook 接口形态」两段，其余指针式引用。
> Closes thread of: #164（umbrella #153）
> Depends on: #160（`docs/design/channel/00-exchange-repo-decision.md`）/ #161（`docs/design/channel/02-wire-contract.md`）/ #162（`docs/design/channel/03-fulcrum-client.md`）/ #163（`docs/design/channel/04-mcp-tool-abi.md`）
> Blocks: PM agent 实现 wave（不在本 design wave）

## 范围

锁定外部 PM / architect agent（per memory `project_fulcrum_agent_native_features`：「像**产品经理** + **架构师**那样和用户沟通、不做深度实现、负责把工作派发进 fulcrum task」）作为 exchange 上一个普通 peer 接入 fulcrum 内 task agent 的协议层：

- PM agent 在 exchange 上的注册路径（不走 fulcrum task launcher）；
- PM agent 客户端形态（与 #162 fulcrum exchange client launcher 决策对齐）；
- 消息语义分类（MVP ≤5 类应用层 `body_kind`）；
- 与 fulcrum task 5 status 状态机的衔接（引用 `server/services/task-status.ts`）；
- 多 task 并发对话的 channel-id 发现机制；
- PM 失联的处置；
- Chat 启动 UX hook 接口形态（只锁定最小接口，不实现 UI）。

本 doc 不实现任何代码——所有伪代码 / `body_kind` 形态标 `// design-only, not yet implemented`。本 doc 不预判 PM agent runtime / 不改 chat UI / 不写 prompt——只 design protocol。本 doc 不发明新 task status——必须复用 `server/services/task-status.ts` 已有 5 种 status（`TO_DO` / `IN_PROGRESS` / `IN_REVIEW` / `DONE` / `CANCELED`）；如需新字段列入「未决问题」。

## 用户已锁定的前提（不可推翻）

下列 3 条由用户对本 issue 明确约束，本 doc 必须 cite 进每个决策：

1. **PM agent 在 exchange 上是普通 peer，不是特殊角色**。所有寻址 / 投递 / FIFO / no-inbox / authorization 规则与 #161 完全一致；exchange 不为 PM 单开特例。
2. **寻址 / 投递 / FIFO / no-inbox 等规则与 #161 一致**。复用 #161 envelope ADT、`channel.send` / `discovery.list_request` 端点、at-most-once + FIFO-per-sender 投递语义、`±5min` anti-replay 窗。
3. **出站走 MCP tool（如果 PM agent 也是 Claude Code session）或直接走 exchange HTTP API（如果是非-Claude 外部进程）**。MCP 形态走 #163 `channel.send` / `channel.list_channels`；HTTP 形态直接走 #161 `POST /v1/envelope` / `POST /v1/discovery/list`。两条路径产出的 envelope 在 exchange 一侧完全等价。

### PM agent 的特殊性（与 task agent 相比，仅作背景）

下列 4 条不是协议特例，只是说明为什么 PM agent 的客户端形态 / 注册路径 / 失联处置必须独立讨论；本 doc 仍按前提 1「普通 peer」处理：

1. **不由 fulcrum launcher 启动**：PM agent 是外部进程（用户 chat client 内 / 单独 CLI / IM bot），没有 fulcrum task / dtach / worktree 这一套支撑（与 #162 ## flag 注入点段「launcher = task-terminal 内」的前提互补）。
2. **可同时跟多个 task agent 对话**：PM 的 mailbox 收件箱里 `from` 可能跨多个 task；与 task agent「1 进程 1 mailbox」（#161 前提 1）形态相同但语义上 fan-in。
3. **生命周期跟 task 无关**：PM agent 自己起自己死；task DONE 时 PM 不一定要停。
4. **角色** per memory `project_fulcrum_agent_native_features`：「像产品经理 + 架构师那样和用户沟通、不做深度实现、负责把工作派发进 fulcrum task」。本 doc 把这条角色描述直接 cite，不重新发明 PM 行为边界。

---

## PM agent 注册路径（self-register / 非 launcher 路径）

PM agent 不走 fulcrum task launcher 那条注册（#162 ## 注册时序段：frontend `buildAndSendAgentCommand` → `POST /api/channels/register` → fulcrum server 代理 `/v1/register`）。本段决定它走哪一条**非 launcher** 路径。

### 候选

- 候选 1：PM agent **直接调** exchange `POST /v1/register`（#161 Register API 段），自己持 exchange bearer token，自助分 channel-id。
- 候选 2：fulcrum 暴露一个 PM 专用 broker / 代理 endpoint（如 `POST /api/channels/register-pm`），由 fulcrum server 代理到 exchange；PM agent 不直接持 exchange token，只持 fulcrum API token。
- 候选 3：PM agent self-register 走双路径——MCP 形态时由 MCP child 在 stdio 起步后内部 register（#162 ## 注册时序段已述）；HTTP 形态时 PM 自跑直连 `POST /v1/register`。

### trade-off

- 候选 2（fulcrum broker / 代理）：违反前提 1「PM agent 在 exchange 上是普通 peer」——broker 形态隐含「fulcrum 持有 PM agent 凭证 / 控制 PM 注册时序」，这是把 PM 当成 fulcrum 的内部组件而非独立 peer。同时让 fulcrum 被迫维护一条 PM-only 注册代理路径，违反 #160 「exchange 独立服务」目标的连带后果（fulcrum 不应该承载非 task agent 的注册控制流）。
- 候选 3（双路径 self-register）：MCP 形态下 PM 仍是 Claude Code session，但本 issue 的 PM 客户端形态（见 ## PM agent 客户端形态 段）锁定为 MCP 优先；HTTP 形态作为 fallback。同一个 agent 起步可能走两条注册路径会让 channel-id 形态 / authorization 字段判定漂移；不如统一为「PM agent 永远走 self-register」一条，根据客户端形态分发到 MCP child 注册或直连 HTTP 注册——本质等价候选 1。
- 候选 1（PM agent 直接调 `/v1/register`）：等价 task agent 一侧的 register 形态（task agent 由 fulcrum 代发只是因为 frontend 不持有 exchange token；PM agent 既然是独立外部进程，自然自己持 token 直接调），完全符合「普通 peer」。**注**：「直接调」指的是 PM agent 进程自己（或其 MCP child）走 #161 Register API；fulcrum server 与该注册流程完全无关。

### 选定

候选 1 — PM agent **self-register** 直接调 exchange `POST /v1/register`：

- MCP 形态：PM 启动时 spawn 的 `@agent-channel/mcp` MCP child（per #163 capability 段）按 #162 ## 注册时序段所述，由 MCP child 内部完成 register；PM agent 进程不直接拼 register HTTP，但本质仍是 PM 一侧的 self-register（fulcrum 完全不介入）。
- HTTP 形态（非-Claude PM）：PM agent 进程自跑 HTTP client 直接调 `POST /v1/register`。
- 两种形态产出的 register 请求形态 100% 沿用 #161 `RegisterRequest`，仅 `identity.agent_kind = "pm-agent"`（#161 RegisterRequest.identity.agent_kind 已枚举此值）。
- 鉴权走 #161 Register API 段定义的 `Authorization: Bearer <exchange-token>`：MCP 形态下 token 注入由 PM 启动器决定（fnox 一致密钥 / 环境变量 / 进程参数），HTTP 形态下由 PM agent 自管。**fulcrum 不持有 PM agent 的 exchange token**——这是非 launcher 注册路径的关键边界。

### 理由

1. **协议对称**：PM agent 与 task agent 在 register 阶段产出的 envelope 字段集相同，exchange 一侧无需做 PM-only 特例（前提 1 锁定）。
2. **token 边界清晰**：fulcrum 一侧只持自己 fulcrum-client mailbox + task MCP child mailbox 两类的 exchange token；PM agent 的 token 完全归 PM 部署方管理，避免「fulcrum 替 PM 注册 = fulcrum 持 PM 凭证」的反向依赖。
2. **channel-id 形态自由**：PM agent 的 `desired_channel_id` 由 PM 部署方决定形态（典型如 `pm-mouriya/main` 或 `pm-architect-bot/v1`），与 #162 ## channel-id 形态段的 `<mailbox>/task-<id>` fulcrum-side 命名规则各自独立，不互相约束。
3. **未来 ACL hook 兼容**：当 #161 ## Authorization model 段的 future ACL 表上线时，PM agent 在 register 时已经声明 `agent_kind: "pm-agent"`，exchange 一侧 ACL 表直接按 `(pm-agent, worker-agent)` 维度配置 allow/deny，不需要回头改 PM 注册路径。

### 失败处置

- register HTTP 4xx → PM 部署方负责日志 / 退避；fulcrum 不介入。
- register 成功后 90s timeout 失联 → 见 ## PM 失联 段。

---

## PM agent 客户端形态

MVP 假定 PM agent 是哪一种进程形态？是必须 Claude Code session（走 `--channels server:<cmd>`）还是允许非-Claude PM（如纯 CLI agent / 第三方 chat client / IM bot）？

### 候选

- 候选 1：MVP 锁定 PM agent 必须是 Claude Code session，走 #162 ## flag 注入点段同款 `claude --channels server:<cmd>` 形态，MCP child 由 `@agent-channel/mcp` 提供。
- 候选 2：MVP 允许两种形态——Claude PM（MCP 形态）与非-Claude PM（HTTP 直连形态），两种形态在 exchange 一侧产出等价 envelope；fulcrum 一侧只需要在 Chat 启动 UX hook（## Chat 启动 UX hook 段）暴露形态选择字段。
- 候选 3：MVP 仅允许非-Claude PM（纯 CLI / 外部 bot），强制 PM 走 HTTP 直连，避免在 MVP 阶段同时调试 MCP child 与 PM 应用层协议。

### trade-off

- 候选 1（仅 Claude PM）：限制太紧——memory `project_fulcrum_agent_native_features` 第 4 条已经允许 PM 跑在 chat / IM bot 等外部 surface 内，强制 Claude Code 形态会让 IM bot 形式的 PM agent 无法接入。同时违反前提 3「出站走 MCP tool 或 HTTP API」的 OR 语义。
- 候选 3（仅非-Claude PM）：放弃 MCP 形态在 PM 一侧的复用——MCP 形态已经在 #163 中把 `channel.send` / `channel.list_channels` 这两个 tool 调通，PM 如果是 Claude session 直接复用零成本；强制 HTTP 形态等于让 PM 部署方重写一遍 MCP child 的 envelope 翻译层。
- 候选 2（双形态并存）：等价前提 3 直接锁定的语义；exchange 一侧零负担（两形态产出 envelope 等价），fulcrum 一侧仅在 Chat 启动 UX hook 段暴露选项，runtime 不需要分支。

### 选定

候选 2 — MVP 同时支持两种 PM agent 客户端形态：

| 形态 | 出站路径 | 入站路径 | 注册路径 | identity.agent_kind |
|---|---|---|---|---|
| Claude PM（MCP 形态） | #163 `channel.send` / `channel.list_channels` tool | `notifications/claude/channel`（#163 ## 入站 notification ABI 段） | MCP child 内部 self-register | `pm-agent` |
| 非-Claude PM（HTTP 形态） | 直接调 #161 `POST /v1/envelope` | exchange 推 `delivery_endpoint`（#161 RegisterResponse.delivery_endpoint，PM 部署方自起 server 接 webhook） | PM 进程自跑 HTTP register | `pm-agent` |

两种形态对 exchange 完全等价：register envelope outer / `body.kind = "deliver.message"` / FIFO-per-sender / `±5min` anti-replay 等约束都按 #161 / #163 已锁定形态走。

### 理由

1. **前提 3 直接锁定**：用户已锁两路径，本 doc 不二次决策，只 cite。
2. **复用 #163 ABI**：Claude PM 直接复用 `channel.send` / `channel.list_channels`，无新增 MCP tool。
3. **HTTP 形态零协议成本**：非-Claude PM 仅在 PM 进程内实现 #161 envelope outer schema（已锁定）与 register / heartbeat / send / discovery 四组端点，无新增 exchange capability。
4. **与 #162 launcher 解耦**：fulcrum task launcher（#162 ## flag 注入点 段）只管 task agent 与 fulcrum-client mailbox 两条；PM agent 启动器是 PM 部署方的事（chat client / IM bot 自带），fulcrum 不发明 PM launcher。

### Heartbeat 归属

参考 #162 ## 心跳归属 段的双心跳决议：

- Claude PM（MCP 形态）：心跳由 MCP child 跑（按 #161 ## Heartbeat 段默认 `interval_seconds = 30` / `timeout_seconds = 90`）；agent 死 → claude 死 → MCP child 死 → 心跳超时 → exchange 端 mailbox 注销。
- 非-Claude PM（HTTP 形态）：心跳由 PM agent 进程自跑（同样形态走 #161 `body.kind = "heartbeat.ping"`）；PM 进程死 → 心跳停 → exchange 端 mailbox 注销。

两形态心跳归属不同，但 exchange 一侧观察到的失联语义一致。

---

## 消息语义分类

PM ↔ task agent 之间应用层 payload 的 `body_kind` 取值集合。`body_kind` 形态在 #163 ## `channel.send` 段已锁定（任意 JSON 字符串 + 任意 JSON payload，schema 归应用层），本段把 MVP 集合收敛到 ≤5 类。

> **MVP 收敛上限**：≤5 类 `body_kind`（acceptance 第 3 项强约束）。
> **命名 namespace**：`agent.<role>.<verb>` 三段形态，与 #163 ## `channel.send` 段 example（`agent.task.assign` / `agent.reply.text`）对齐。
> **方向不锁死**：每个 `body_kind` 可被任一方发出（PM → worker / worker → PM / worker → worker），方向由 envelope `from` / `to` 决定，不在 `body_kind` 内编码。

### MVP 集合（5 类）

`### \`assignment\``、`### \`clarification_request\``、`### \`clarification_response\``、`### \`progress\``、`### \`completion_claim\`` 五类构成 MVP 收敛集合；详见下列子段。

### `assignment`

PM 把一个 task 派给 worker（一对一）。典型场景：PM 在 chat 里和用户对完需求 / 验收后，调用 `channel.send` 把 task 描述发给某个 worker mailbox。

```ts
// design-only, not yet implemented
interface AssignmentPayload {
  task_id?: string;            // fulcrum task id；PM 已经在 fulcrum 一侧建好 task 时填；纯讨论场景可省
  title: string;               // 简短任务标题
  description: string;         // 任务描述 markdown
  acceptance: string[];        // 验收条件列表
  due_at?: string;             // ISO-8601 UTC；可选
  parent_task_id?: string;     // 父 task（umbrella）id；可选
}
```

约束：

- `task_id` 缺失时由 worker 一侧决定是否自动创建 fulcrum task 行（由 worker 的 fulcrum-client 处理，本协议不强制）。
- 与 #163 `channel.send.payload` 字段对齐：`payload = AssignmentPayload`，无嵌套二层 envelope。
- envelope `from` 字段被 exchange 盖戳（#161 前提 6），worker 一侧凭 `from` 决定回信目标。

### `clarification_request`

worker 收到 assignment 后发现描述不清，主动要求 PM 补信息。也可由 PM 发起对 worker 的反问（双向）。

```ts
// design-only, not yet implemented
interface ClarificationRequestPayload {
  question: string;            // 自由 markdown
  references?: string[];       // 涉及的 fulcrum 资源（task id / file path / commit sha）；可选
}
```

约束：

- `envelope.in_reply_to` 应填上引发问题的 `assignment` / 上一条 `clarification_response` 的 `msg_id`；这是「对话关联标注」（#161 envelope ADT 段，无 ack 语义）。
- 不强制 PM 必须回——MVP 不引入 timeout / 必答约束；超时由 PM 部署方自管 prompt 策略。

### `clarification_response`

回应一条 `clarification_request`。

```ts
// design-only, not yet implemented
interface ClarificationResponsePayload {
  answer: string;              // 自由 markdown
  references?: string[];       // 同 clarification_request
}
```

约束：

- `envelope.in_reply_to` 必须指向对应 `clarification_request.msg_id`；这是 envelope 层「关联标注」，agent 一侧 prompt 可据此把对话拼起来（#161 envelope ADT 段已锁，`in_reply_to` 纯标注，无 ack 责任）。
- 长会话由 envelope FIFO-per-sender + `in_reply_to` 链表表达，本协议不引入 thread-id 一等字段。

### `progress`

worker 主动汇报阶段性进展（不一定有问题，纯信息推送）。PM 据此决定是否继续等待 / 调整策略 / 通知用户。

```ts
// design-only, not yet implemented
interface ProgressPayload {
  task_id?: string;
  stage: string;               // 自由短语，如 "drafted" / "tests passing" / "blocked on review"
  detail?: string;             // 自由 markdown；可选
  fulcrum_status?: "TO_DO" | "IN_PROGRESS" | "IN_REVIEW" | "DONE" | "CANCELED";  // 当前 fulcrum task 状态镜像（可选；见 ## 状态机衔接 段）
}
```

约束：

- `fulcrum_status` 是镜像字段——worker 把当前 fulcrum 一侧的 task status 抄一份进 envelope，仅用于 PM 形成上下文；**`fulcrum_status` 镜像值本身不触发 fulcrum 一侧 task status 转换**（见 ## 状态机衔接 段：所有 status 写入都走 fulcrum HTTP API）。
- 收到 `progress` 不要求 PM 回应；PM 可选择沉默 / 发 `clarification_request` / 发新 `assignment`。

### `completion_claim`

worker 声称 task 已完成，等 PM 接受 / 拒绝。注意：completion 本身不构成 fulcrum task status 转换的协议触发器（见 ## 状态机衔接 段）；此 `body_kind` 只是声称完成的 channel-side 信号。

```ts
// design-only, not yet implemented
interface CompletionClaimPayload {
  task_id?: string;
  summary: string;             // 完成内容摘要
  artifact_links?: string[];   // PR url / commit sha / 文档 path 等
  next_steps?: string[];       // worker 建议的后续工作；可选
}
```

约束：

- PM 收到 `completion_claim` 后可选择：1) 在 fulcrum 一侧直接将 task 转 `IN_REVIEW` / `DONE`（走 fulcrum HTTP API，与 channel 并行；见 ## 状态机衔接 段）；2) 发 `clarification_request` 反问；3) 沉默；4) 发新 `assignment` 派下一轮。
- worker 在发 `completion_claim` 后通常会等 PM 一段时间；但 MVP 不引入 timeout——PM 沉默就是 PM 沉默，worker prompt 自决是否提醒。

### Reserved future shape（不在 MVP）

下列 `body_kind` 草案**不在 MVP 范围**，仅为 forward-compat 占位，避免未来命名漂移。MVP 阶段不被 PM / worker prompt 教授：

- `completion_verify`（reserved）：PM 显式确认完成（与 fulcrum `IN_REVIEW → DONE` 转换在 channel 一侧对照）。MVP 阶段由 fulcrum HTTP API 状态转换隐式表达，channel 不发对应消息。
- `abort`（reserved）：单方面终止当前 task 对话（PM 撤回 assignment / worker 自认无法完成）。MVP 阶段由 PM 在 fulcrum 一侧把 task 转 `CANCELED` 表达，channel 不发对应消息。

写出来仅为约束未来命名（与 #163 ## Future tools placeholder 段同款 forward-compat 策略），避免「同一概念两个命名」的双轨。

### 决策理由

1. **5 类覆盖 PM↔worker 一次对话回路**：派活（`assignment`）→ 反问（`clarification_request` / `clarification_response`）→ 进度（`progress`）→ 交付（`completion_claim`）；MVP 跑通 PM agent 用例所需的应用层信号集已经齐了。
2. **`completion_verify` / `abort` 拆到 reserved**：这两类隐含 fulcrum 一侧 task status 转换的双通道（既走 channel 又走 fulcrum HTTP API），违反 ## 状态机衔接 段「status 转换走 fulcrum HTTP API 单点」决议；MVP 不引入双通道。
3. **payload 形态不锁死 schema**：#163 ## `channel.send` 段已锁定「payload 任意 JSON，MCP 协议层不做 schema 校验」；本段给出的 ADT 是应用层共识，PM / worker prompt 知道这套形态即可工作，无需 exchange 一侧 schema 注册。
4. **`agent.<role>.<verb>` namespace 不在 MVP 引入**：当前 5 类直接用单段命名（`assignment` / `clarification_request` 等），namespace 分段留给后续多 role 场景（如 `agent.observer.audit` / `agent.pm.broadcast`）启用。

---

## 状态机衔接

PM 发什么消息会触发什么 fulcrum task status 转换？走 fulcrum HTTP API（PM 直接调 `/api/tasks/:id/status`，与 channel 并行）还是经 channel 走（channel envelope 触发 worker 主动更新 status）？

### 现有 5 status（per `server/services/task-status.ts`）

按 `server/services/task-status.ts`（CLAUDE.md「Database/tasks」段）：fulcrum task 当前 status 枚举固定为 `TO_DO` / `IN_PROGRESS` / `IN_REVIEW` / `DONE` / `CANCELED`，本 doc **不发明新 status**。所有 status 转换的副作用（worktree 创建 / Claude 进程 kill / 通知 / 重复任务派生）都在 `server/services/task-status.ts` 内统一执行——这是「status 转换走 fulcrum HTTP API 单点」的现成机制。

### 候选

- 候选 1：PM 直接调 fulcrum HTTP API（`POST /api/tasks/:id/status`），channel 完全不承载 status 转换语义；channel 上的 `progress` / `completion_claim` 等消息只是「应用层信号」，由 PM 自决是否把信号翻译成 fulcrum HTTP API 调用。
- 候选 2：channel envelope 携带 status 转换语义——worker 一侧的 fulcrum-client（per #162 ## 三元映射 段，`terminals.channelId` 已经把 channel 和 fulcrum task 关联）监听入站消息，按 `body_kind` 自动调 `server/services/task-status.ts` 的 `updateTaskStatus(...)`。
- 候选 3：双通道——`progress` / `completion_claim` 走 channel，`assignment` 派活同时通过 fulcrum HTTP API 创建 task，`completion_verify` 同时调 channel + fulcrum API。

### trade-off

- 候选 2（channel 触发 status 转换）：违反前提 1「PM agent 在 exchange 上是普通 peer」——peer 之间的消息不应该自动改 fulcrum 内部状态；且 channel envelope 是 at-most-once 无 ack（#161 前提 3），把 status 转换挂在 at-most-once 通道上风险大（PM 发的 `completion_verify` 可能到不了 worker，task 永远卡 `IN_REVIEW`）；同时把 `task-status.ts` 的入口从「fulcrum HTTP API 单点」扩成「HTTP + channel 双入口」，副作用执行点漂移。
- 候选 3（双通道）：等于在候选 2 之上叠加 channel 通道，叠加点更多，与候选 2 的反例叠加同向放大。`assignment` 创建 task 实际上是 PM 调 fulcrum task POST 创建 API（与 status 转换不同的端点），可以由候选 1 在 PM 一侧表达，不需要 channel 一等承载。
- 候选 1（fulcrum HTTP API 单点）：把 fulcrum task status 当作 fulcrum 一侧 invariant，PM 作为 peer 只通过 channel 发应用层信号；要改 fulcrum 状态必须走 fulcrum 现有 API（与人类用户改 status / 其它 agent 改 status 同入口）；status 转换的所有副作用（worktree / kill / 通知）继续由 `server/services/task-status.ts` 统一负责。

### 选定

候选 1 — **status 转换走 fulcrum HTTP API 单点，channel 只承载应用层信号**：

- PM 触发 status 转换 → PM 部署方负责调 `POST /api/tasks/:id/status`（fulcrum 现有 REST 端点 `server/routes/tasks.ts`，与 frontend / 人类用户改 status 同一入口）。
- channel 上的 `body_kind`（`assignment` / `clarification_request` / `clarification_response` / `progress` / `completion_claim`）**不**触发 fulcrum 一侧 status 转换；worker 一侧的 fulcrum-client（per #162 ## 三元映射 段）**不**监听入站消息自动改 status。
- worker 的入站 channel handler（per #163 ## 入站 notification ABI）只把消息送给 agent prompt 上下文，由 agent 自己决定后续动作（可能是调本地 fulcrum API 改 status，可能是 channel 回信，可能两者都做）；这是 agent prompting 一侧策略，不是协议层强约束。

### 5 个 status 的 PM 触发路径表

每个 status 列出 PM 是否会触发该转换、走哪条路径（fulcrum HTTP API / 不直接触发）、对应的 channel 信号 / 副作用：

| status 转换 | 是否由 PM 触发 | 路径 | 关联 channel 信号 | 备注 |
|---|---|---|---|---|
| `TO_DO`（新建） | 是 | PM → `POST /api/tasks`（fulcrum 现有 task 创建端点，`server/routes/tasks.ts`） | PM 创建后通常立即发 `assignment` 给 worker；`assignment.task_id` 填新 task id | 与人类用户在 frontend 创建 task 路径完全一致；fulcrum 不为 PM 单开 task 创建端点 |
| `TO_DO → IN_PROGRESS` | 是 | PM → `POST /api/tasks/:id/status` body `{ status: "IN_PROGRESS" }` | 通常发生在 worker 收到 `assignment` 后；可由 PM 主动转、worker 自转、或 worker 通过本地 fulcrum API 自转——本协议不约束触发方 | 该转换在 `server/services/task-status.ts` 内触发 worktree / scratch dir 创建（CLAUDE.md「Database/tasks」段） |
| `IN_PROGRESS → IN_REVIEW` | 是 | PM → `POST /api/tasks/:id/status` body `{ status: "IN_REVIEW" }` | 通常 PM 收到 worker 的 `completion_claim` 后转 | 该转换在 `task-status.ts` 内触发通知（CLAUDE.md「Database/tasks」段） |
| `IN_REVIEW → DONE` | 是 | PM → `POST /api/tasks/:id/status` body `{ status: "DONE" }` | 通常 PM 验收通过后转；MVP 不发 channel `completion_verify` 消息（见 ## 消息语义分类 段 reserved 说明） | 该转换在 `task-status.ts` 内触发 Claude 进程 kill + 重复任务派生（CLAUDE.md「Database/tasks」段） |
| `* → CANCELED` | 是 | PM → `POST /api/tasks/:id/status` body `{ status: "CANCELED" }` | 通常 PM 撤回派活时转；MVP 不发 channel `abort` 消息（见 ## 消息语义分类 段 reserved 说明） | 该转换在 `task-status.ts` 内触发 Claude 进程 kill；CANCELED 任务**不**派生新重复任务（CLAUDE.md「Database/tasks」段） |

### 与 channel envelope ADT 的关系

- channel envelope 一侧（#161 envelope ADT）：fulcrum task status 不进入 envelope outer 字段。
- channel envelope payload 一侧（## 消息语义分类 段）：`progress.fulcrum_status` / `assignment.task_id` 等是「应用层镜像 / 引用」字段，是 PM ↔ worker 共识的上下文承载，**不**触发 fulcrum 内部状态写入。
- 反向同步（fulcrum task status 改变后通过 channel 广播给 PM）：MVP 不引入。PM 想知道当前 status 走 fulcrum 现有 `GET /api/tasks/:id` 或 SSE / poll；channel 不承载 status 流。

### 决策理由

1. **`task-status.ts` 是 status 转换的 invariant 单点**：所有副作用（worktree / kill / 通知 / 重复任务派生）都集中在 `server/services/task-status.ts` 的 `updateTaskStatus(...)` 路径；让 channel 一侧也写这里等于把 invariant 入口扩成两条，违反 CLAUDE.md「Where to Find Things」段的「Modifying existing features」单点维护原则。
2. **at-most-once 不适合承载 invariant 转换**：#161 前提 3 锁死无 inbox / 无重传；fulcrum task status 是必须可靠落地的 invariant，挂在 at-most-once 通道上意味着 status 漂移风险（PM 发了 `completion_verify` 但 worker 没收到，task 永远 `IN_REVIEW`）。
3. **协议对称**：PM 作为「普通 peer」（前提 1）改 fulcrum 状态走与人类用户、其它 agent 完全一致的 fulcrum HTTP API，没有 PM-only 特权通道；任何 agent / 人类只要持有 fulcrum API token 就能改 status，PM 没有特殊地位。
4. **未来扩展不受阻**：未来如果 PM 想要「订阅 task status 流」，可以走 fulcrum 一侧的 SSE / WebSocket（与 frontend 接收 status 流同入口），不需要在 channel envelope 一侧新加 `task.status.changed` body_kind。

### 未决问题

- PM agent 需要的 fulcrum API token：当前 fulcrum 没有为外部 agent 颁 token 的端点；这条不在本 issue 范围，由 PM agent 实现 wave 单独处理。
- 状态转换的失败回流：如果 PM 调 `POST /api/tasks/:id/status` 失败（任务不存在 / 权限不足 / 业务规则拒绝），fulcrum 返回 HTTP 4xx；PM 部署方自决如何处理（重试 / 报错给用户）；本协议不引入回流 channel 消息。

---

## 多 task 并发（channel-id 发现机制）

PM 同时跟 N 个 task agent（worker）对话——PM 怎么 enumerate / discovery / 发现这些 worker 的 channel-id？

### channel-id 发现机制

按 #161 ## Discovery 段 + #163 `channel.list_channels` tool 已锁定的 `list_channels` API：

- PM 调 `channel.list_channels`（MCP 形态）或 `POST /v1/discovery/list`（HTTP 形态），按 filter `agent_kind: ["worker-agent"]` 过滤出当前活的 worker mailbox 列表。
- 每条 `ChannelDescriptor` 含 `channel_id` / `agent_kind` / `instance_label` / `capabilities` / `registered_at` / `parent_channel_id`（#161 ## Discovery 段 / #163 ## `channel.list_channels` 段）。
- worker 的 channel-id 形态由 #162 ## channel-id 形态 段锁定为 `<mailbox>/task-<id>`（如 `fulcrum-mouriya-laptop/task-42:mcp`），PM 可以从 `channel_id` 字符串里读出 `task-<id>` 段反推 fulcrum task id。
- `instance_label` 是人类可读字段，PM 在 prompt context 里把它展示给用户 / 自身 reasoning 时帮助 disambiguate。

### 多对话并发模式

PM mailbox 是一个，但收件箱里 `from` 可能跨多个 worker（前提 1「普通 peer」+ #161 ## Delivery 语义「FIFO per sender」段）：

- **同 worker FIFO**：来自同一个 worker mailbox 的所有消息严格按到达顺序投递给 PM（#161 前提 4）。
- **不同 worker 之间无序**：不同 worker 发来的消息之间没有全局顺序保证（#161 前提 4）。
- **PM 一侧 prompt 拼接**：PM 在 prompt context 拼对话上下文时，按 `envelope.from` 分组 + 按 `envelope.ts` 排序，构造 per-worker 子对话；`envelope.in_reply_to` 提供回复链关联标注。
- **同时发 N 个 worker**：PM 单次调用 `channel.send` 只能发一个 target（#163 ## `channel.send` 段 `to` 是单值；本 doc 不引入 batch send）；要 fan-out 必须 N 次调用，但因为 send 不阻塞（#161 ## Delivery 语义段「并发投递不阻塞」），N 次串行调用对 PM 来说仍然快。

### 候选（discovery 频率）

- 候选 1：PM 每次要发消息前先调一次 `channel.list_channels`，拿到当前 snapshot 再决定 `to`。
- 候选 2：PM 启动时调一次 `channel.list_channels`，本地缓存 worker 列表；后续靠收到的 inbound envelope 的 `from` 字段增量发现新 worker。
- 候选 3：PM 周期性轮询 `channel.list_channels`（如每 60s）。

### trade-off

- 候选 2（启动一次 + 增量发现）：违反 #163 ## Tool ↔ exchange RPC 关系 段「MCP child 不持本地 mailbox 表副本」原则（虽然该约束写在 MCP child 一侧，但语义同样适用于 PM agent 一侧——本地 cache 会过期，与 discovery snapshot 语义冲突）；新 worker 注册后 PM 直到对方主动发消息才会发现，主动派发场景断掉。
- 候选 3（轮询）：增加 exchange QPS；当前 mailbox 数量级低（< 50），轮询收益不明显；与 #161 ## Discovery 段「不订阅 / 不推送变更」决议不冲突，但同样有 staleness 风险。
- 候选 1（每次按需 list）：与 #161 「snapshot 无订阅」语义直接对齐；PM 一侧 prompt 策略可选「列举所有 worker 后再决定」或「先按已知 from 发，必要时 list」；MVP 不强制 PM 一侧使用模式。

### 选定

候选 1 + agent prompting 一侧策略空间 — **协议层不规约 discovery 频率**：

- 每次 PM 需要 fan-out / 主动派发新 task 时调 `channel.list_channels` 拿当前 snapshot。
- 对已经在对话中的 worker，PM 可以从最近一条 inbound `envelope.from` 直接取 channel-id（不需要 re-list），节省 RPC。
- 协议层只锁定「discovery 机制 = `channel.list_channels` / `POST /v1/discovery/list`」与「snapshot 无订阅」两条不变量；PM 调用频率 / 缓存策略归 PM 部署方 prompt 决定。

### 理由

1. **协议形态 100% 沿用 #161 / #163**：PM 一侧 discovery / enumerate worker 不引入新端点 / 新 tool（前提 2 锁定）。
2. **filter `agent_kind: ["worker-agent"]`** 是发现 worker 的关键：避免 PM 把其它 PM mailbox / fulcrum-client mailbox 当 worker 误派活；与 #161 ListChannelsRequest.filter 直接对应。
3. **`parent_channel_id` 字段（per #161 ChannelDescriptor）** 让 PM 看到 worker MCP child 与其父 fulcrum-client mailbox 的关系，在 prompt context 里可以根据 fulcrum instance 维度 group worker。
4. **协议层不强制策略**：discovery 频率属于 agent prompting 一侧的策略空间；协议层强制只会导致两种过度——要么 PM 每条消息前都 list 浪费 QPS，要么 PM 缓存过期导致漏发；让 prompt 决定符合「protocol minimal, policy by prompt」边界。

### 未决问题

- 大规模 fan-out（PM 一次派 100+ worker）的 rate-limit：当前 `channel.send` 的 `rate_limited` error variant 已经在 #163 中暴露给 PM，但 PM 一侧应对策略（退避 / 排队）属于 PM 部署方 prompt 决定，不在本 doc 范围。
- worker 一侧反向 list PM mailbox 的场景：MVP 未引入（worker 通常只回应入站 PM 消息，不需要主动 list PM 列表）；如未来需要可同样走 `list_channels` 加 filter `agent_kind: ["pm-agent"]`，无需新协议。

---

## PM 失联

PM heartbeat 超时 → exchange 注销 PM mailbox → task agent 后续 send 到该 mailbox 失败——task agent 该怎么处理？继续 / 阻塞 / 写 log？

### 失联检测

PM mailbox 失联检测 100% 沿用 #161 ## Heartbeat 段：

- 默认 `interval_seconds = 30` / `timeout_seconds = 90`；连续 3 次心跳缺失即 deregister，无 grace period。
- Claude PM 失联触发器：PM Claude session 死 → MCP child 死 → 心跳停 → exchange 90s 后 deregister（与 #163 ## 入站 notification ABI 段「MCP child 进程死」一致）。
- 非-Claude PM 失联触发器：PM HTTP 进程死 → 心跳 ping 停 → exchange 90s 后 deregister。
- exchange 一侧 deregister 后，后续指向该 PM mailbox 的 `deliver.message` 走 #161 ## Delivery 语义 段的 `mailbox_deregistered` error variant，异步通过 `deliver.error` envelope 回送到 sender mailbox。

### worker 一侧入站观察

worker 在收到 PM 离线后，通过下列路径感知：

1. **入站 `delivery_error` notification**（#163 ## 入站 notification ABI 段）：worker 调用 `channel.send` 后，inbound 通道收到 `{ event: "delivery_error", error: "mailbox_deregistered", failed_msg_id, human_message }` —— 此时 worker 知道刚发的那条没到 PM。
2. **discovery 列表落空**：worker 主动调 `channel.list_channels` 过滤 `agent_kind: ["pm-agent"]`，结果为空或不含期待的 PM mailbox —— 此时 worker 知道目前没活的 PM。

### worker 一侧处置候选

- 候选 1：worker 继续干活，把 PM 失联当作「沉默」对待——不阻塞、不重试、不写日志特殊路径；inbound `delivery_error` 在 agent prompt 上下文里出现，由 agent prompting 自决。
- 候选 2：worker 自动转 fulcrum task status 为 `IN_REVIEW`（卡 review 等 PM 回来）或 `CANCELED`（撤回）。
- 候选 3：worker 主动重试 `channel.send` N 次；重试用尽则报错。

### trade-off

- 候选 2（自动转 status）：违反 ## 状态机衔接 段「status 转换走 fulcrum HTTP API 单点」决议——worker 一侧把 channel `delivery_error` 信号自动翻译成 fulcrum task status 写入，把 channel 与 fulcrum status 绑成双通道；同时 PM 失联不必然意味着 task 必须停滞（worker 完全可以独立完成、留 `completion_claim` 在 inbox 给重新上线的 PM）。
- 候选 3（重试）：违反 #161 前提 3「不重传」——`channel.send` 没有重发机制；worker 一侧自跑重试等于把重传机制偷偷塞到协议层，违反 at-most-once 锁定。
- 候选 1（沉默 + agent prompting 自决）：与协议 invariant 完全一致；worker prompt 看到 `delivery_error` notification 后自决（继续工作 / 写日志 / 等 PM 回来 / 把 fulcrum task 标 `blocked`），policy 不进协议层。

### 选定

候选 1 — **worker 一侧不引入协议级特殊路径，agent prompting 自决**：

- worker 收到 `mailbox_deregistered` 入站 `delivery_error` notification 后，notification 进入 agent prompt 上下文，agent 自决后续动作。
- worker 不自动转 fulcrum task status（与 ## 状态机衔接 段「fulcrum HTTP API 单点」一致）。
- worker 不重试 `channel.send`（与 #161 前提 3「不重传」一致）。
- worker 可以选择性地把 PM 失联记入 fulcrum 一侧的 task log / observerInvocations 记录（per CLAUDE.md「Database/tasks」/`observerInvocations`），但这是 worker 一侧 prompt 决定，不在协议层。

### PM 重新上线

PM 重新上线 = PM 走一遍 #161 register 流程拿新 mailbox（可能 channel-id 同 desired，也可能 exchange 附 `#2` 后缀冲突标记）。worker 一侧没有「PM 恢复」事件——下一次 PM 发消息时 worker inbound 看到 `from = <PM 新 channel-id>`，agent prompt 据此判断「这是同一个 PM 还是新 PM 实例」（PM 部署方一侧 prompt 应在 `assignment` payload 里带稳定 identity hint）。

### 决策理由

1. **协议层最小化**：PM 失联是 #161 已经定义的 `mailbox_deregistered` 路径，不引入 PM-only 特殊处置。
2. **policy 由 prompt 而非协议**：worker 一侧应对 PM 失联的合理行为高度依赖 task 性质（短任务 / 长任务 / 自治程度），prompt 比协议更适合表达；协议强制反而扭曲使用。
3. **与 ## 状态机衔接 段对称**：channel 信号不直接驱动 fulcrum invariant；PM 失联的副作用全部在 prompt context 里观察并处置。
4. **bridge-e2e 经验**：bridge-e2e 在 PR-event 通道里也没有为发送方失联引入特殊路径——所有 inbound 失败都走应用层判定，本 doc 沿用。

### 未决问题

- PM 部署方一侧 identity hint：稳定 identity hint（`assignment.payload` 内某字段表达「我是 PM 实例 A 而非 B」）当前在 ## 消息语义分类 段未引入；如未来 worker 需要严格 disambiguate，可在 `assignment` payload 加 `pm_identity_hint` 字段（不影响 envelope outer）。
- fulcrum 一侧的「PM 在线状态」 surfacing：当前 fulcrum UI 没有「外部 PM mailbox 在线状态」展示位；如需要可以在未来扩 Settings → AI 段（per #162 ## 全局开关 段 SettingsSection「Agent Channel」）加一个 list view，调 `list_channels` 显示在线 PM。

---

## Chat 启动 UX hook

per memory `project_fulcrum_agent_native_features`：「chat 启动 UX 和设置开关：是否以 PM 模式启动」。本段给出该开关需要暴露的**最小接口形态**——不含 UI 实现、不含 prompt 编排、不含 PM agent runtime 代码。

### 范围

锁定下列三件事的最小接口：

1. **「以 PM 模式启动 chat」**的开关位置与默认值。
2. **启动 PM agent**的最小参数集（让 PM 部署方知道需要提供什么）。
3. fulcrum 一侧负责的边界（fulcrum 起 / 不起 PM agent；起的话起哪一种形态）。

本段**不**实现 chat UI、**不**编排 PM agent prompt、**不**写 PM agent runtime。

### 开关归属

per #162 ## 全局开关 段已经在 Settings → AI tab 新开了 SettingsSection「Agent Channel」（enable / exchange URL / token / mailbox / mcpVersion 5 字段），本 doc 在同一 SettingsSection 下补一个 sub-block「PM Agent Mode」（命名建议，design-only）：

| 字段（命名建议） | 类型 | 默认 | 说明 |
|---|---|---|---|
| `channels.pm.enabled` | plain bool | `false` | 是否在 fulcrum chat surface 上提供「以 PM 模式启动」入口；关闭时 chat 入口不出 PM mode 选项 |
| `channels.pm.clientForm` | plain enum (`"claude-mcp"` / `"external-http"`) | `"claude-mcp"` | PM agent 客户端形态（per ## PM agent 客户端形态 段两枚举）；`external-http` 时 fulcrum 不起 PM 进程，仅展示「PM mailbox 状态」 |
| `channels.pm.mailbox` | plain string | `""` | PM mailbox 标识（`desired_channel_id` 形态，如 `pm-mouriya/main`）；空字符串 = 让 exchange 分配 |
| `channels.pm.systemPromptRef` | plain string | `""` | PM agent system prompt 引用（路径 / URL / fnox key 引用形态由 PM 部署方决定）；fulcrum 不解析内容，只透传给 PM 启动器 |

> fnox key 命名沿用 `channels.*` 子树（与 #160 / #162 已锁的 `channels.exchange.*` 同 namespace）；本 doc 不重新命名。
> 上表是 design-only `// not yet implemented`；具体 fnox provider（plain / age）与 settings 表单组件归实现 wave。

### 启动 chat 时的 hook 接口

chat surface（fulcrum 内或外部 chat client）需要在「开始对话」时知道：

- 这次对话**是不是** PM 模式（前置开关读 `channels.pm.enabled`）；
- 走哪一种 PM agent 客户端形态（读 `channels.pm.clientForm`）；
- PM mailbox 是哪一个（读 `channels.pm.mailbox`）；
- PM agent system prompt 引用（读 `channels.pm.systemPromptRef`）。

最小接口形态（命名建议，design-only）：

```ts
// design-only, not yet implemented
interface PmModeChatHook {
  enabled: boolean;                                  // channels.pm.enabled
  clientForm: "claude-mcp" | "external-http";        // channels.pm.clientForm
  mailbox: string;                                   // channels.pm.mailbox（空则让 exchange 分配）
  systemPromptRef: string;                           // channels.pm.systemPromptRef（fulcrum 透传，不解析）
  exchange: {
    url: string;                                     // 等于 channels.exchange.url（#160）
    // token 不进 hook return，由 PM 启动器自 fnox 读
    mailboxNamespace: string;                        // 等于 channels.exchange.mailbox（#162 channel-id 形态）
  };
}

// 暴露端点（设计形态，不签字）：
// GET /api/channels/pm/mode  →  PmModeChatHook
```

返回 `PmModeChatHook` 的端点是只读 hook；chat surface 据此决定：

- `enabled = false` → 不展示 PM 模式入口，按普通 chat 走（不在本 issue 范围）。
- `enabled = true && clientForm = "claude-mcp"` → chat surface 把对话连到一个 Claude session（具体由 chat surface 实现层决定 spawn / attach 哪个 Claude），该 Claude session 在 spawn 时挂 `@agent-channel/mcp` 作为 MCP child，channel-id 用 `mailbox` 作为 `desired_channel_id`。
- `enabled = true && clientForm = "external-http"` → fulcrum **不**起 PM 进程；chat surface 假定外部 PM 已经独立 register 到 exchange，chat 只在 UI 上显示 PM mailbox 在线状态（来源：fulcrum server 一侧定期调 `list_channels` 缓存）。

### 候选（fulcrum 是否直接 spawn Claude PM）

- 候选 1：fulcrum server 直接 spawn 一个 Claude session 作为 PM agent（fulcrum 持 PM 进程 lifecycle）。
- 候选 2：fulcrum 只暴露 hook 接口，PM agent 启动归 chat surface（如外部 chat client / IM bot integration / 手动 CLI）—— fulcrum 不持 PM 进程 lifecycle。
- 候选 3：可配置——MVP 默认候选 2，但留接口让未来 fulcrum 也能 spawn。

### trade-off

- 候选 1（fulcrum spawn Claude PM）：违反 ## PM agent 注册路径 段「fulcrum 不持有 PM agent exchange token」边界；同时让 fulcrum task launcher 之外再多一条「PM launcher」路径，与 #162 ## flag 注入点 段「launcher 唯一权威 = `claudeBuilder.buildCommand`」抽象冲突。
- 候选 3（可配置）：MVP 不需要双形态，引入配置位等于过早抽象。
- 候选 2（fulcrum 不起 PM）：与本 doc 全段「PM 是普通 peer」（前提 1）一致；fulcrum 只是 chat surface + settings 配置 + 状态展示，PM 进程 lifecycle 完全归 PM 部署方。

### 选定

候选 2 — **fulcrum 不 spawn PM agent，只暴露 hook 接口与 settings 配置**：

- fulcrum server 不持 PM 进程 PID / lifecycle。
- fulcrum 一侧只负责：1) `channels.pm.*` settings 字段持久化（fnox）；2) `GET /api/channels/pm/mode` 只读 hook；3) Settings UI 上的「PM 模式开关」与「在线 PM mailbox 列表」展示位（数据来自 `list_channels`）；4) chat surface 入口的 PM 模式标识。
- PM agent 起进程 / 配 token / 死掉重起等全归 PM 部署方（chat client / IM bot integration / 手动 CLI 启动器）。

### 决策理由

1. **「peer 而非内部组件」**：候选 2 直接对齐前提 1；fulcrum 既然把 PM 当作 exchange 上的普通 peer，就不应该持有 PM 进程 lifecycle，否则 peer 边界破裂。
2. **launcher 单一权威**：#162 已锁 `claudeBuilder.buildCommand` 是 fulcrum 一侧 agent launcher 唯一权威（针对 task agent + fulcrum-client mailbox 两类）；PM agent launcher 归 PM 部署方，与现有 launcher 边界不重合。
3. **最小接口**：仅暴露一个只读 hook + 4 个 settings 字段；UI 实现 / chat surface 集成 / PM prompt 编排都不在本 issue 范围。
4. **forward-compat**：未来若 fulcrum 想 spawn Claude PM（如「PM 模式 as a service」），扩 `channels.pm.spawnedByFulcrum` 字段 + 新 endpoint 即可，本 hook 接口不动。

### 未决问题

- chat surface 实现层（哪些 surface 算 fulcrum chat surface：现有 task terminal / 未来独立 chat tab / IM bot 接入）：归实现 wave。
- PM mailbox 在线状态轮询频率（fulcrum server 定期调 `list_channels` 缓存的 TTL）：归实现 wave。
- 多 PM 实例同时在线时 chat surface 一侧的 disambiguation UX：归实现 wave。

---

## 与 #160 / #161 / #162 / #163 决议的对齐

- 协议血统：from-scratch（#160 决议）；本 doc 不重写 envelope schema / 不重新设计 tool ABI / 不重写 launcher。
- envelope / register / heartbeat / discovery / delivery 形态：100% 沿用 #161；PM agent 作为「普通 peer」（前提 1）使用与 task agent 完全一致的协议。
- fulcrum-client / task agent launcher（#162 `claudeBuilder.buildCommand` / `channels.exchange.*` fnox key / channel-id 形态 / 三元映射 / 注册时序 / 心跳归属 / server 重启恢复 / 全局开关）：本 doc 不改动，只在 ## Chat 启动 UX hook 段沿用同 SettingsSection 加 PM 子 block。
- MCP tool ABI（#163 `channel.send` / `channel.list_channels` / 入站 notification）：本 doc 不重写 tool schema；PM agent（Claude PM 形态）直接复用同 tool。
- channel-id 形态：PM agent 一侧 channel-id 形态由 PM 部署方决定（典型 `pm-<deployer>/<scope>`），与 #162 `<mailbox>/task-<id>` task agent 一侧形态各自独立但都符合 #161 `ChannelId` 形态。
- 包归属：本 doc 协议层无关 fulcrum 状态机的部分（## PM agent 注册路径 / ## PM agent 客户端形态 / ## 消息语义分类 / ## 多 task 并发 / ## PM 失联）落地为 `@agent-channel/protocol` 包文档；## 状态机衔接 / ## Chat 启动 UX hook 留 fulcrum（与 #162 同样形态）。

## 关联

- Umbrella: #153
- Parent thread: #164
- 直接 unblock: PM agent 实现 wave（不在本 design wave）
- 协议形态唯一权威: #161（`docs/design/channel/02-wire-contract.md`）
- repo / 部署 / 包归属唯一权威: #160（`docs/design/channel/00-exchange-repo-decision.md`）
- fulcrum-client launcher / 注册 / 心跳决策: #162（`docs/design/channel/03-fulcrum-client.md`）
- MCP tool ABI / 入站 notification 决策: #163（`docs/design/channel/04-mcp-tool-abi.md`）
- 角色描述源: `project_fulcrum_agent_native_features`（memory）
- fulcrum task 状态机源: `server/services/task-status.ts`（CLAUDE.md「Database/tasks」段）
