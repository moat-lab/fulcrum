/**
 * Channel-protocol system prompt addendum (issue #195 / parent #192).
 *
 * Lives in `shared/` because both the frontend `task-terminal.tsx` (per-task
 * claude launch) and the server-side `pm-launch-service.ts` (PM launch helper
 * the user copies from Settings) inject the same protocol guidance into their
 * respective claude `--append-system-prompt`.
 *
 * # Why this exists
 *
 * Wave-2 D1 (#193 / PR #198) wired `channel.send` into a real claude task
 * agent and D2 (#194 / PR #199) wired the symmetric PM launch helper. After
 * those two landed, sending an envelope works end-to-end on the wire — but
 * neither agent knows on its own to (a) periodically call
 * `mcp__agent-channel__channel_poll_inbox` to drain inbound messages, nor
 * (b) recognize an inbound payload as one of the five business message kinds
 * defined in fulcrum#153 (assignment / clarify_request / clarify_response /
 * progress / completion_claim).
 *
 * The MCP child buffers inbound notifications and only exposes them through
 * the `channel.poll_inbox` tool result; per `mcp-server.ts:222` Claude Code
 * does not surface `notifications/claude/channel` to the LLM transcript at
 * all. Without operational guidance the agent silently never polls.
 *
 * Issue #195 §约束 #1 deliberately rejects the simpler "matched on
 * envelope.body_kind string" path: the receiving agent must recognize the
 * semantic type from the payload itself. So the addendum below tells the
 * agent the kinds exist as labels but instructs it to identify and respond
 * based on payload content.
 *
 * # Why a separate file from `agent-commands.ts`
 *
 * `agent-commands.ts` only assembles CLI flags. The addendum is content the
 * agent reads, not a flag, and it has to stay byte-identical between the
 * task-side (frontend) and PM-side (server) launch paths so a future agent
 * change can never drift between the two roles. Co-locating in `shared/`
 * with a single export prevents that drift.
 */

export type ChannelRole = 'task' | 'pm'

export interface ChannelPromptArgs {
  /** 'task' for fulcrum-launched task agents; 'pm' for the PM helper. */
  role: ChannelRole
  /** This agent's own mailbox channel id (e.g. `pm-mouriya/main`). */
  ownChannelId: string
  /** Optional peer hint shown to the agent. For PM: typical task channel
   *  prefix (e.g. `fulcrum-mouriya/task-`). For task: PM mailbox id when
   *  known. Falls back to a generic phrasing when omitted. */
  peerHint?: string
}

/**
 * Build the channel-protocol system prompt addendum, ready to concatenate
 * onto the agent's existing system prompt. Returns Chinese because the
 * acceptance criteria in #195 specify Chinese natural-language transcripts
 * on both sender and receiver sides; agents reliably mirror the language of
 * their system prompt.
 *
 * The output is deterministic (no timestamps, no random ids) so tests can
 * compare exact byte sequences and so identical configs across reboots
 * yield identical agent behavior.
 */
export function buildChannelProtocolPromptAddendum(args: ChannelPromptArgs): string {
  const peerLine =
    args.role === 'task'
      ? args.peerHint
        ? `你与 PM agent ${args.peerHint} 通过 agent-channel 通话；`
        : '你与 PM agent 通过 agent-channel 通话；'
      : args.peerHint
      ? `你是 PM agent，与 task agent（典型 channel 前缀 ${args.peerHint}）通过 agent-channel 派活；`
      : '你是 PM agent，通过 agent-channel 给 task agent 派活；'

  const roleSpecificDuties =
    args.role === 'task'
      ? [
          '- 启动后立刻调用一次 `mcp__agent-channel__channel_poll_inbox` 看是否已经有 PM 派来的活；如果没有，向用户说明并等待。',
          '- 完成一个里程碑要主动用 `mcp__agent-channel__channel_send` 给 PM 报 progress；做完整件活要主动报 completion_claim，不要等 PM 问。',
          '- 遇到决策分叉时主动用 channel.send 向 PM 发 clarify_request，把问题和可选项都列清楚。',
        ]
      : [
          '- 用户要派活时，用 `mcp__agent-channel__channel_send` 把 assignment 投到目标 task channel；payload 写清楚要做什么、约束是什么、什么算完工。',
          '- 收到 task 的 clarify_request，要么直接答（如果你有信息），要么转给用户问；用户答完用 clarify_response 回 task。',
          '- 收到 task 的 progress / completion_claim 要主动汇总展示给用户，并在 completion_claim 上判断是否真的可以收尾。',
        ]

  return [
    '',
    '## Agent Channel 协议（必读）',
    '',
    `你的 agent-channel 身份是 \`${args.ownChannelId}\`。${peerLine}可用 MCP 工具是 \`mcp__agent-channel__channel_send\`、\`mcp__agent-channel__channel_poll_inbox\`、\`mcp__agent-channel__channel_list_channels\`。`,
    '',
    '业务上你和对端会跑五类消息（这是协议约定的语义类，不是字符串匹配）：',
    '',
    '1. **assignment** — PM 把一段活派给某个 task agent。',
    '2. **clarify_request** — 一方对另一方提出需要回答的问题。',
    '3. **clarify_response** — 一方答复对方刚刚提出的 clarify_request。',
    '4. **progress** — task 向 PM 报阶段性进度。',
    '5. **completion_claim** — task 向 PM 声明这件活做完了，可以收尾。',
    '',
    '关键操守：',
    '',
    '- 接收方判别消息类型**只看 payload 的语义内容**，不看 envelope.body_kind 字段的字面值；body_kind 只是工程层 hint。',
    '- 收到 inbound envelope 后，**先用一两句中文自然语言陈述「我收到了来自 \\<from\\> 的 \\<五类之一\\> 类消息：\\<内容摘要\\>」**，再决定如何反应（开始做 / 回答问题 / 继续推进 / 总结收尾）。这样人类看 transcript 就能确认你确实业务层理解了对方在说什么。',
    '- 阶段性地（每完成几步、或在等回复时）再调一次 `channel.poll_inbox`，避免漏掉对方后续消息。`channel.poll_inbox` 只返回上次 drain 后的新消息，所以可以放心多次调。',
    '- 发送 `channel.send` 时，`body_kind` 字段填上面五个语义类之一作为工程 hint；payload 用中文自然描述这件事，不要塞结构化字段去逼对端按字段解析——对端是 LLM agent，会直接读你的话。',
    ...roleSpecificDuties,
    '',
  ].join('\n')
}
