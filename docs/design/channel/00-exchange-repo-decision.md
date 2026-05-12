# 决策: agent-to-agent channel exchange 独立 repo 落地路径

> Status: **subject-to-relocation** — 本文档随 exchange repo 起步后整段挪到对应 repo；fulcrum 仅保留指针式引用。
> Closes thread of: #160（umbrella #153）
> Blocks: #161 / #162 / #163 / #164

## 背景

- 用户约束：「exchange 是独立服务，fulcrum 不持有 exchange 代码」「新 repo（不 fork `Mouriya-Emma/claude-code-pr-bridge-e2e`）」「fulcrum 一侧 = launcher 改造 + 注册 + 心跳」。
- 可参考 prior art：`Mouriya-Emma/claude-code-pr-bridge-e2e`（5 包 monorepo：`protocol` / `bridge` / `channel` / `ci-template` / `fixture`）已实现 single-route 单向 GitHub→Claude 通道，phase 0-3 通过本地验证；但 multi-mailbox 寻址 / agent-to-agent / 出站 reply 工具均未实现。
- 本 issue 只回答 5 个 meta 问题；envelope / tool / register API 形态归 #161-#163。

## 决策一览

| # | 维度 | 选定 |
|---|---|---|
| 1 | Repo 名 | `agent-channel-exchange` |
| 2 | 协议血统 | 从 spec 重新实现（仅借鉴 bridge-e2e 的 envelope 形态与 route 分类约定） |
| 3 | Repo 结构 | monorepo（`protocol` / `exchange` / `mcp` / `fixtures` 四包） |
| 4 | 部署模型 | 独立 docker stack（远端 host），fulcrum 通过 fnox 配置寻址 |
| 5 | MCP server 包归属 | exchange repo 内的 `@agent-channel/mcp` 包，fulcrum 以 `npx` pinned semver 启动 child |

新 repo 三项基本写法（行首加粗以匹配 acceptance 行 4 形态）：

**Repo 名**: `agent-channel-exchange`

**Owner**: `Mouriya-Emma`

**Visibility**: `public`（与 bridge-e2e 一致；外部 agent 需读 spec / 拉 SDK）

---

## Repo 名

- 候选：`agent-channel-exchange`
- 候选：`claude-channel-exchange`
- 候选：`mcp-channel-exchange`
- 候选：`pm-agent-bus`（PM agent 视角命名）

trade-off：

- `claude-*` 过度绑定单一 vendor，与「agent-to-agent」普适语义冲突；今后接入 OpenCode / Codex 这类 agent 会让名字误导。
- `mcp-*` 暗示这是 MCP server registry / hub，但 exchange 本身是消息总线，MCP 只是 fulcrum 一侧的接入形态；这层混淆会污染搜索结果。
- `pm-agent-bus` 把命名锁死在「PM agent 视角」，但 exchange 本身要服务 PM agent 之外的 worker agent / observer，命名太窄。
- `agent-channel-exchange` 三个词分别表达「agent-to-agent」「channel-based 寻址」「exchange/broker 角色」，与 #161/#162/#163 概念边界对齐。

**选定**：`agent-channel-exchange`。

**理由**：1) vendor/protocol-neutral；2) 与 fulcrum 既有 `channels/`（WhatsApp/Discord/Telegram/Slack/Email）命名空间不冲突——后者是外部 IM channel，本 repo 是 agent 间 channel，分得清；3) 与 bridge-e2e（PR-event 形状）划清 domain。

---

## 协议血统

- 候选：完全 from-scratch（不参考 bridge-e2e 任何东西）
- 候选：vendor `claude-code-pr-protocol` 源码进新 repo
- 候选：git submodule 引用 bridge-e2e protocol 包
- 候选：**从 spec 重新实现**，仅借鉴 envelope 形态、parser 模式与 route 分类约定

trade-off：

- 完全 from-scratch 丢掉 bridge-e2e 已验证的 envelope 结构 / HMAC 签名约定 / parser 错误分类经验，等于重新踩坑。
- vendor 源码：bridge-e2e 协议是 PR-event 形状（`pull_request.opened`/`issue_comment.created` 这类 GitHub-事件 envelope），agent-to-agent 是 mailbox/route/reply 形状，vendor 进来后立刻得改 80% schema，反而比重写更混乱。
- submodule：耦合两个 repo 的 release 节奏，bridge-e2e 改 schema 会牵动 exchange CI，违反「exchange 独立」目标。
- 从 spec 重新实现：保留 envelope outer shape（`version` / `id` / `ts` / `source` / `target` / `payload` / `signature` 这类约定）和 parser 风格，inner schema 全部 agent-to-agent 形状。

**选定**：从 spec 重新实现。

**理由**：1) bridge-e2e 是 PR-event domain，复用 inner schema 会逆向污染；2) outer envelope 约定属于「跨服务消息总线」普适设计，可以独立写一遍；3) 不引入 submodule / vendor 让两个 repo 解耦；4) #161 wire contract 可以基于干净 spec 推导，不背 PR-event 包袱。

**复用清单**（仅 design conventions，不复制代码）：

- envelope outer 字段顺序与命名约定。
- HMAC `X-Signature` header 形态与 timestamp anti-replay 窗口。
- parser 错误分类（`malformed` / `unauthorized` / `unknown_route`）。
- monorepo 包切分思路（protocol-only types 包独立可发布）。

---

## Repo 结构

- 候选：单包（所有代码一个 `src/`）
- 候选：4 包 monorepo（protocol / exchange / mcp / fixtures）
- 候选：bridge-e2e 同构 5 包 monorepo（protocol / bridge / channel / ci-template / fixture）

trade-off：

- 单包：发布粒度太粗，fulcrum 要拉 MCP child 就必须把整个 exchange server runtime 当依赖装下去，体积浪费且攻击面变大。
- 5 包同构：bridge-e2e 的 `ci-template` / `fixture` 拆分服务于 PR-event 多渠道接入，对 agent-to-agent exchange 当前阶段是过度拆分。
- 4 包 monorepo：刚好对应 4 个独立 release artifact，schema 漂移由 single repo 强约束。

**选定**：4 包 monorepo。

**包枚举**：

| 包 | 角色 | 发布 |
|---|---|---|
| `@agent-channel/protocol` | wire envelope TypeScript 类型 + JSON Schema | npm public |
| `@agent-channel/exchange` | server: 注册 / mailbox / 路由 / 心跳 | docker image only |
| `@agent-channel/mcp` | fulcrum 一侧 MCP child（agent 视角的 channel client tool 集） | npm public |
| `@agent-channel/fixtures` | 端到端测试 / 协议契约 fixture | npm public（devDep） |

**理由**：1) protocol 包独立发布让其它 agent 实现 client 时只装类型，不背 server；2) MCP 与 server 同 repo 同 release 让 tool ABI 与 envelope schema 不漂移；3) exchange server 不上 npm（避免误把 server bin 当 lib 用），只发 docker image。

---

## 部署模型

- 候选：fulcrum 启动时 spawn exchange 进程
- 候选：fulcrum container 内进程
- 候选：远端独立 docker stack（与 fulcrum 同 host 或异 host 均可）
- 候选：本机 systemd unit

trade-off：

- fulcrum spawn：违反「exchange 独立服务」约束，fulcrum 重启会拖崩 exchange 与其它 agent 的连接。
- fulcrum container 内进程：进程生命周期耦合、独立性丧失、scaling 无法分开。
- 本机 systemd：拒绝 fulcrum 重启传染，但远端 agent 接入要 NAT/端口暴露，运维成本高。
- 远端独立 docker stack：通过 Komodo 部署（与 fulcrum 同一控制平面但不同 stack），fulcrum 通过 URL + token 寻址，远程 agent 也可直连。

**选定**：远端独立 docker stack（部署平面 Komodo，运行 host 由 #164 PM agent / runtime layout 决定）。

**寻址契约**：

- fulcrum 一侧通过 fnox 读：
  - `channels.exchange.url`（plain，例如 `https://exchange.example.com`）
  - `channels.exchange.token`（age 加密 bearer token）
  - `channels.exchange.mailbox`（plain，本 fulcrum 实例的 mailbox 标识，例如 `fulcrum-mouriya-laptop`）
- fulcrum 启动时不假设 exchange 在线；首次连接失败走 retry-with-backoff，UI 在 Settings → Channels 暴露连接状态。
- exchange URL 形态对应到 #161 注册/心跳/出站发送端点（具体 path 归 #161）。

**理由**：1) exchange 进程 lifecycle 与 fulcrum 完全解耦；2) docker stack 让 exchange 自身 scale / restart 不影响其它 agent；3) Komodo 已是仓库基础设施，无需引入新部署链；4) URL + token 形式让本机 dev 也可以指向 `http://localhost:<port>` 跑本地 exchange，开发与生产同形。

**反向兼容**：fulcrum 已有 `channels/` 命名空间是「外部 IM channel」（WhatsApp/Discord/Telegram/Slack/Email），与 agent-channel exchange 是不同概念；fnox key 走 `channels.exchange.*` 子树以共享前缀但避免歧义可接受，#162 fulcrum client integration 落地时若证实歧义再改名 `agentChannel.exchange.*`。

---

## MCP server 包归属

- 候选：fulcrum 仓内置 MCP server 代码
- 候选：exchange repo 的独立包，npm 发布，fulcrum 以 `npx` 启动
- 候选：第三方 npm package

trade-off：

- fulcrum 内置：tool ABI 与 envelope schema 漂移风险高（fulcrum 升级节奏 ≠ exchange 升级节奏），且 fulcrum 仓得拉 exchange 类型依赖。
- 第三方：当前没有合适候选；自己写一个再标第三方是脱裤子放屁。
- exchange repo 包 + `npx`：fulcrum 仓只持有「拉起命令」+「pinned version」两条配置，MCP 实现与 exchange server 同 repo 同 release，schema 强一致。

**选定**：exchange repo 的 `@agent-channel/mcp` 包，fulcrum 通过 `npx -y @agent-channel/mcp@<pinned-semver>` 启动 child。

**version skew 管理**：

- fulcrum 在 `channels.exchange.mcpVersion`（plain，fnox）配置 pinned semver（例如 `^0.3`）。
- fulcrum 启动 MCP child 前先调 exchange `/version` 端点（具体形态归 #161）确认 server 与 MCP 包语义版本兼容；不兼容直接 surface 到 UI，不静默继续。
- MCP 包发布严格 semver：minor 不破坏 tool ABI，major 才允许破坏。

**理由**：1) MCP tool 与 envelope schema 同 release，无漂移；2) fulcrum 仓不背 exchange 类型；3) `npx` pinned semver 等价于 docker image tag pinning，已是仓库惯用部署模式；4) 升级链清晰：先升 exchange → 发新 `@agent-channel/mcp` → fulcrum 改 fnox pinned version。

---

## fulcrum ↔ exchange 部署示意

```
┌─────────────────────────────┐         ┌──────────────────────────────────────┐
│ fulcrum (本机 / 远程任意 host) │         │ agent-channel-exchange (远端 docker) │
│                             │         │                                      │
│   fnox config:              │         │   @agent-channel/exchange (server)   │
│     channels.exchange.url   │ ──HTTP─▶│     • register / heartbeat           │
│     channels.exchange.token │         │     • mailbox routing                │
│     channels.exchange.mbx   │         │     • outbound reply dispatch        │
│                             │         │                                      │
│   spawned MCP child:        │         │   protocol envelope: from-scratch    │
│     npx -y @agent-channel/  │         │     spec, 借鉴 bridge-e2e outer 形态 │
│       mcp@<pinned semver>   │         │                                      │
│         │                   │         │                                      │
│         ▼                   │         │                                      │
│   Claude Code agent uses    │         │                                      │
│   MCP tools to send/recv    │         │                                      │
└─────────────────────────────┘         └──────────────────────────────────────┘
                                                       ▲
                                                       │ HTTP
                                                       │
                                            ┌─────────────────────┐
                                            │ 其它 fulcrum 实例 /  │
                                            │ PM agent / worker    │
                                            │ agent / observer     │
                                            └─────────────────────┘
```

- fulcrum 不持有 exchange 代码；只持有 launcher 配置（url / token / mailbox / mcpVersion）。
- exchange repo 独立 release：server 走 docker，protocol/mcp/fixtures 走 npm。
- agent-to-agent 流量全部经 exchange，无 fulcrum-to-fulcrum 直连。

---

## 与 bridge-e2e 的关系声明

- **不 fork** `Mouriya-Emma/claude-code-pr-bridge-e2e`；新 repo 与之没有 git 历史关系。
- **不 vendor / submodule** 任何 bridge-e2e 代码包。
- **仅借鉴**：envelope outer 字段约定、HMAC `X-Signature` 形态、parser 错误分类、monorepo 包切分思路。
- **不复用**：bridge-e2e 的 PR-event inner schema、`bridge` 包的 GitHub adapter、`ci-template` / `fixture` 形态。
- 后续 exchange repo `README.md` 在「Prior art」一节短引用 bridge-e2e 链接即可，不复制其内容。

---

## 落地序列（仅 forward-looking 提示，不在本 issue 范围）

1. 本 doc merge 进 fulcrum main（关闭 #160）。
2. #161 wire contract spec 基于本决策动笔（envelope/route/auth/heartbeat schema）。
3. exchange repo 创建（按本文 owner / visibility / 名字），protocol 包率先发 0.x。
4. #162 fulcrum client integration 实现 launcher / fnox key / 寻址 / 重试。
5. #163 MCP tool ABI 与入站 notification ABI 在 exchange repo 落地，发 `@agent-channel/mcp` 0.x。
6. #164 PM agent 协议层基于本决策的 mailbox 寻址展开。

本文档在 exchange repo 起步后整段迁移过去，fulcrum 仓保留一行指针引用。

---

## 关联

- Umbrella: #153
- 直接 unblock: #161 / #162 / #163 / #164
- Prior art: https://github.com/Mouriya-Emma/claude-code-pr-bridge-e2e
