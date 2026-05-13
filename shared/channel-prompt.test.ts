import { describe, test, expect } from 'bun:test'
import { buildChannelProtocolPromptAddendum } from './channel-prompt'

/**
 * Wire-contract tests for issue #195 channel-protocol prompt addendum.
 *
 * These tests pin the byte-shape constraints that downstream evidence (PR
 * acceptance #2-#6, three-way anchor pattern from PR #198) depends on:
 *
 *   - The agent's own channel id appears verbatim so transcript scans can
 *     match envelope.from = ownChannelId in the receiver's transcript.
 *   - All five business message kinds (assignment, clarify_request,
 *     clarify_response, progress, completion_claim) are listed.
 *   - The prompt explicitly forbids body_kind string matching as the
 *     identification path (issue #195 §约束 #1).
 *   - The prompt instructs the agent to chinese-narrate inbound envelopes
 *     so PR Layer-4 evidence can grep for the natural-language pattern.
 *   - role: 'task' vs 'pm' produces role-specific duties so the same
 *     addendum drives both sides of the dialogue without divergence risk.
 */
describe('buildChannelProtocolPromptAddendum (#195)', () => {
  test('task role embeds own channel id and PM peer hint', () => {
    const text = buildChannelProtocolPromptAddendum({
      role: 'task',
      ownChannelId: 'fulcrum-issue195/task-abc-123',
      peerHint: 'pm-mouriya/main',
    })
    expect(text).toContain('`fulcrum-issue195/task-abc-123`')
    expect(text).toContain('PM agent pm-mouriya/main')
    // Task duties must include polling at startup and reporting completion.
    expect(text).toContain('启动后立刻调用一次 `mcp__agent-channel__channel_poll_inbox`')
    expect(text).toContain('completion_claim')
  })

  test('pm role embeds own channel id and task peer hint', () => {
    const text = buildChannelProtocolPromptAddendum({
      role: 'pm',
      ownChannelId: 'pm-mouriya/main',
      peerHint: 'fulcrum-mouriya/task-',
    })
    expect(text).toContain('`pm-mouriya/main`')
    expect(text).toContain('task agent（典型 channel 前缀 fulcrum-mouriya/task-）')
    // PM duties must mention dispatching assignment and answering clarify_request.
    expect(text).toContain('把 assignment 投到目标 task channel')
    expect(text).toContain('clarify_response')
  })

  test('all five business kinds are enumerated regardless of role', () => {
    const kinds = [
      'assignment',
      'clarify_request',
      'clarify_response',
      'progress',
      'completion_claim',
    ]
    for (const role of ['task', 'pm'] as const) {
      const text = buildChannelProtocolPromptAddendum({
        role,
        ownChannelId: 'x/y',
      })
      for (const kind of kinds) {
        expect(text).toContain(kind)
      }
    }
  })

  test('rejects body_kind string matching as identification path (issue #195 §约束 #1)', () => {
    const text = buildChannelProtocolPromptAddendum({
      role: 'task',
      ownChannelId: 'x/y',
    })
    // Must explicitly tell the agent to look at payload, not body_kind, when classifying.
    expect(text).toContain('只看 payload 的语义内容')
    expect(text).toContain('不看 envelope.body_kind 字段的字面值')
  })

  test('instructs receiver to natural-language narrate inbound envelopes', () => {
    const text = buildChannelProtocolPromptAddendum({
      role: 'task',
      ownChannelId: 'x/y',
    })
    // PR acceptance #2-#6 grep for "我收到了来自 <from> 的 X 类消息" in receiver transcripts.
    expect(text).toContain('我收到了来自')
    expect(text).toContain('内容摘要')
  })

  test('teaches both roles to stop sending after mailbox_deregistered (#196)', () => {
    for (const role of ['task', 'pm'] as const) {
      const text = buildChannelProtocolPromptAddendum({
        role,
        ownChannelId: 'x/y',
      })
      // Must name the exact error variant so the agent matches on it.
      expect(text).toContain('mailbox_deregistered')
      // Must instruct natural-language narration to the user when peer is gone
      // (D4 business gate: Alice 不切 session 就能看到 PM 自然宣告 task agent 离场).
      expect(text).toContain('已经离场，我不会再追它')
      // Must instruct refusing future channel.send on that mailbox.
      expect(text).toContain('不要再向同一 channel id 发新的 `channel.send`')
    }
  })

  test('output is deterministic across calls with the same args (no timestamps / randoms)', () => {
    const args = {
      role: 'task' as const,
      ownChannelId: 'x/y',
      peerHint: 'pm-z/main',
    }
    expect(buildChannelProtocolPromptAddendum(args)).toBe(
      buildChannelProtocolPromptAddendum(args),
    )
  })

  test('peerHint is optional; falls back to generic phrasing', () => {
    const taskText = buildChannelProtocolPromptAddendum({
      role: 'task',
      ownChannelId: 'x/y',
    })
    expect(taskText).toContain('你与 PM agent 通过 agent-channel 通话')
    const pmText = buildChannelProtocolPromptAddendum({
      role: 'pm',
      ownChannelId: 'p/m',
    })
    expect(pmText).toContain('你是 PM agent，通过 agent-channel 给 task agent 派活')
  })
})
