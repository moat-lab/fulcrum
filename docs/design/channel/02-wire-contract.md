# Design: Channel exchange 跨边界 wire contract

> Status: **subject-to-relocation** — 本文档随 exchange repo（`agent-channel-exchange`，见 #160）起步后整段挪到该 repo `protocol/` 包旁；fulcrum 仅保留指针式引用。
> Closes thread of: #161（umbrella #153）
> Depends on: #160（`docs/design/channel/00-exchange-repo-decision.md`）
> Blocks: #162（fulcrum client integration）/ #163（MCP tool ABI）/ #164（PM agent protocol）

## 范围

锁定 fulcrum client ↔ exchange ↔ MCP child 三方之间所有跨边界通信的 wire format。本 doc 是 channel 主线的协议核心；后续 #162 / #163 / #164 都基于此。

本 doc 不实现任何代码——所有伪代码 / schema 标 `// design-only, not yet implemented`。本 doc 不预判 #162 / #163 / #164 的内部决策。本 doc 不发明 inbox 持久化 / ack / 重传——这些被用户明确排除。

引用形态：所有 wire schema 用 TypeScript-flavor 伪代码 + ADT 风格 discriminated union 表达；落地 repo 时再决定走 [Arktype](https://arktype.io) / [Zod](https://zod.dev) / `@sinclair/typebox` 中哪一个 schema-as-type runtime（决策点归 exchange repo `@agent-channel/protocol` 包）。

## 用户已锁定的前提（不可推翻）

下列 7 条由用户明确约束，本 doc 必须 cite 进 schema 决策：

1. **Channel = 每个 Claude Code 进程一个 mailbox**。一对一：1 进程 ↔ 1 channel-id ↔ 1 个 `claude/channel` capability 实例。
2. **`from` exchange 投递时盖戳**：agent 自报 `from` 无效，exchange 出场前覆盖；签名链锚在 exchange 私钥而非 client。
3. **不留 inbox 不重传**：消息一经推到 `notifications/claude/channel` 即消失；除非将来加 receipt callback / ack 机制（**不在本 issue 范围**）才考虑保留。
4. **FIFO**：同 `from` 多条消息按到达顺序投递；不同 `from` 之间不要求全局有序。
5. **MCP child = claude 进程的子进程**：用 `claude --channels server:<cmd>` 启动；agent 死 → claude 死 → MCP child 死 → 心跳超时 → exchange 端 mailbox 注销（见 ## Heartbeat 段）。
6. **Authorization 在 exchange 控**：discovery / 投递权限由 exchange 检查，agent / fulcrum 客户端不做权限决议。
7. **Discovery 默认全列**：`list_channels` 返回所有当前活的 mailbox（authorization 由 exchange 在 send 时拒绝越权调用，不在 list 时过滤）。

协议血统：按 #160 决议从 spec 重新实现，仅借鉴 `Mouriya-Emma/claude-code-pr-bridge-e2e` 的 `claude-code-pr-protocol` 包 envelope outer 字段顺序与 HMAC 签名约定；不复用其 PR-event inner schema。

---

## Envelope ADT

跨边界消息统一形态。所有 register / heartbeat / discovery / delivery 流量都以 envelope 为载体；body 内嵌 typed payload。

### 字段集

| 字段 | 类型 | 必选 | 谁盖戳 | 说明 |
|---|---|---|---|---|
| `msg_id` | `string`（ULID） | yes | client 生成 | 全局唯一 ID；用于 `in_reply_to` 关联与日志关联，本身不暗示持久化。 |
| `from` | `ChannelId` | yes | **exchange 服务端盖戳（server-stamped，不可伪造）** | client 提交时可省或填错，exchange 在路由前覆盖为该连接注册时的 mailbox 标识。 |
| `to` | `ChannelId` | yes | client 提供 | 目标 mailbox；exchange 解析失败 → `target_unknown`（见 ## Delivery 语义 + Error Variants 段）。 |
| `in_reply_to` | `string?` | optional | client 提供 | 引用前一条 `msg_id`，无 ack 语义，仅做对话关联标注。 |
| `ts` | `string`（ISO-8601 UTC） | yes | client 提供，exchange 校验 ±5 分钟窗 | 越窗视为 anti-replay 失败 → `envelope_invalid`。 |
| `body` | `EnvelopeBody`（见下） | yes | client 提供 | 带 `kind` 的 discriminated union；inner payload 形态由 kind 决定。 |
| `schema_version` | `string`（semver） | yes | client 提供，exchange 校验 | exchange 拒绝不兼容 major；minor / patch 向后兼容。 |

```ts
// design-only, not yet implemented
type ChannelId = string; // mailbox 标识，形如 "fulcrum-mouriya-laptop/task-42"

interface Envelope<B extends EnvelopeBody> {
  msg_id: string;          // ULID; client-generated
  from: ChannelId;         // server-stamped by exchange (不可伪造); client-supplied value is overwritten
  to: ChannelId;           // client-supplied; resolved by exchange
  in_reply_to?: string;    // optional ULID of a prior msg_id; pure label, no ack
  ts: string;              // ISO-8601 UTC; client-supplied; exchange enforces ±5min anti-replay
  body: B;                 // discriminated union by `body.kind`
  schema_version: string;  // semver; exchange rejects incompatible major
}
```

为什么 `from` 服务端盖戳：

- 客户端自报 `from` 等于自承担鉴权——直接违反前提 (6)「Authorization 在 exchange 控」。
- exchange 在连接握手时即知客户端 mailbox，盖戳成本接近零。
- HMAC 签名只能证明 envelope 完整性，证明不了发件人身份；身份绑定必须由 exchange 在路由层执行。

### body 的 discriminated union

`body` 不是 generic blob，而是 `kind`-tagged ADT。这是协议设计的核心决策点之一：

```ts
// design-only, not yet implemented
type EnvelopeBody =
  | { kind: "register.request"; payload: RegisterRequest }
  | { kind: "register.response"; payload: RegisterResponse }
  | { kind: "heartbeat.ping"; payload: HeartbeatPing }
  | { kind: "heartbeat.pong"; payload: HeartbeatPong }
  | { kind: "discovery.list_request"; payload: ListChannelsRequest }
  | { kind: "discovery.list_response"; payload: ListChannelsResponse }
  | { kind: "deliver.message"; payload: DeliverMessage }
  | { kind: "deliver.error"; payload: DeliverError };
```

**决策：discriminated union over generic blob**。理由：

- generic `body: unknown` 把 schema 责任完全推给 client / agent，违反「protocol 包对接入方零猜测」目标。
- discriminated union 让 exchange / fulcrum client / MCP child 三方都通过 `body.kind` 走 exhaustive switch；编译器可静态枚举所有 wire 形态。
- 后续加 capability 只需扩 `kind` 枚举，旧路径仍 type-safe。

引用 bridge-e2e 经验：`claude-code-pr-protocol` 包的 envelope outer 字段顺序与 anti-replay 时间窗（±5 分钟）直接沿用；inner schema 因 domain 不同（PR-event ≠ mailbox/route）完全重写。

### Wire format

- 默认 **JSON over HTTP/1.1**（exchange `/v1/envelope` 端点；具体 path 细节见 ## Register API / ## Delivery 语义 + Error Variants）。
- 选 JSON 不选 Protobuf / MessagePack 的理由：调试可读 > 编码效率；exchange 流量量级在 10² msg/s 量级，JSON 编解码不是瓶颈；MCP child 与 Claude Code 进程之间已经全 JSON，多一层 binary 反而增加阻抗。
- 后续若 envelope 量级超 10⁴ msg/s 再考虑 ndjson streaming / WebSocket frame；本 doc 不预设。

---

## Register API

mailbox 注册接口。client（fulcrum 或 MCP child 或其它 agent）向 exchange 提交身份与 capability，换取 mailbox 句柄。

### 请求形态

- HTTP `POST /v1/register`
- request body 不走 envelope outer（注册前还没有 mailbox，盖不了 `from`）；直接是 `RegisterRequest`。
- 鉴权走 HTTP `Authorization: Bearer <exchange-token>`（fulcrum 从 fnox `channels.exchange.token` 读，见 #160 部署模型段）。

```ts
// design-only, not yet implemented
interface RegisterRequest {
  schema_version: string;            // 协议 semver
  desired_channel_id?: ChannelId;    // 期望 mailbox 标识；可省，exchange 分配
  capabilities: Capability[];        // 该 mailbox 接受的 body.kind 集合
  identity: {
    agent_kind: "fulcrum-client" | "mcp-child" | "pm-agent" | "worker-agent" | "observer";
    instance_label: string;          // 人类可读，例如 "mouriya-laptop / task-42"
    parent_channel_id?: ChannelId;   // MCP child 时指向其父 fulcrum-client mailbox
  };
  heartbeat_hint?: {
    interval_seconds?: number;       // client 期望的心跳频率；exchange 可拒绝改默认
  };
}

type Capability =
  | "channel.send"          // 该 mailbox 可主动发起 deliver.message
  | "channel.receive"       // 该 mailbox 接受 inbound deliver.message
  | "discovery.list";       // 该 mailbox 可调 list_channels

interface RegisterResponse {
  channel_id: ChannelId;             // exchange 最终分配的 mailbox 标识（可能 = desired 也可能不同）
  registered_at: string;             // ISO-8601 UTC
  heartbeat: {
    interval_seconds: number;        // exchange 强制的心跳频率（默认 30）
    timeout_seconds: number;         // 连续失联视为掉线的窗口（默认 90）
  };
  delivery_endpoint: string;         // 此 mailbox 投递端点（HTTP path 或 SSE channel；具体见 ## Delivery 语义 段）
  schema_version: string;            // exchange 当前协议版本
}
```

### 关键决策

**channel-id 由 exchange 分配，client 可建议但不可强制**。理由：

- 强制 client-chosen 容易让两个 mailbox 抢同一 ID；exchange 端唯一性约束必须有最终话语权。
- 让 client 提 `desired_channel_id` 让 fulcrum 一侧的人类 / agent 在 Settings UI 看到稳定标识，提升可读性。
- 冲突时 exchange 在 ID 后缀附 `#2` / `#3`，并通过 response 告知；不静默改写。

**capability 在注册时声明，不在每条 envelope 重复**。理由：

- 减少 envelope 体积。
- exchange 路由 inbound `deliver.message` 时只查 mailbox 表，不需要在 envelope 重新解析能力位。
- capability 变更必须重新注册（断旧 mailbox / 重建新 mailbox），避免运行时半状态。

**Failure 形态**：注册失败直接 HTTP 4xx + JSON `{ "error": "<variant>", "message": "<human>" }`，不发 envelope。error variant 见 ## Delivery 语义 + Error Variants 段。

---

## Heartbeat

mailbox 存活检测。MCP child = claude 进程的子进程，claude 死 → MCP child 死 → 心跳超时 → exchange 端 mailbox 注销，所以心跳是 lifecycle 锚点而非可有可无的健康检查。本段把协议三要素（频率 / 超时 / 处置）拆成三个独立小节，逐项锁定。

```ts
// design-only, not yet implemented
interface HeartbeatPing {
  channel_id: ChannelId;             // 必须等于注册时 exchange 分配的；不等则 envelope_invalid
  sequence: number;                  // client 单调递增计数；exchange 检测乱序但不强制 FIFO 拒绝
}

interface HeartbeatPong {
  server_ts: string;                 // ISO-8601 UTC
  next_expected_in_seconds: number;  // = interval_seconds；client 据此排定下次 ping
}
```

## Heartbeat 频率（interval）

默认 `interval_seconds = 30`。client 在注册时可建议（`heartbeat_hint.interval_seconds`），exchange 取 max(client_hint, server_floor=10) 防 DoS；server_floor 不可低于 10s。

为什么不让 client 自由选 interval：

- 太低：放大 exchange 端 QPS；agent 数量上去后 noisy。
- 太高：失联检测窗变长，前提 (5)「MCP child 死 → 心跳超时 → mailbox 注销」的语义滞后明显。
- 30s 是 bridge-e2e 同等量级服务的常见基线；fulcrum 实例数 < 50 时无压力。

## Heartbeat 超时（timeout）

默认 `timeout_seconds = 90` = 3 × interval。连续 3 次心跳缺失即视为掉线，无 grace period。

为什么取 3-miss：

- 1-miss 容忍度太低，网络抖动一次就被 deregister，client 频繁重 register 反而污染 mailbox 表。
- 3-miss 是「真断了」与「偶发抖」的常见分界；继承 bridge-e2e 的 anti-replay 窗（±5min）旁的工程经验。
- 超时不分级——「软超时 60s」「硬超时 90s」会增加状态机分支；至简方案是单阈值 deregister。

## Heartbeat 失联处置（deregister）

超时即 deregister mailbox——立即注销，不留 grace period，不留 mailbox 等重连。

理由：

- 前提 (3)「不留 inbox 不重传」已锁死无持久化；留空 mailbox 反而误导 sender 以为目标在线。
- client 真要重连就重新走 `POST /v1/register`，得到新 channel-id（或同 desired ID）。
- 前提 (5) 锁定 MCP child lifecycle 与 claude 进程绑定；claude 重启 → 新进程 → 新 mailbox 合理。

Lifecycle 处置矩阵：

| 触发 | exchange 动作 | client 期望反应 |
|---|---|---|
| 心跳 1 次缺失（30-60s 内） | 记录 warning；不动 mailbox | 无 |
| 心跳 连续 3 次缺失（>90s 即 timeout） | mailbox deregister；后续指向该 mailbox 的 inbound `deliver.message` 走 `mailbox_deregistered` error variant | client 若仍存活，需重新走 `/v1/register` |
| client 主动断开（HTTP close / `POST /v1/deregister`） | 立即 deregister mailbox | 无 |
| exchange 重启 | 所有 mailbox 失效；client 心跳下一次失败时重 register | 重 register；channel-id 可能改变 |

**`POST /v1/deregister`** 是显式注销端点（不是 envelope kind）；用于 fulcrum 关闭时礼貌注销，不依赖心跳超时。

### 为什么不留 mailbox

bridge-e2e 在 PR-event 域留持久化是因为 GitHub webhook 重试模型要求。本 exchange 域：

- 前提 (3) 已锁死 at-most-once 投递；留 mailbox 但不留 inbox 没意义。
- 前提 (5) 锁定 MCP child lifecycle 与 claude 进程绑定；claude 重启 → 新进程 → 新 mailbox 合理。
- 留 mailbox 增加运维复杂度（要写 GC、TTL、状态机），换不到协议表达力。

---

## Discovery

`list_channels` 接口。前提 (7) 锁死「默认全列」，本段实例化默认策略并给出可扩展 hook。

### 请求形态

- HTTP `POST /v1/discovery/list` 走 envelope（`body.kind = "discovery.list_request"`）。
- 仅持 `discovery.list` capability 的 mailbox 可调；否则 exchange 返回 `unauthorized` envelope（见 ## Delivery 语义 + Error Variants）。

```ts
// design-only, not yet implemented
interface ListChannelsRequest {
  filter?: {
    agent_kind?: Array<"fulcrum-client" | "mcp-child" | "pm-agent" | "worker-agent" | "observer">;
    capability?: Capability[];       // 仅返回 capabilities 是该集合超集的 mailbox
    label_glob?: string;             // 对 instance_label 做 glob 匹配（exchange 端解析，不下放给 client）
  };
  // 默认（filter 全空）= 全列；前提 (7) 默认全列由此实例化。
}

interface ListChannelsResponse {
  channels: ChannelDescriptor[];
  generated_at: string;              // ISO-8601 UTC；snapshot 时刻，无订阅语义
}

interface ChannelDescriptor {
  channel_id: ChannelId;
  agent_kind: string;
  instance_label: string;
  capabilities: Capability[];
  registered_at: string;
  parent_channel_id?: ChannelId;     // MCP child 暴露其父 fulcrum-client mailbox
}
```

### 关键决策

**默认全列（前提 (7)），授权拦截在 send**。理由：

- discovery 列表是「我能给谁发」的发现机制，不是权限审查机制；让 list_channels 静默过滤会让 sender 以为「目标不存在」，实际是「目标存在但你无权」——这是难调试的语义陷阱。
- exchange 在 `deliver.message` 路由时用 `unauthorized` error variant 显式拒绝越权调用，sender 能立刻分清「目标不存在」与「无权送达」。

**不订阅 / 不推送变更**：response 是 snapshot；client 想跟踪变更就轮询。理由：实现复杂度低；当前 mailbox 量级远不到需要 push diff 的规模；推送形态等到 #163 inbound notification ABI 落地时再统一加。

**反向追踪父 mailbox**：MCP child 的 `ChannelDescriptor` 通过 `parent_channel_id` 指回其父 fulcrum-client mailbox。理由：fulcrum 一侧的人类用户在 list 出来一堆 MCP child 时能立刻看出归属，调试体验远好于全平摊。

---

## Delivery 语义 + Error Variants

主链路：sender 通过 envelope 把 `deliver.message` 投递到 exchange，exchange 路由到 target mailbox 的 `notifications/claude/channel` 通道。

### 投递路径

```
sender (fulcrum-client / MCP child / pm-agent / ...)
  │
  │  POST /v1/envelope    (Envelope<deliver.message>)
  │  ─ Authorization: Bearer <token>
  │  ─ from 字段被 exchange 在路由前覆盖（server-stamped）
  ▼
exchange
  │
  │  ① 校验 envelope（schema_version 兼容；ts ±5min；ULID 合法）
  │  ② 解析 to → 查 mailbox 表
  │  ③ 检查 sender capability + sender→target authorization
  │  ④ 路由到 target mailbox 的 outbound 通道（HTTP-push 或 SSE，target 注册时声明）
  │  ⑤ 不留 inbox：投递动作完成即丢弃 envelope（前提 3）
  │
  ▼
target mailbox
  │
  │  接收方按 sender FIFO 看到 envelope（前提 4：同 `from` 顺序保留）
  ▼
claude/channel notification → Claude Code agent
```

### 投递语义

- **At-most-once**：前提 (3) 锁死，不重传。
- **FIFO per sender**：前提 (4) 锁死，同 `from` 严格按到达顺序投递；不同 `from` 间无序保证。
- **并发投递不阻塞**：多个 sender 同时发往同一 target，exchange 端用 per-target 单消费者队列保证 FIFO；不同 sender 不互相阻塞。
- **目标 mailbox 注销时的 inflight envelope**：直接丢弃，返回 `mailbox_deregistered` 给 sender 一侧（envelope kind = `deliver.error`）。

```ts
// design-only, not yet implemented
interface DeliverMessage {
  body_kind: string;        // 应用层 payload kind，例如 "agent.task.assign" / "agent.reply.text"
  payload: unknown;         // 应用层 payload；schema 归 #163 (MCP tool ABI) / #164 (PM agent) 决定
  reply_to_msg_id?: string; // 等价 envelope.in_reply_to；冗余字段方便 application code 读
}

interface DeliverError {
  error: DeliveryErrorVariant;
  failed_msg_id: string;
  human_message: string;
}

type DeliveryErrorVariant =
  | "target_unknown"
  | "unauthorized"
  | "exchange_offline"
  | "envelope_invalid"
  | "mailbox_deregistered"
  | "schema_version_incompatible"
  | "rate_limited";
```

### Error Variants

至少 5 种具名 error，全部 backquoted ID 形态以便 sender 一侧 exhaustive switch：

- `target_unknown` —— `to` 字段解析不到任何活 mailbox（可能从未注册，可能已超时注销）。sender 看到时应停止重试；exchange 不会自动恢复。
- `unauthorized` —— sender 的 capability 不含 `channel.send`，或 sender→target 的 authorization policy 拒绝（见 ## Authorization model 段）。
- `exchange_offline` —— sender 一侧的 HTTP 调用直接连不到 exchange；本 variant 由 sender 一侧的 client SDK 抛出，不是 exchange 返回的 envelope。client 期望走 retry-with-backoff。
- `envelope_invalid` —— schema 字段缺失、`ts` 越 ±5min 窗、`msg_id` 不是合法 ULID、`schema_version` 解析失败、`channel_id` 格式非法。sender 应视为 bug，不重试。
- `mailbox_deregistered` —— target mailbox 在投递路径上被注销（心跳超时 / 主动 deregister / exchange 重启）。sender 一侧应丢弃该会话，重新走 discovery。
- `schema_version_incompatible` —— exchange 拒绝 major 版本不兼容的 envelope。
- `rate_limited` —— sender 触发 per-sender QPS 上限；human_message 中带退避建议。

每条 error 通过 envelope `body.kind = "deliver.error"` 回送到 sender mailbox（FIFO 与 deliver.message 同链路），sender 一侧用 `in_reply_to` 关联到原 `failed_msg_id`。

**为什么 error 走 envelope 而非 HTTP 状态码**：

- HTTP 4xx/5xx 只能反馈「发送瞬间」的状态；mailbox_deregistered 这种「路由路径上失败」必须异步回送，HTTP 已经返回 200 了。
- 统一 envelope 通道让 sender 一侧的 SDK 只写一套 inbound handler，不需要双解析路径。
- HTTP 状态码留给 Register API 这种「同步且 envelope 还没建立」的接口。

---

## Authorization model

前提 (6) 锁死「authorization 决策点在 exchange」。本段实例化 baseline 策略，并给出 future hook。

### Baseline 策略

所有已注册 mailbox 默认互通（mutual-send-all）：

- sender 持 `channel.send` capability + target 持 `channel.receive` capability → exchange 允许投递。
- discovery 列表前提 (7) 锁死默认全列，配合上面 baseline 形成「能看就能发」语义。
- exchange-token 是粗粒度准入证（持有 token = 可注册 mailbox = 可参与协议）；细粒度 sender→target 拒绝由 ACL hook 在 baseline 之上叠加。

```ts
// design-only, not yet implemented
type AuthorizationDecision =
  | { decision: "allow" }
  | { decision: "deny"; reason: string };

// Baseline:
function authorize(sender: ChannelDescriptor, target: ChannelDescriptor): AuthorizationDecision {
  if (!sender.capabilities.includes("channel.send")) return { decision: "deny", reason: "sender lacks channel.send" };
  if (!target.capabilities.includes("channel.receive")) return { decision: "deny", reason: "target lacks channel.receive" };
  return { decision: "allow" };
}
```

### Future hooks（不在本 issue 范围）

下列 hook 写出来仅为约束 exchange repo 后续设计，不在 #161 落地：

- **ACL 表**：exchange 持 `(sender_kind, target_kind) → allow/deny` 表；hot reload。
- **identity 凭证升级**：注册时 token 之外再走 OIDC / mTLS；agent_kind 由凭证保证而非 client 自报。
- **per-target 黑名单**：target mailbox 注册时可声明 `block_senders: ChannelId[]`；exchange 路由时拦截。

所有 future hook 都不影响本 doc 锁定的 envelope / register / heartbeat / discovery / delivery 形态——这正是把 authorization 决策点压到 exchange 一侧的目的：策略可换，wire contract 不动。

---

## 与 #160 决议的对齐

- 协议血统：从 spec 重新实现，参考 `claude-code-pr-protocol` envelope outer 形态——本 doc 已对齐。
- 部署模型：fulcrum ↔ exchange 走 HTTP；`POST /v1/register` `POST /v1/envelope` `POST /v1/discovery/list` 三组端点全部 HTTP——已对齐。
- 4 包 monorepo（`protocol` / `exchange` / `mcp` / `fixtures`）：本 doc 的 ADT schema 落地为 `@agent-channel/protocol` 包的 TypeScript 类型 + JSON Schema；`@agent-channel/exchange` 实现 server；`@agent-channel/mcp` 实现 fulcrum 一侧 MCP child—— wire contract 锁定后即可分包并行落地。
- 寻址契约：`channels.exchange.url` / `.token` / `.mailbox` 仍是 fulcrum 一侧的 fnox 唯一接入点；本 doc 不引入新 fnox key。

## 关联

- Umbrella: #153
- Parent thread: #160
- 直接 unblock: #162（fulcrum client integration）/ #163（MCP tool ABI）/ #164（PM agent protocol）
- 协议血统参考: https://github.com/Mouriya-Emma/claude-code-pr-bridge-e2e（`claude-code-pr-protocol` 包，仅 envelope outer 形态借鉴）
