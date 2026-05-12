# Design: Channel MCP server 工具集与入站 notification ABI

> Status: **subject-to-relocation** — 本文档随 exchange repo（`agent-channel-exchange`，见 #160）起步后，整段挪到该 repo 的 `@agent-channel/mcp` 包旁；fulcrum 仅保留指针式引用。
> Closes thread of: #163（umbrella #153）
> Depends on: #160（`docs/design/channel/00-exchange-repo-decision.md`）/ #161（`docs/design/channel/02-wire-contract.md`）/ #162（`docs/design/channel/03-fulcrum-client.md`）
> Blocks: #164（PM agent 协议层）/ 实现 wave

## 范围

锁定 Claude Code agent 通过 MCP child 与 exchange 交互的所有 ABI：

- MCP capability 声明形态；
- MVP 出站 tool 集合（每 tool params / return / errors 完整 typed schema）；
- 入站 `notifications/claude/channel` payload 与 #161 envelope ADT 的字段映射；
- Error 暴露给 agent 的形态（tool error vs return variant）；
- Future tools 占位（不在 MVP，仅 forward-compat 标识）；
- Tool ↔ exchange RPC 简述。

本 doc 不实现任何代码——所有 schema 标 `// design-only, not yet implemented`。本 doc 不预判 #164 PM agent 协议内部决策。本 doc 不发明 inbox 持久化 / ack / 重传 / 批量发送——这些被用户明确排除（见 #161 前提 3）。

引用形态：tool schema 用 TypeScript-flavor 伪代码 + ADT 风格 discriminated union 表达；落地 repo 时 `@agent-channel/mcp` 包内部决定走 Arktype / Zod / `@sinclair/typebox` 中哪一个 schema-as-type runtime（决策点归 exchange repo 的 `@agent-channel/protocol` 包，见 #161）。

## 用户已锁定的前提（不可推翻）

下列 5 条由用户对本 issue 明确约束，本 doc 必须 cite 进每个决策：

1. **`claude/channel` 是单向 push**：server → client only。Agent 出站必须走 MCP **tool call**。
2. **每个 Claude Code 进程 = 1 个 mailbox**（per `--channels server:<cmd>`，见 #161 前提 1 / #162 ## channel-id 形态）。
3. **不留 inbox 不重传**：消息推到 `notifications/claude/channel` 即消失；agent 必须当时处理。Inbox 类工具（`list_inbox` / `ack`）**保留为 future shape 但不在 MVP 范围**。
4. **MCP child = claude subprocess**（stdio transport，见 #161 前提 5 / #162 前提 5）。
5. **Authorization 在 exchange 控**：tool 实现只把请求转给 exchange，不本地拒（见 #161 前提 6 / Authorization model 段）。

---

## Capability 声明

MCP child 在 server initialization 阶段向 host（claude 进程）声明其 capability 集合。本 capability 是 push 通道协议层的 opt-in，不是任何具体 tool 的代名词。

### 形态

```ts
// design-only, not yet implemented
interface ChannelMcpCapabilities {
  experimental: {
    "claude/channel": {
      // MVP: 空 object 即 opt-in；未来扩 capability 子位（如 inbox / ack）时在此挂 field
    };
  };
}
```

MCP server 在 `initialize` 响应里返回上述 capabilities；host（claude）据此决定是否允许发送 `notifications/claude/channel` push。

### 决策

| 维度 | 选定 | 理由 |
|---|---|---|
| capability key 命名 | `claude/channel`（namespace 走 vendor-prefix 形态） | 与 bridge-e2e `claude-code-pr-bridge-e2e` `repos/claude-code-pr-channel/src/runtime.ts` 的 `experimental: { 'claude/channel': {} }` 同形——目的是让现有 Claude Code agent 接入认知零迁移；不重命名为 `agent/channel` 避免破坏 bridge-e2e fixture 复用。 |
| capability value 形态 | 空 object（MVP），forward-compat 留 field 扩展位 | 等于「我支持 claude/channel 协议」的 boolean opt-in，最小信息量；未来若引入 inbox 持久化 capability，扩 `claude/channel: { inbox: true }` 而不破坏旧 reader。 |
| transport | MCP stdio | 由前提 4 锁定（MCP child 是 claude subprocess）；MCP server stdio 是 claude `--channels server:<cmd>` 唯一支持形态，本 doc 不引入 HTTP transport。 |

### Host 视角

claude 进程在 `initialize` 后看到 `experimental["claude/channel"]` 即认为该 server 有 push 能力，开通 `notifications/claude/channel` 通道；未声明则按普通 MCP server 处理（仅 tool call，无 push）。

参考血统：bridge-e2e `claude/channel` capability 在 `claude-code-pr-bridge-e2e` 已经过验证；本 doc 沿用，不重新设计协议层 capability 名。

---

## MVP tool set

MVP tool 集合的最小化目标：能让 PM↔task 用例跑通的最小集合。用户已锁定上限——出站 ≤3 个 tool，必须含 `channel.send`。

### 选定（2 个 MVP tool）

| Tool | 必选 | 用途 |
|---|---|---|
| `channel.send` | 必选 | 主动投递一条消息到某 target mailbox；包装 #161 `deliver.message` envelope。 |
| `channel.list_channels` | 必选 | 发现当前活的 mailbox 列表；agent 决定 `to` 的前提（前提 2「1 进程 1 mailbox」下，`to` 不能从配置里写死）。 |

为什么不只 `channel.send`：在 PM↔task 用例里，PM agent 启动时不知道有哪些 worker mailbox 活着；如果只有 `channel.send`，PM 唯一能填的 `to` 是「从入站 notification 的 `from` 反推」——这把 PM 退化成 reactive-only，主动派发场景断掉。`list_channels` 是 MVP 必须项。

为什么不加第 3 个：候选第 3 个曾考虑 `channel.reply`（等价 `channel.send` + 自动填 `in_reply_to`）和 `channel.whoami`（返回本 mailbox 的 channel-id）。`reply` 不引入新协议形态，纯 syntactic sugar——agent 自己填 `in_reply_to` 即可；`whoami` 信息在 MCP child 起步时已经从 #162 register response 拿到，可以走 server initialization 时的 `serverInfo` 字段下发，不需要单独 tool。两个候选都被排除以保持最小。

### Tool naming 决策

候选：`channel.send` / `mailbox.send` / `mcp__channel__send`。

| 候选 | trade-off | 结论 |
|---|---|---|
| `channel.send` | 与 user-facing「channel」概念一致；agent prompting 时可读。 | **选定**。 |
| `mailbox.send` | 把内部协议术语（mailbox = exchange 一侧 mailbox 表行）暴露给 agent；agent 不需要分「channel/mailbox」二层抽象。 | 拒绝。 |
| `mcp__channel__send` | bridge-e2e fixture 看到过该形态；点号在 prompting 文档里阅读体验差，且 MCP tool name 不强制 namespace 双下划线分隔。 | 拒绝。 |

选 `channel.send`：1) 与 user mental model 一致；2) namespace dot 不与任何 MCP 现有 tool 冲突；3) 把 agent 视角的协议表面收敛到 `channel.*` 一个前缀。

---

### `channel.send`

主动投递一条消息到指定 target mailbox。内部把 args 包成 #161 `Envelope<deliver.message>` 转给 exchange。

#### Params（参数 schema）

```ts
// design-only, not yet implemented
interface ChannelSendParams {
  to: ChannelId;            // 目标 mailbox 标识；由 list_channels 或上游 inbound notification.from 取
  body_kind: string;        // 应用层 payload kind，例如 "agent.task.assign" / "agent.reply.text"
  payload: unknown;         // 应用层 payload；schema 归 #164 (PM agent) 与后续 wave 定义
  in_reply_to?: string;     // 等价 envelope.in_reply_to；引用一条 inbound 消息的 msg_id
}
```

字段约束（exchange 端实际校验，tool 实现只透传，不本地预拒）：

- `to` 形态见 #161 `ChannelId`（如 `fulcrum-mouriya-laptop/task-42`）。
- `body_kind` 非空字符串；exchange 不预设白名单，由应用层共识。
- `payload` 任意 JSON 可序列化值；MCP 协议层不做 schema 校验，schema 归应用层（如 #164 定义的 PM agent 消息 ADT）。
- `in_reply_to` 是 ULID 形态（与 envelope `msg_id` 同型）；填错或指向已忘的消息也 OK——前提 3 锁死无 ack 语义，`in_reply_to` 是纯标注。

#### Return（返回值 schema）

```ts
// design-only, not yet implemented
type ChannelSendResult =
  | { ok: true; msg_id: string; sent_at: string }   // ok 路径：exchange 接收并接入路由
  | { ok: false; error: ChannelToolError };          // 已知 error variant（见 Errors 段）
```

- `msg_id`：exchange 路由前已存在的 ULID（MCP child 一侧生成，与 envelope `msg_id` 同一字段，return 里冗余携带方便 agent 关联日志）。
- `sent_at`：ISO-8601 UTC，exchange 受理瞬间的时戳；agent 据此排序自身发出消息日志。

**ok=true 不等于「target 已读」**：前提 3 锁死 at-most-once 无 ack；ok 仅表示 exchange 已接受并接入 per-target 队列。target mailbox 注销 / 离线在 exchange 一侧 inbound 投递阶段才发现，那条失败会**异步**通过 `notifications/claude/channel` 的 `deliver.error` 形态推回（见 ## 入站 notification ABI 段）。

#### Errors（错误 variant）

```ts
// design-only, not yet implemented
type ChannelToolError =
  | { kind: "exchange_offline"; message: string }              // MCP child 连不到 exchange；本 variant 由 MCP child 一侧 SDK 抛出
  | { kind: "envelope_invalid"; message: string }              // args 无法包成合法 envelope（ts / msg_id / schema_version 形态问题）
  | { kind: "schema_version_incompatible"; message: string }   // exchange 拒绝 major 版本
  | { kind: "rate_limited"; message: string; retry_after_s?: number };
```

注意 `target_unknown` / `unauthorized` / `mailbox_deregistered` 这三个 variant 在 `channel.send` 的同步 return 里**不出现**——它们都属于「exchange 已经接受 envelope，路由阶段才失败」，按 #161 ## Delivery 语义 段定义异步走 `deliver.error` envelope 回到 sender mailbox 的 inbound 通道。从 agent 视角，这三种失败由入站 notification（`deliver.error` payload）观察，而非 tool return。

---

### `channel.list_channels`

发现当前活的 mailbox 列表。包装 #161 `discovery.list_request` envelope，结果由 exchange 端 snapshot。

#### Params（参数 schema）

```ts
// design-only, not yet implemented
interface ChannelListParams {
  filter?: {
    agent_kind?: Array<"fulcrum-client" | "mcp-child" | "pm-agent" | "worker-agent" | "observer">;
    capability?: Array<"channel.send" | "channel.receive" | "discovery.list">;
    label_glob?: string;
  };
}
```

形态 100% 沿用 #161 ## Discovery 段的 `ListChannelsRequest`。filter 全空 = 默认全列（前提 7：默认全列，授权拦截在 send）。

#### Return（返回值 schema）

```ts
// design-only, not yet implemented
type ChannelListResult =
  | {
      ok: true;
      channels: ChannelDescriptor[];
      generated_at: string;          // ISO-8601 UTC；snapshot 时刻
    }
  | { ok: false; error: ChannelToolError };

interface ChannelDescriptor {
  channel_id: ChannelId;
  agent_kind: string;
  instance_label: string;
  capabilities: string[];
  registered_at: string;
  parent_channel_id?: ChannelId;     // MCP child 通过此字段反向追踪父 fulcrum-client mailbox
}
```

`ChannelDescriptor` 形态 100% 沿用 #161 ## Discovery 段；MCP tool 这一层不重命名字段。

#### Errors（错误 variant）

同 `channel.send` 的同步 error 集合：`exchange_offline` / `envelope_invalid` / `schema_version_incompatible` / `rate_limited`。

`unauthorized`（agent 缺 `discovery.list` capability）按 #161 设计也是异步走 envelope，但本 tool 调用是同步 request-response——这是 list 操作本身的同步性决定的；exchange 若发现 sender 无 `discovery.list` capability，直接 return 一条 `unauthorized` envelope 作为 response（在 #161 ## Delivery 语义 段是异步，但在 ## Register API 同步上下文里 discovery 走 envelope-as-response）。本 tool 一侧把它 normalize 成 `{ ok: false, error: { kind: "unauthorized" } }` 返回。

补充 variant：

```ts
// design-only, not yet implemented
type ChannelListExtraError =
  | { kind: "unauthorized"; message: string };   // 仅在 list_channels return 出现；send 走异步路径不在此
```

---

## 入站 notification ABI

`notifications/claude/channel` 是从 MCP child 向 host（claude）push 的协议形态。MCP 协议规定 notification 形态为 `{ method, params }`；本段实例化 `method = "notifications/claude/channel"` 时 `params` 的字段集合，并给出与 #161 envelope ADT 的字段映射。

### 通用 wrapper

每个 inbound notification 在 MCP child 内是由 exchange 推过来的 #161 envelope 翻译而成的。为让 agent 一侧 schema 单一、不暴露内部协议细节，wrapper 形态保持薄：

```ts
// design-only, not yet implemented
interface ChannelNotificationParams {
  channel_event: ChannelEvent;          // discriminated union by `event`
  envelope_meta: EnvelopeMeta;          // 提取自 #161 envelope outer
}

interface EnvelopeMeta {
  msg_id: string;                       // envelope.msg_id（ULID）
  from: ChannelId;                      // envelope.from（exchange-stamped）
  to: ChannelId;                        // envelope.to
  in_reply_to?: string;                 // envelope.in_reply_to
  ts: string;                           // envelope.ts（ISO-8601）
  schema_version: string;               // envelope.schema_version
}

type ChannelEvent =
  | { event: "message"; body_kind: string; payload: unknown }
  | { event: "delivery_error"; error: DeliveryErrorVariant; failed_msg_id: string; human_message: string };

type DeliveryErrorVariant =
  | "target_unknown"
  | "unauthorized"
  | "mailbox_deregistered"
  | "envelope_invalid"
  | "schema_version_incompatible"
  | "rate_limited";
```

### 决策：wrapper 而非 1:1

设计点：notification.params 是 1:1 的 envelope dump，还是带 wrapping？

- 候选 1：`params = Envelope<deliver.message>`，完整 envelope outer + inner 透传给 agent
- 候选 2：`params = { channel_event, envelope_meta }`，envelope outer 字段拍平到 meta，body 拆出 `event` tag

候选 1 把 #161 envelope 字段全暴露给 agent prompt 空间——agent 每条消息要看 `body.kind === "deliver.message" && body.payload.body_kind === "agent.task.assign"` 这种双层 tag；可读性差，且把内部协议细节（envelope schema_version 等）拍到 agent prompting 表面。候选 2 把双层 tag 收敛成一个 `event` discriminator，envelope outer 字段只留 agent 真用得到的（`msg_id` / `from` / `to` / `in_reply_to` / `ts` / `schema_version`），其余（`body.kind = "deliver.message"` 这种内部 tag）由 MCP child 在翻译时丢弃。

**选定**：候选 2 — wrapper，但保持薄。

理由：1) agent 视角的 schema 只剩 `ChannelEvent` 一个 discriminated union；2) envelope outer 协议级字段提取到 `envelope_meta`，agent 需要日志 / `in_reply_to` 关联时直接取；3) 未来 envelope 内层（#161 `EnvelopeBody`）加 capability 时，wrapper 一侧只翻译新 `event` variant，agent 旧 prompt 路径不破。

### 与 #161 envelope 字段映射

本段是 acceptance 第 8 项的核心交付物——明确每个 wrapper 字段来自 #161 envelope 的哪个位置。

| Wrapper 字段 | 来源（#161） | 翻译规则 |
|---|---|---|
| `envelope_meta.msg_id` | `Envelope.msg_id` | 透传，不变。 |
| `envelope_meta.from` | `Envelope.from`（exchange-stamped） | 透传。前提 (6)：from 由 exchange 盖戳，MCP child 不二次验证。 |
| `envelope_meta.to` | `Envelope.to` | 透传。 |
| `envelope_meta.in_reply_to` | `Envelope.in_reply_to` | 透传；undefined 时省略 key。 |
| `envelope_meta.ts` | `Envelope.ts` | 透传 ISO-8601 字符串。 |
| `envelope_meta.schema_version` | `Envelope.schema_version` | 透传。 |
| `channel_event` discriminator | `Envelope.body.kind` | `deliver.message` → `event: "message"`；`deliver.error` → `event: "delivery_error"`；其它 `body.kind` 在 MCP child 内部消费，不上抛到 agent（如 `heartbeat.*` / `register.*` / `discovery.*`）。 |
| `channel_event.body_kind` | `Envelope.body.payload.body_kind`（when `kind = "deliver.message"`） | 透传 #161 `DeliverMessage.body_kind`。 |
| `channel_event.payload` | `Envelope.body.payload.payload`（when `kind = "deliver.message"`） | 透传 #161 `DeliverMessage.payload`。 |
| `channel_event.error` | `Envelope.body.payload.error`（when `kind = "deliver.error"`） | 透传 #161 `DeliverError.error`（variant 字符串）。 |
| `channel_event.failed_msg_id` | `Envelope.body.payload.failed_msg_id`（when `kind = "deliver.error"`） | 透传 #161 `DeliverError.failed_msg_id`。 |
| `channel_event.human_message` | `Envelope.body.payload.human_message`（when `kind = "deliver.error"`） | 透传 #161 `DeliverError.human_message`。 |
| 丢弃 | `Envelope.body.payload.reply_to_msg_id`（#161 `DeliverMessage` 的冗余字段） | MCP child 已经把 `in_reply_to` 提到 `envelope_meta` 一层；application 层的冗余 `reply_to_msg_id` 不再向 agent 透出。 |

### 协议血统说明

bridge-e2e `Mouriya-Emma/claude-code-pr-bridge-e2e` `repos/claude-code-pr-channel/src/runtime.ts` 已经验证 `notifications/claude/channel` 通过 `mcp.notification(...)` emit 的形态；本 doc 沿用 method 名 `notifications/claude/channel`，不改名为 `notifications/agent/channel` 以保持 bridge-e2e fixture 复用。

### 投递保证

- **At-most-once**：见 #161 前提 (3) / ## Delivery 语义。MCP child 收到 envelope → emit notification → agent 处理 → 完事；不重试不持久化。
- **FIFO per sender**：见 #161 前提 (4)；MCP child 在 stdio transport 层保持收到顺序的 emit 顺序。
- **MCP child 进程死**：所有未 emit 的 envelope 丢失（前提 4：MCP child = claude subprocess，claude 死则 child 死）。这不引入 ack——前提 3 锁死无 ack。

---

## Error 暴露给 agent 形态

agent 视角的错误三分法：

1. **tool return 的 error variant**（同步本地知道的错） — 形态见 `channel.send` / `channel.list_channels` 的 Errors 段。包括 `exchange_offline` / `envelope_invalid` / `schema_version_incompatible` / `rate_limited` / `unauthorized`（仅 list_channels 同步可见）。
2. **inbound notification 的 `delivery_error` event**（异步路由失败） — 形态见 ## 入站 notification ABI 段的 `channel_event = { event: "delivery_error", ... }`。包括 `target_unknown` / `unauthorized`（send 路径异步可见） / `mailbox_deregistered` 等。
3. **MCP protocol-level error**（tool 实现 panic / args 解析失败 / 等） — 走 MCP 标准 tool error；不进 `ChannelToolError` ADT。

### 决策：throw vs return

设计点：`channel.send` / `channel.list_channels` 的错误暴露给 agent，是 throw（走 MCP tool error）还是 return 一个 `{ ok: false, error }` variant？

- 候选 1：所有错误 throw 为 MCP tool error；agent 用 try/catch
- 候选 2：所有 typed 错误 return 为 `{ ok: false, error }`；只有 panic / 协议级故障 throw
- 候选 3：分类——`exchange_offline` 这种「infra 级」 throw；`rate_limited` / `unauthorized` 这种「业务级」 return

候选 1 把所有错误推进 MCP tool error 通道；agent prompting 看不到 error variant 形状，必须读 `error.message` 字符串再解析——违反 ADT 原则。

候选 3 看似分层清晰，但 throw / return 边界判定主观（`exchange_offline` 算 infra 还是业务？rate_limited 是不是「target 拒绝」的业务态？），且双通道让 agent prompt 必须同时教 try/catch 和 result-variant 处理，增加认知负担。

**选定**：候选 2 — 所有 typed `ChannelToolError` 走 return；只有真正的「MCP protocol broken / tool impl panic / args JSON 解析失败」走 MCP tool error。

理由：1) `ChannelToolError` ADT 一处声明，agent 一处 exhaustive switch；2) 与 `channel_event` 入站 ADT 形态对称——出站 sync 用 `ChannelSendResult`，入站 async 用 `ChannelEvent`，agent 学一套 discriminated union 视角；3) MCP tool error 通道留给真异常（如 args JSON parse 失败、tool impl 抛出未捕获 exception），不被业务 error 污染。

### 与 #161 error variant 的对应

下表把 #161 `DeliveryErrorVariant`（exchange 协议层）映射到 agent 视角的暴露通道，acceptance 第 8 项的扩展形式。

| #161 envelope error variant | agent 暴露通道 | 形态 |
|---|---|---|
| `target_unknown` | 入站 notification.delivery_error | `{ event: "delivery_error", error: "target_unknown", failed_msg_id, human_message }` |
| `unauthorized` (send path) | 入站 notification.delivery_error | 同上，`error: "unauthorized"` |
| `unauthorized` (list_channels path) | tool return | `{ ok: false, error: { kind: "unauthorized", message } }` |
| `mailbox_deregistered` | 入站 notification.delivery_error | 同上，`error: "mailbox_deregistered"` |
| `envelope_invalid` | tool return | `{ ok: false, error: { kind: "envelope_invalid", message } }` |
| `schema_version_incompatible` | tool return | `{ ok: false, error: { kind: "schema_version_incompatible", message } }` |
| `rate_limited` | tool return | `{ ok: false, error: { kind: "rate_limited", message, retry_after_s? } }` |
| `exchange_offline` | tool return（client-side detected） | `{ ok: false, error: { kind: "exchange_offline", message } }` |

为什么 `unauthorized` 双通道：list_channels 是同步 request-response（exchange 在收到 envelope 当场拒），return 给同步调用者最直观；send 的 unauthorized 在 exchange 已经 ack envelope 之后的路由阶段才发现（per-target 队列检查），属于 ## Delivery 语义 异步路径，必须走入站 notification。两侧形态对应同一根因，agent 收到时按通道分别 handle 即可。

---

## Future tools placeholder

下列 tool **不在 MVP 实现范围，仅占位**，用于约束未来扩展时的 schema 形态，避免协议双向漂移。MCP child 在 MVP 阶段**不**注册这些 tool；`tools/list` 也不返回它们。

> 标注：以下所有 tool 均为 `// reserved, not in MVP`。

### `channel.reply_to_delivery`（reserved, not in MVP）

针对一条 inbound 消息发送响应，自动填 `in_reply_to`。

```ts
// design-only, not yet implemented, reserved, not in MVP
interface ChannelReplyToDeliveryParams {
  inbound_msg_id: string;     // 一条 inbound notification 的 envelope_meta.msg_id
  body_kind: string;
  payload: unknown;
}
```

placeholder 形态：等价 `channel.send` + 自动 `in_reply_to = inbound_msg_id` + 自动 `to = inbound.from`。MVP 阶段 agent 可以手动 `channel.send({ to, in_reply_to })` 达到等价效果，不必单出 tool。

### `channel.ack_delivery`（reserved, not in MVP）

向 exchange 显式 ack 已处理的一条 inbound 消息。

```ts
// design-only, not yet implemented, reserved, not in MVP
interface ChannelAckDeliveryParams {
  inbound_msg_id: string;
}
```

placeholder 形态：要求 exchange 端引入 inbox 持久化与 retry 机制；与 #161 前提 (3) 「不留 inbox 不重传」直接冲突——本 tool 仅在用户改动该前提后才上线。

bridge-e2e `claude-code-pr-bridge-e2e` design doc 已经提过同名 `ack_delivery` future tool；此处沿用命名以保持跨 repo 一致。

### `channel.list_inbox`（reserved, not in MVP）

列举当前 mailbox 上尚未 ack 的 inbound 消息。

```ts
// design-only, not yet implemented, reserved, not in MVP
interface ChannelListInboxParams {
  filter?: { from?: ChannelId };
}
```

placeholder 形态：要求 exchange 端 inbox 持久化（同上）；MVP 不实现。命名上避免与 MVP 段的 `channel.list_channels` 混淆——`list_channels` 是 mailbox discovery；本 tool 是 inbound 消息盘点。

### 为何写 placeholder 而非完全略去

forward-compat：tool naming / params 草案在 doc 留底，未来某天用户解禁前提 (3) 时不会出现「同一概念两个命名」的双轨；与 #161 ## Authorization model 段的 future hook 写法同步——把扩展形态写出来但明标不实现。

---

## Tool ↔ exchange RPC 关系

每个 MVP tool 在 MCP child 内的执行路径都遵循「local handler → forward to exchange via #161 wire」单链——MCP child 不做本地 cache / 状态机 / 本地拒绝；它只是 agent 视角到 exchange 视角的 envelope 翻译层。

### 调用栈（`channel.send` 为例）

```
agent (claude)
  │ tool call: channel.send({ to, body_kind, payload, in_reply_to? })
  ▼
MCP child stdio handler
  │ ① 生成 msg_id (ULID)、ts (ISO-8601 UTC)
  │ ② 包成 Envelope<deliver.message>（#161 Envelope ADT）
  │    body = { kind: "deliver.message", payload: { body_kind, payload, reply_to_msg_id: in_reply_to } }
  │ ③ POST /v1/envelope  （#161 ## Delivery 语义 段）
  │    Authorization: Bearer <token>   （fnox channels.exchange.token，#160 / #162）
  ▼
exchange
  │ ④ ts 窗 / schema_version / ULID 校验
  │ ⑤ from 字段 server-stamp 为 MCP child 注册时的 channel-id（#161 Register API）
  │ ⑥ sender capability + sender→target authorization
  │ ⑦ 路由到 target mailbox（#161 ## Delivery 语义 投递路径段）
  │ ⑧ 同步 HTTP 200 = exchange 已受理（不等于 target 已读，见 ChannelSendResult 段）
  ▼
MCP child stdio handler
  │ ⑨ 翻译 HTTP response 为 ChannelSendResult ADT
  │ ⑩ 同步 return 给 agent
```

### 调用栈（`channel.list_channels` 为例）

```
agent (claude)
  │ tool call: channel.list_channels({ filter? })
  ▼
MCP child stdio handler
  │ ① 包成 Envelope<discovery.list_request>（#161 ## Discovery 段）
  │ ② POST /v1/discovery/list
  ▼
exchange
  │ ③ snapshot 当前 mailbox 表，按 filter 应用过滤（filter 全空 = 全列，前提 7）
  │ ④ 返回 Envelope<discovery.list_response>
  ▼
MCP child stdio handler
  │ ⑤ 抽 channels + generated_at → ChannelListResult ADT
  │ ⑥ 同步 return
```

### 调用栈（inbound notification）

```
exchange
  │ ① POST 到 mailbox 注册时声明的 delivery_endpoint（#161 RegisterResponse.delivery_endpoint）
  │    payload = Envelope<deliver.message> 或 Envelope<deliver.error>
  ▼
fulcrum server / MCP child（取决于 mailbox 注册路径，见 #162 心跳归属段双 mailbox 设定）
  │ ② 解析 envelope outer + body
  │ ③ 翻译为 ChannelNotificationParams（## 入站 notification ABI 段映射表）
  │ ④ MCP child 通过 stdio emit `notifications/claude/channel`
  ▼
claude (host) → agent prompt context
```

### 约束

- MCP child 不持本地 mailbox 表副本。`list_channels` 每次都打 exchange——前提 (3) 已锁无持久化，channel 表本身也不应在 child 一侧 cache；snapshot 语义（见 #161 ## Discovery 段「无订阅语义」）由 exchange 唯一负责。
- MCP child 不本地拒绝 tool call。即使 args 看上去违法（如 `to` 是空字符串），也包成 envelope 让 exchange 一侧 `envelope_invalid` 拒——这把单一拒绝点压到 exchange，避免 MCP child 与 exchange 双地校验时双方实现漂移。
- MCP child 不本地重试。`exchange_offline` 一旦同步 detect 即直接 return error；agent 决定是否退避后重发（agent prompting 一侧策略，不在协议层）。

### 跨 issue 形态对齐

- 全部 envelope 形态：归 #161（`docs/design/channel/02-wire-contract.md`）。本 doc 不重写 envelope schema。
- exchange URL / token / mailbox 接入：归 #160（fnox `channels.exchange.*`）+ #162（fulcrum-client 一侧 register / 心跳）。本 doc 不引入新 fnox key。
- agent prompting 一侧消息 ADT（PM ↔ task 用例的 `body_kind` 集合）：归 #164（PM agent 协议层）。本 doc 仅锁 tool ABI schema 形态，不锁应用层 message vocabulary。

---

## 与 #160 / #161 / #162 决议的对齐

- 协议血统：from-scratch（#160 决议）；本 doc 不重新实现协议层，沿用 #161 envelope ADT。
- capability 声明 `experimental: { 'claude/channel': {} }` 与 bridge-e2e `runtime.ts` 同形（#160 协议血统段）。
- 出站 tool 包装 envelope 端点（`/v1/envelope` `/v1/discovery/list`）：100% 沿用 #161；本 doc 仅决定 agent ↔ MCP child 一侧的 tool ABI 形态。
- MCP child = claude subprocess（前提 4）：与 #161 前提 (5) / #162 前提 (5) 一致；本 doc 不重写 lifecycle。
- channel-id 形态（`<mailbox>/task-<id>` / `:mcp` 后缀）：由 #162 ## channel-id 形态 锁定；本 doc 不二次决策。
- 入站 notification method 名 `notifications/claude/channel`：与 bridge-e2e 一致，本 doc 沿用。
- 包归属：本 doc 落地的 tool 实现归 `@agent-channel/mcp` 包（#160 ## 包归属表），fulcrum 通过 `npx -y @agent-channel/mcp@<pinned-semver>` 启动 child（#162 ## flag 注入点 → `claudeBuilder.buildCommand` 拼 `--channels server:"<mcpInvocation>"`）。

## 关联

- Umbrella: #153
- Parent thread: #163
- 直接 unblock: #164（PM agent 协议依赖 tool ABI 表达消息语义）/ 实现 wave
- 协议形态唯一权威: #161（`docs/design/channel/02-wire-contract.md`）
- repo / 部署 / 包归属唯一权威: #160（`docs/design/channel/00-exchange-repo-decision.md`）
- fulcrum-client 一侧 launcher / 注册 / 心跳决策: #162（`docs/design/channel/03-fulcrum-client.md`）
- 协议血统参考: https://github.com/Mouriya-Emma/claude-code-pr-bridge-e2e（`claude-code-pr-channel` 包，capability 与 notification method 形态借鉴）
