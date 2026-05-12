# Design: fulcrum client integration（launcher 改造 / 注册 / 心跳 / channel-id 与 task 映射）

> Status: **subject-to-relocation** — 本文档随 exchange repo（`agent-channel-exchange`，见 #160）起步后，fulcrum 一侧仅保留 launcher 决策；exchange protocol 引用部分挪到 exchange repo 对应 doc。
> Closes thread of: #162（umbrella #153）
> Depends on: #160（`docs/design/channel/00-exchange-repo-decision.md`）/ #161（`docs/design/channel/02-wire-contract.md`）
> Blocks: #163（MCP tool ABI）/ 后续实现 wave

## 范围

锁定 fulcrum 作为 exchange client 的所有 launcher / 寻址 / lifecycle 决策：怎么改 task launcher 在 spawn Claude Code 时挂上 channel MCP child；channel-id 如何分配 / 存储 / 与 task / process 关联；注册时序；心跳归属；fulcrum server 重启后 channel 恢复语义；以及前端 settings 全局开关位置。本 doc 只做设计——所有伪代码 / config key 标 `// design-only, not yet implemented`，不动 settings schema 字段名。

本 doc 不发明 envelope schema（同 #161），不预判 MCP tool ABI（同 #163）。

## fulcrum 现状（前提）

下列调研结论本 doc 必须 cite；每一项都对应仓内实际文件 / 行号 / symbol（具体见各决策段引用）：

1. **server 不 spawn agent**：`claude ...` 命令字符串由 frontend `frontend/components/terminal/task-terminal.tsx` 的 `buildAndSendAgentCommand`（L421-L495）通过 `frontend/lib/agent-commands.ts` 的 `claudeBuilder`（L41-L66）拼好，写进 dtach stdin，shell fork+exec。
2. **task ↔ terminal 无外键**：靠 `worktreePath === cwd` 字符串相等匹配（`server/terminal/pty-instance.ts` L33-L46 `killClaudeInTerminalsForWorktree`），task 不存 PID / session-id。
3. **杀 agent = cmdline 正则 scan**：`AGENT_PATTERN = /(^|\/)(claude|opencode)(\s|\0|$)/i`（`server/terminal/dtach-service.ts:59`），DONE/CANCELED 触发 `killClaudeInTerminalsForWorktree`（`server/services/task-status.ts:302-311`），SIGKILL 整棵进程树。
4. **server 重启不杀 agent**：SIGINT/SIGTERM 走 `ptyManager.detachAll()`（`server/terminal/pty-manager.ts:485-489`），只断 PTY 本地连接，dtach session + shell + claude + claude 的所有子进程全留活；`restoreFromDatabase()`（`server/terminal/pty-manager.ts:31`）启动时重连。
5. **MCP child = claude 进程的子进程**（用户锁定前提，与 #161 前提 (5) 一致）：MCP child 由 `claude --channels server:<cmd>` 在 claude 进程内 fork-exec 起来；**父进程（claude）死，MCP child 跟着死**——agent 死 → claude 死 → MCP child 死 → 心跳超时 → exchange 端 mailbox 注销。fulcrum 不显式管 MCP child 进程。

---

## flag 注入点

- 候选 1: `frontend/lib/agent-commands.ts` 的 `claudeBuilder.buildCommand`（L42-L58）—— 在命令串拼接处拼上 `--channels server:<cmd>`
- 候选 2: `frontend/components/terminal/task-terminal.tsx` 的 `buildAndSendAgentCommand`（L421-L495）—— 在 `buildAgentCommand(...)` 返回后做后处理追加
- 候选 3: `server/terminal/terminal-session.ts` 的 `start()` env 块（L121-L143）—— 走环境变量让 claude 自检并自挂

trade-off：

- 候选 2（task-terminal.tsx 后处理）会把 channel 注入逻辑散在 `buildAgentCommand` 之外，违反 `agent-commands.ts` 是「agent CLI 形态唯一权威」的现有抽象边界——OpenCode 接 channel 时会重复一遍。
- 候选 3（env 块）需要 Claude Code 一侧主动检测某个新 env 并改造其启动逻辑——超出 fulcrum 一侧可控范围；且 dtach session env 在 PTY 落地之后才生效，与 channel 需要在 agent 起步时就建立的语义不匹配。再者，channel 命令本身可能要带 token / mailbox 等敏感参数，env 块要 propagate 到 dtach 一棵进程树里反而扩散面更大。
- 候选 1（`claudeBuilder.buildCommand`）正是 agent CLI flag 的现有归属点：`--dangerously-skip-permissions` / `--append-system-prompt` / `--permission-mode plan` 这类 flag 都在此拼接；channel 是 agent CLI 一等参数，归属一致。OpenCode 接 channel 时也走对应 builder 的 buildCommand。

- 选定: 候选 1，在 `claudeBuilder.buildCommand` 内拼 `--channels server:<cmd>`，并新增 `channel?: ChannelLaunchSpec` 字段到 `AgentCommandOptions`。
- 理由: 1) 与现有「agent CLI flag 集中点」抽象对齐；2) OpenCode 接入只需扩同一接口；3) 命令串在拼接处可读、可调试，写出来的命令直接 paste 到 shell 复现；4) channel 关闭时（见 ## 全局开关 段）`channel === undefined`，buildCommand 不拼 flag，旧路径零回归。

伪代码（仅 design-only，命名建议，不签字）：

```ts
// design-only, not yet implemented
interface ChannelLaunchSpec {
  mcpInvocation: string;     // 例如 "npx -y @agent-channel/mcp@^0.3"
  channelId: string;         // exchange 分配；见 ## channel-id 形态
  exchangeUrl: string;       // fnox channels.exchange.url
  // token 不进命令行；MCP child 自行从环境读 fnox 一致密钥
}

interface AgentCommandOptions {
  prompt: string;
  systemPrompt: string;
  mode: 'default' | 'plan';
  additionalOptions: Record<string, string>;
  channel?: ChannelLaunchSpec;       // 新增字段
  // ... 其余字段不变
}
```

---

## channel-id 形态

- 候选 1: UUID v4，frontend 生成
- 候选 2: task-id 派生（如 `fulcrum-<instance>/task-<taskId>`）
- 候选 3: Claude session-id 复用（agent 起步后回填）

trade-off：

- 候选 1（UUID v4）：debug 友好性差——一串无意义十六进制无法在 Settings UI / list_channels 里肉眼分辨归属，违反 #161 ChannelDescriptor 的 `instance_label` 可读目标；且 UUID 在 client 端单独生成易与 exchange 端唯一性冲突，需要 reconcile 路径。
- 候选 3（Claude session-id 复用）：channel 必须在 agent 起步之前就拼到命令行里（见 ## flag 注入点），而 session-id 是 agent 起步后才存在的——时序倒置；且 Claude session 可能因为 agent 内部 reset / context-rotation 改变，channel-id 跟着漂会让 mailbox 表过早 GC。
- 候选 2（task-id 派生）：与 fulcrum 现有「task 是用户视角的工作单元」概念一致；list_channels 里直接看到 `fulcrum-mouriya-laptop/task-42` 形态，肉眼能定位；与 #161 RegisterResponse 的 `desired_channel_id` 字段直接对齐。

- 选定: 候选 2 — 形态 `<channels.exchange.mailbox>/task-<taskId>`，由 frontend 在拼 `--channels` flag 时生成，作为 `desired_channel_id` 提给 exchange；exchange 端冲突时附后缀（见 #161 Register API 段「冲突时 exchange 在 ID 后缀附 `#2` / `#3`」）。
- 理由: 1) 可读性高，list_channels / Settings UI 一眼能定位；2) 与 fnox `channels.exchange.mailbox` 形成 `<instance>/<scope>` 二层命名空间；3) MCP child（claude 进程的子进程）注册时用同形态 + `:mcp` 后缀（如 `fulcrum-mouriya-laptop/task-42:mcp`），通过 `parent_channel_id` 在 #161 ChannelDescriptor 里指回父；4) 一个 task 一个 channel-id 与「1 进程 ↔ 1 channel-id」前提（#161 前提 (1)）一致；task 重开（worktree 重 attach 同 task）走显式 `/v1/register` 拿新 channel-id，不复用历史 mailbox。

manual task / scratch task 一致原则：

- 候选 1: 无 task-id 形态走 UUID 兜底
- 候选 2: manual / scratch 也走 `terminal-<terminalId>` 形态
- 选定（子决策）: 候选 2，统一走 `<mailbox>/<scope>` 形态，scope 段在 task / scratch / manual 三种类型下分别为 `task-<id>` / `scratch-<id>` / `term-<id>`，全部由 frontend 在 buildCommand 调用前拼定。
- 理由（子决策）: 单一命名约定降低 list_channels / 调试时的认知负担；不引入第二种 ID 生成路径。

---

## 三元映射

「channel ↔ task ↔ process（terminal）」三元在 fulcrum 一侧的存储位置。

- 候选 1: 新建 `channels` 表（独立 schema）
- 候选 2: 扩展现有 `terminals` 表加 `channelId` 列
- 候选 3: 纯内存（PTYManager 一层 Map）

trade-off：

- 候选 1（新表）：当前阶段映射就是「terminal.id → channelId / mailbox / registeredAt」三五个字段，单独成表会增加 migration / FK 维护负担，且与 terminals 生命周期同步性差（terminal 删除时 channels 行得手动级联）。
- 候选 3（纯内存）：fulcrum server 重启时映射全丢；与 ## server 重启恢复 段决策冲突（重启后 dtach session 内的 claude 仍活、MCP child 仍连 exchange，server 一侧若失去映射就无法 reconcile）。
- 候选 2（扩 `terminals`）：terminal 本就是 channel 物理宿主（claude 进程跑在 terminal 的 dtach session 里），加 `channelId` 列让映射跟随 terminal lifecycle；server 重启后 `restoreFromDatabase()` 自然把 channelId 一起捞回。

- 候选 1（备选）：若后续 channel-id 与 terminal 出现多对多（一个 terminal 装多 agent），再迁到独立表
- 选定: 候选 2 — 在 `server/db/schema.ts` 的 `terminals` 表加 `channelId: text('channel_id')`（nullable）一列；映射等价为「terminal.id ↔ terminal.channelId」单方向 FK 到 exchange 一侧的 mailbox 标识。
- 理由: 1) terminal 是 channel 唯一物理宿主，存同一张表表达力最直白；2) `restoreFromDatabase()` 自动覆盖 server 重启场景，无需新增持久化路径；3) 当前用例下「一 terminal 一 channel」与 #161 前提 (1) 锁死「1 进程 ↔ 1 channel-id」对齐；4) task ↔ terminal 在现有 fulcrum 仍走 `worktreePath === cwd` 字符串匹配（前提 2），channel-id 不破坏这条；channel-id ↔ task 的反向查询经 terminal 中转。

新列建议（design-only，命名建议，不签字）：

```ts
// design-only, not yet implemented
// server/db/schema.ts terminals 表 additions
{
  channelId: text('channel_id'),                    // exchange 分配的 mailbox 标识；null = 未启用 channel
  channelRegisteredAt: text('channel_registered_at') // ISO-8601；null = 未注册或注册失败
}
```

后续若 channel 与 terminal 出现多对多（场景假设：一个长跑 terminal 串多个 agent session），再迁出独立 `channels` 表；当前阶段不预先抽象。

---

## 注册时序

frontend 拼 `--channels` flag 之后，channel-id 何时变成 exchange 一侧的活 mailbox。

- 候选 1: frontend 在写命令到 dtach 之前先调 `POST /api/channels/register`（fulcrum server）→ fulcrum server 代理 `POST /v1/register`（exchange）→ exchange 返回 channel-id → frontend 再拼到 `--channels` flag
- 候选 2: MCP child 起来后 self-register（agent 进程内）
- 候选 3: 等 shell prompt 出现后 frontend 触发 register
- 候选 4: 命令写进 dtach 后由 MCP child 自跑 register；fulcrum server 只在收到 register 成功事件后回填 `terminals.channelId`

trade-off：

- 候选 2（MCP child self-register）：MCP child 是 claude 的子进程，agent 起步后才有 process；register 在 agent 起步前先做才能确保 channel-id 已经分配；让 MCP child 自己 register 会要 agent 起步流程感知 channel 失败回退，过度耦合。
- 候选 3（等 shell prompt）：在 dtach `start()` 之后 `attach()` 之间有一个 polling 窗（见 `terminal-session.ts:181-194` `MAX_ATTEMPTS = 10` 的 socket 等待循环）；channel register 卡在这条 polling 路径上会让 agent 起步可观察的延迟变大；且 shell prompt 出现时机不稳定（startupScript 可能跑数秒）。
- 候选 4（命令写进 dtach 后 MCP child 自跑 register）：channel-id 必须在拼 `--channels` flag 时就已确定（前置依赖），晚到导致 flag 拼不上；这等于退化成候选 2 的子情况。
- 候选 1（pre-register 后再拼 flag）：register 是同步 HTTP，时序明确——register 成功 → 拿到 channel-id → 拼 flag → 写 dtach；失败路径在 register 阶段一次性拒绝（弹 toast 走 retry-with-backoff），不污染 agent 起步流程。

- 选定: 候选 1 — frontend `buildAndSendAgentCommand`（task-terminal.tsx L421）开头先调 fulcrum server 一个新 endpoint `POST /api/channels/register`，参数携带 `{ desired_channel_id, capabilities, identity }`（形态见 #161 RegisterRequest）；server 一侧代理到 exchange `POST /v1/register`，回填 `terminals.channelId` 后返回；frontend 拿到 channel-id 后再走 `buildAgentCommand(...)`。
- 理由: 1) 时序线性：register 成功才有 channel-id，channel-id 是 `--channels` flag 的前置；2) 失败路径单点处理（register 阶段 4xx 时弹 toast、走 ## 全局开关 段定义的 fallback：当 channel 关闭或 register 持续失败时，命令退化为不带 `--channels` 的旧形态）；3) fulcrum server 代理避免 frontend 直接持有 exchange token——token 留 server 一侧 fnox；4) `terminals.channelId` 的写入与 terminal 行的创建同事务（terminal 创建在 register 成功后，否则 terminal.channelId 一直 null）。

register endpoint 责任划分：

- frontend → fulcrum server: 只传 task / terminal 上下文 + desired channel-id；不传 token
- fulcrum server → exchange: 走 fnox `channels.exchange.url` + Bearer `channels.exchange.token`；envelope 形态归 #161
- fulcrum server → frontend: 返回 `{ channelId, registeredAt, heartbeat }`；frontend 据此走 ## flag 注入点 的拼接

MCP child register：MCP child 起来后另起一次注册（`agent_kind: "mcp-child"`，`parent_channel_id` 指回 fulcrum-client mailbox）；这条由 MCP 包内部完成，fulcrum 仓不持有该逻辑（前提 5 + #161 RegisterRequest.identity 已锁定）。

---

## 心跳归属

mailbox 存活探测由谁发，是否双方各发。前提 (5) 锁死「MCP child = claude 子进程，agent 死 → claude 死 → MCP child 死 → 心跳超时 → mailbox 注销」，本段决定 fulcrum 一侧是否还要单独发一条心跳。

- 候选 1: MCP child 单独跑心跳（fulcrum server 完全不发）
- 候选 2: fulcrum server 代发心跳（MCP child 不发）
- 候选 3: 双方各发不同维度（MCP child 跑 channel.mcp-child 心跳；fulcrum server 跑 channel.fulcrum-client 心跳）

trade-off：

- 候选 2（fulcrum server 代发）：违反前提 (5) 的 lifecycle 锚点意图——如果 fulcrum server 替 MCP child 心跳，那么 agent 死了 MCP child 也死了，但 fulcrum server 还在替它发心跳，exchange 看不到失联——mailbox 就长期僵尸。这是「fulcrum 不显式管 channel 进程」一条的反例。
- 候选 1（仅 MCP child 心跳）：MCP child 死则心跳断，exchange 90s timeout 自动 deregister；但 fulcrum-client mailbox（fulcrum server 自己注册的那个）由谁心跳？fulcrum server 自身也是 exchange client（要 list_channels / send 出站），它的 mailbox 也得活——这条 mailbox 必须由 fulcrum server 自己心跳。
- 候选 3（双方各发不同维度）：MCP child 心跳 = agent 进程存活探测（agent 死则 MCP child 死则心跳停 → 见 #161 心跳归属 → 「父进程死，MCP child 跟着死」即此 deregister 触发器）；fulcrum server 心跳 = fulcrum-client mailbox 存活探测（fulcrum server 死则 fulcrum-client mailbox 心跳停）。两条心跳各自对应一个 mailbox，互不替代。

- 选定: 候选 3 — 双心跳。MCP child mailbox 心跳由 MCP child 跑（不在 fulcrum 仓范围）；fulcrum-client mailbox（fulcrum server 一侧的注册结果）心跳由 fulcrum server 在 `server/services/` 下新增一个 `channel-heartbeat-service.ts` 跑独立 interval 计时器，按 #161 Heartbeat 段定义的 `interval_seconds`（默认 30s）发 `body.kind = "heartbeat.ping"` envelope。
- 理由: 1) 每个 mailbox 一个独立心跳来源，前提 (5) 的 lifecycle 锚点在 MCP child 侧自洽（agent 死 → claude 死 → MCP child 死 → exchange 看到失联）；2) fulcrum-client mailbox 与 fulcrum server lifecycle 绑定，自心跳合理；3) 不依赖 MCP child 反向通知 fulcrum server——MCP child 与 fulcrum server 之间没有控制通道（fulcrum 不显式管 MCP child）；4) heartbeat 协议形态完全来自 #161（HeartbeatPing/HeartbeatPong），fulcrum 不重写。

failure 处置：fulcrum 一侧心跳连续 3 次失败（与 #161 默认 timeout=90s 对齐）：

- fulcrum-client mailbox 视为掉线 → `channel-heartbeat-service` 调 `POST /v1/register` 重 register；新 channel-id 通过事件回填 `terminals.channelId`（如果有 terminal 关联）。
- 该 fulcrum-client mailbox 上挂的 MCP child mailbox 不被 fulcrum 主动 deregister——它有自己的心跳路径；fulcrum 重 register 不影响 child。

---

## server 重启恢复

fulcrum server 重启后 channel 状态如何恢复。

前提 (4) 锁定：SIGINT/SIGTERM 走 `ptyManager.detachAll()`（`server/terminal/pty-manager.ts:485-489`），只断 PTY 本地连接，dtach session + shell + claude + MCP child 全留活；`restoreFromDatabase()`（`server/terminal/pty-manager.ts:31`）启动时把 terminals 表里的 session 重新 attach。

- 候选 1: 重启时清空 `terminals.channelId`，所有 channel-id 视为失效；用户/agent 必须手动重起
- 候选 2: 重启时调用 reconcile：对每条 `terminals.channelId` 非空的 row 调 `POST /v1/register` 重 register，拿到新 channel-id 后回填
- 候选 3: 重启时调用 reconcile：先调 exchange 一个 `POST /v1/discovery/list`（#161 Discovery 段）拿当前活 mailbox 集，与本地 `terminals.channelId` 取交集；交集内的复用，差集（本地有 exchange 无）走重 register，差集（exchange 有本地无）忽略

trade-off：

- 候选 1（清空）：浪费已经活着的 MCP child（它在 dtach 里继续连 exchange，但 fulcrum server 一侧映射没了，list_channels 拿不到）——用户视角看到「channel UI 一片空但 agent 还在跑」，体验破裂。
- 候选 3（discovery + 交集 reconcile）：discovery 是 snapshot（#161 ListChannelsResponse 段：「无订阅语义」），server 重启刚好这一瞬可能落在 MCP child 心跳间隙——交集结果有 race；且当前阶段一个 fulcrum 实例的 mailbox 数 < 50，discovery 优化收益低，单做 register 重连一次即可校准。
- 候选 2（重 register reconcile）：对每条非空 `channelId` 调一次 `POST /v1/register`（`desired_channel_id` 传旧值）；如果 exchange 一侧该 mailbox 仍活（自己还没 timeout），exchange 返回同 channel-id（idempotent）；如果已 deregister，exchange 分配新 channel-id 并附冲突后缀。本地按 response 回填即可，无需 discovery。

- 选定: 候选 2 — `restoreFromDatabase()` 完成后，新增一个 `restoreChannelsFromDatabase()` 路径：扫 `terminals.channelId` 非空的 row，对每条调 `channel-heartbeat-service` 的 `reRegister(channelId)`，再发一次 heartbeat 确认；MCP child mailbox（由 MCP 包内部心跳）不在 fulcrum reconcile 范围。
- 理由: 1) `ptyManager.detachAll` + `restoreFromDatabase` 已经是 fulcrum 重启恢复语义的成熟路径——channel 跟着 terminals 一条复用，不另写一套；2) MCP child 是 claude 进程的子进程，claude 在重启过程中没死，所以 MCP child 也没死、心跳没断、mailbox 也没 deregister——重启窗 < 90s 时几乎所有 MCP mailbox 都活；3) fulcrum-client mailbox 在 fulcrum server 进程死的瞬间心跳就停了，exchange 在 90s 内 deregister，需要 reconcile 时 register；候选 2 直接覆盖这条；4) reconcile 失败不阻塞 server 启动——`restoreFromDatabase` 是 best-effort，channel 同样 best-effort（失败的 row 留 `channelId` 不变，下次 heartbeat tick 再重试）。

reconcile 时序：

```
SIGTERM → ptyManager.detachAll()  ← (server/terminal/pty-manager.ts:485-489)
fulcrum server 进程退出
fulcrum server 进程重启
PTYManager 启动 → restoreFromDatabase() ← (server/terminal/pty-manager.ts:31)
                  ↓
                  restoreChannelsFromDatabase()  // design-only, not yet implemented
                  ↓
                  对每条 terminals.channelId 非空 → reRegister(channelId) → 回填
                  ↓
                  channel-heartbeat-service.start()
```

---

## 全局开关

channel 整体功能在 fulcrum settings 的归属位置、默认值、override 维度。

- 候选 1: settings → AI（agent 配置同级）
- 候选 2: settings → Email & Messaging（与现有 WhatsApp/Discord/Telegram/Slack/Email/Mattermost 同级）
- 候选 3: settings → General（基础开关）
- 候选 4: 不开 UI 开关，仅 fnox `channels.exchange.enabled` plain key

trade-off：

- 候选 2（Email & Messaging）：现有 `channels.*` 命名空间已经是「外部 IM channel」（如 #160 反向兼容段所述），把 agent-to-agent exchange 塞同 tab 会让用户混淆「跟人聊」与「跟 agent 聊」；UX 上是两个 mental model。
- 候选 3（General）：channel 不是基础开关；General tab 现在装 port / repos dir / editor 这类基础配置，channel 进去违和。
- 候选 4（无 UI）：高阶用户可以接受，但配置入口分散——fnox edit 后还要重启 server 才生效，没有 「Test Connection」按钮——退化方案。
- 候选 1（AI tab）：agent-channel exchange 本质是 agent 配置——「这个 fulcrum 实例上的 agent 能否参与 agent-to-agent 通道」是 AI 子设定；与 default agent、agent options 等同级；同时 fnox key 继续走 `channels.exchange.*` 子树（与 #160 已锁，避免 fnox 一边改名）。

- 选定: 候选 1 — 在 `frontend/routes/settings/index.tsx` 的 `TabsTrigger value="ai"`（L1100）tab 下新开一个 SettingsSection 「Agent Channel」，包含：enable toggle、exchange URL、token、mailbox 三个字段，外加「Test Connection」按钮调 fulcrum server 一个新 endpoint `POST /api/channels/test-connection`。
- 理由: 1) channel 是 agent 行为开关而非「跟人沟通」开关，UX 与「跟人聊的 messaging tab」分开；2) `channels.exchange.*` fnox key 名沿用 #160 决议，不重命名；3) AI tab 已经装 default agent、opencodeModel、agentOptions 等 agent 子设定，channel 与之 sibling 关系自然；4) 后续若 channel 与外部 IM channel 出现 unified UX（如「routing 控制台」），那条新 tab 独立另开，不污染本决策。

默认值与 override：

- 候选 1（默认值）: 默认 `enabled = false`，用户必须显式打开
- 候选 2（默认值）: 默认 `enabled = true`，未配 exchangeUrl 时静默不拼 `--channels` flag
- 选定（默认值）: 候选 1，`channels.exchange.enabled = false`，符合「显式 opt-in」惯例，避免新装 fulcrum 实例上来就尝试连接不存在的 exchange。
- 理由（默认值）: 1) #160 已锁「fulcrum 启动时不假设 exchange 在线」；2) opt-out 体验需要先有 exchange URL 默认值，目前没有公共 exchange，所以 opt-out 没意义；3) UI 开关明确可见，让用户主动决定。

override 维度：

- 候选 1（override）: 全局开关，无 per-repo / per-task override
- 候选 2（override）: 全局开关 + per-repo override（`repositories` 表加列）
- 候选 3（override）: 全局开关 + per-task override（task 创建时勾选）
- 选定（override）: 候选 1，本 issue 范围内只做全局开关。
- 理由（override）: 1) per-repo / per-task override 没有具体需求驱动；2) 先全局开关跑一段时间，等暴露真实场景再做 override；3) 减小本 issue 落地面积，避免投机性抽象。

fnox key 集（命名建议，design-only，不签字）：

```toml
# design-only, not yet implemented
# config/fnox.toml 新增 keys
[channels.exchange]
enabled    = false      # plain  bool   default false
url        = ""         # plain  string default ""
token      = ""         # age    string default ""
mailbox    = ""         # plain  string default ""
mcpVersion = "^0.3"     # plain  string default per #160 决议
```

---

## frontend 命令拼接路径示意

```
buildAndSendAgentCommand()  ← (frontend/components/terminal/task-terminal.tsx:421)
  ↓
  if (channelEnabled) {
    POST /api/channels/register
      → fulcrum server → POST /v1/register（exchange，#161 envelope）
      → 回填 terminals.channelId
      ← 返回 { channelId, registeredAt, heartbeat }
    channel = { mcpInvocation, channelId, exchangeUrl }
  } else {
    channel = undefined  // 命令退化为旧形态
  }
  ↓
  buildAgentCommand(currentAgent, { ..., channel })
    ↓
    claudeBuilder.buildCommand  ← (frontend/lib/agent-commands.ts:42)
      ↓
      if (channel) prefix `--channels server:"<mcpInvocation>"`
  ↓
  writeToTerminalRef.current(actualTerminalId, taskCommand + '\r')
```

---

## 与 #160 / #161 决议的对齐

- 协议血统：from-scratch（#160 决议）；本 doc 不重新实现 envelope。
- envelope / register / heartbeat / discovery / delivery 形态：100% 沿用 #161；本 doc 仅决定 fulcrum 一侧 client 如何 wire 到这些端点。
- fnox 唯一接入点（`channels.exchange.url` / `.token` / `.mailbox` / `.mcpVersion`）：与 #160 部署模型段一致；本 doc 仅新增 `channels.exchange.enabled` 一项 UI 开关。
- MCP child = claude 子进程：与 #161 前提 (5) 一致；本 doc 不重写该 lifecycle，仅声明 fulcrum 一侧不显式管 MCP child 进程。
- channel-id 由 exchange 最终分配（client 提 desired）：与 #161 Register API 段一致。

## 关联

- Umbrella: #153
- Parent thread: #162
- 直接 unblock: #163（MCP tool ABI 需 client 注入决议）/ 后续实现 wave
- 协议形态唯一权威: #161（`docs/design/channel/02-wire-contract.md`）
- repo / 部署 / 包归属唯一权威: #160（`docs/design/channel/00-exchange-repo-decision.md`）
