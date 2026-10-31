/**
 * dsh-claude-ultra Host half.
 *
 * Ultra is Claude's ultracode: a session-scoped mode that runs at the top of the
 * model's effort scale and keeps multi-agent orchestration standing. It is an
 * effort mode over an adapter-owned level, not a new adapter effort: the
 * selected value is the mapped reasoning level (max when advertised), and the
 * ultracode policy rides a system-prompt section. The projection folds the
 * logged system message plus model-selection events, so the mode survives
 * reload, restart, and resume without a new Session event type.
 */
import type { ClaudeUltraContext } from './ports.ts'
import { createClaudeUltraArmStore } from './arms.ts'
import { registerClaudeUltraSystemPrompt } from './context.ts'
import { claudeUltraModeProjection } from './projection.ts'
import { registerClaudeUltraArmRoute } from './route.ts'

/** Cordis plugin identity. */
export const name = 'dsh-claude-ultra'

/** Host services the projection, the prompt section, the route, and cleanup need. */
export const inject = ['systemPrompt', 'sessionProjections', 'sessions', 'connection', 'llm', 'agents']

export { createClaudeUltraArmStore } from './arms.ts'
export type { UltraArmRecord, UltraArmStore } from './arms.ts'
export { resolveClaudeUltraReminder } from './context.ts'
export { mappedUltraEffort } from './mode.ts'
export type { UltraEffortCandidate } from './mode.ts'
export { applyClaudeUltraModeProjection, claudeUltraModeProjection, EMPTY_CLAUDE_ULTRA_MODE_STATE } from './projection.ts'
export type { ClaudeUltraModeState, UltraReminder } from './projection.ts'
export { registerClaudeUltraArmRoute } from './route.ts'
export {
  CLAUDE_ULTRA_API_CHANNEL,
  CLAUDE_ULTRA_ARM_ENDPOINT,
  CLAUDE_ULTRA_ARM_PATH,
  CLAUDE_ULTRA_PROJECTION_KEY,
  CLAUDE_ULTRA_SYSTEM_SECTION,
} from './protocol.ts'
export {
  ROOT_USAGE_HINT,
  SUBAGENT_USAGE_HINT,
  ULTRATHINK_EFFORT,
  ULTRA_ENTER_FULL,
  ULTRA_ENTER_STILL,
  ULTRA_EXIT,
  ULTRA_KEYWORD_REQUEST,
  usageHintFor,
} from './prompts.ts'

/**
 * Mount the Ultra mode.
 * @param ctx - Host context carrying the required services.
 */
export function apply(ctx: ClaudeUltraContext): void {
  const arms = createClaudeUltraArmStore()
  ctx.effect(() => ctx.sessionProjections.register(claudeUltraModeProjection), 'dsh-claude-ultra: projection')
  ctx.effect(() => registerClaudeUltraSystemPrompt(ctx, arms), 'dsh-claude-ultra: system prompt')
  // The Fetch registration already rides the caller's fiber, so it needs no
  // second disposer here.
  registerClaudeUltraArmRoute(ctx, arms)

  // A later selection leaves Ultra before the next assembly. The route arms the
  // exact selection that the browser just submitted, which is why its own
  // model/selection event (before the arm) and any later one both clear first.
  ctx.on('session/event', (session, event) => {
    if (event.type === 'model/selection') arms.clear(String(session.id))
  })

  // The system prompt has already materialized the arm by the time this
  // listener runs; consume it so a later request cannot reuse a stale intent.
  ctx.on('agent/request', async ({ agent }, next) => {
    const config = await next()
    const sessionId = String(agent.session.id)
    const arm = arms.get(sessionId)
    if (arm !== undefined) {
      if (arm.effort !== String(config.reasoningEffort)) {
        ctx.logger.warn('dsh-claude-ultra: armed effort "' + arm.effort + '" did not reach the request (got "' + String(config.reasoningEffort) + '")')
      }
      arms.clear(sessionId)
    }
    return config
  })

  ctx.on('agent/disposed', ({ agent }) => {
    arms.clear(String(agent.session.id))
  })
}
