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
import type { ClaudeUltraContext, UltraSessionController } from './ports.ts'
import { createClaudeUltraArmStore } from './arms.ts'
import { createClaudeUltraBoostStore } from './boost-store.ts'
import { registerClaudeUltraKeywordCapture, registerClaudeUltraSystemPrompt } from './context.ts'
import { createClaudeUltraKeywordStore } from './keyword-store.ts'
import { mappedUltraEffort } from './mode.ts'
import { claudeUltraModeProjection } from './projection.ts'
import { registerClaudeUltraArmRoute } from './route.ts'

/** Cordis plugin identity. */
export const name = 'dsh-claude-ultra'

/** Host services the projection, the prompt section, the route, and cleanup need. */
export const inject = ['systemPrompt', 'sessionProjections', 'sessions', 'connection', 'llm', 'agents']

export { createClaudeUltraArmStore } from './arms.ts'
export type { UltraArmRecord, UltraArmStore } from './arms.ts'
export { registerClaudeUltraKeywordCapture, resolveClaudeUltraReminder } from './context.ts'
export { createClaudeUltraKeywordStore } from './keyword-store.ts'
export type { UltraKeywordStore } from './keyword-store.ts'
export { createClaudeUltraBoostStore } from './boost-store.ts'
export type { UltraBoostStore } from './boost-store.ts'
export { hasUltrathinkKeyword, textOfBlocks } from './keyword.ts'
export { mappedUltraEffort } from './mode.ts'
export type { UltraEffortCandidate } from './mode.ts'
export { applyClaudeUltraModeProjection, claudeUltraModeProjection, EMPTY_CLAUDE_ULTRA_MODE_STATE } from './projection.ts'
export type { ClaudeUltraModeState, UltraReminder } from './projection.ts'
export { registerClaudeUltraArmRoute } from './route.ts'
export {
  CLAUDE_ULTRA_API_CHANNEL,
  CLAUDE_ULTRA_ARM_ENDPOINT,
  CLAUDE_ULTRA_ARM_PATH,
  CLAUDE_ULTRA_KEYWORD_SECTION,
  CLAUDE_ULTRA_PROJECTION_KEY,
  CLAUDE_ULTRA_SYSTEM_SECTION,
  CLAUDE_ULTRA_ULTRATHINK_SECTION,
} from './protocol.ts'
export { findUltraKeyword, hasUltraKeyword } from './keyword.ts'
export type { UltraKeywordMatch } from './keyword.ts'
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
/**
 * Put a Session back on the selection an ultrathink turn displaced.
 *
 * The Session business API is read through \`ctx.get\` rather than injected: a
 * composition without it still loads, and a boost then lasts until the Session's
 * next selection, which is all the request header alone can express.
 * @param ctx - Host context.
 * @param sessionId - Session whose turn just ended.
 * @param previous - selection the boosted request displaced.
 */
async function restoreDisplacedSelection(
  ctx: ClaudeUltraContext,
  sessionId: string,
  previous: { provider: string; model: string; reasoningEffort?: string },
): Promise<void> {
  const controller = ctx.get('sessionController') as UltraSessionController | undefined
  if (typeof controller?.selectModel !== 'function') return
  try {
    await controller.selectModel({ sessionId, ...previous })
  } catch (error) {
    ctx.logger.warn('dsh-claude-ultra: the ultrathink boost was not undone: ' + String(error))
  }
}

export function apply(ctx: ClaudeUltraContext): void {
  const arms = createClaudeUltraArmStore()
  const keywords = createClaudeUltraKeywordStore()
  const boosts = createClaudeUltraBoostStore()
  // The selection each boosted turn displaced, keyed by Session, so the boost
  // can be undone once that turn ends.
  const displaced = new Map<string, { provider: string; model: string; reasoningEffort?: string }>()
  ctx.effect(() => ctx.sessionProjections.register(claudeUltraModeProjection), 'dsh-claude-ultra: projection')
  ctx.effect(() => registerClaudeUltraSystemPrompt(ctx, arms, keywords, boosts), 'dsh-claude-ultra: system prompt')
  ctx.effect(() => registerClaudeUltraKeywordCapture(ctx, keywords, boosts), 'dsh-claude-ultra: keyword capture')
  // The Fetch registration already rides the caller's fiber, so it needs no
  // second disposer here.
  registerClaudeUltraArmRoute(ctx, arms)

  // A later selection leaves Ultra before the next assembly. The route arms the
  // exact selection that the browser just submitted, which is why its own
  // model/selection event (before the arm) and any later one both clear first.
  ctx.on('session/event', (session, event) => {
    const sessionId = String(session.id)
    if (event.type === 'model/selection') {
      arms.clear(sessionId)
      // A selection the user made outranks undoing the boost: leave it alone.
      displaced.delete(sessionId)
    }
    // The boost is turn-scoped, like Claude's setTurnEffort, so it survives
    // every step of the turn it was typed for and no further. Only the turn it
    // was bound to may end it: a prompt typed while the previous turn is still
    // finishing is inserted before that turn's `turn/end`, which lands about a
    // tenth of a second after the reply renders.
    if (event.type === 'turn/end' && event.data?.turn !== undefined) {
      boosts.release(sessionId, event.data.turn)
      const previous = displaced.get(sessionId)
      if (previous !== undefined) {
        displaced.delete(sessionId)
        void restoreDisplacedSelection(ctx, sessionId, previous)
      }
    }
  })

  // The system prompt has already materialized the arm by the time this
  // listener runs; consume it so a later request cannot reuse a stale intent.
  ctx.on('agent/request', async ({ agent, turn }, next) => {
    const config = await next()
    const sessionId = String(agent.session.id)
    const arm = arms.get(sessionId)
    if (arm !== undefined) {
      if (arm.effort !== String(config.reasoningEffort)) {
        ctx.logger.warn('dsh-claude-ultra: armed effort "' + arm.effort + '" did not reach the request (got "' + String(config.reasoningEffort) + '")')
      }
      arms.clear(sessionId)
    }
    // Claude's ultrathink raises the turn's effort rather than switching a mode,
    // so it rewrites this request's config instead of going through a selection.
    // A route already at its top level is left alone.
    if (!boosts.get(sessionId) || boosts.turnOf(sessionId) !== turn) return config
    try {
      const info = await ctx.llm.resolveModelInfo(config.provider, config.model)
      const top = mappedUltraEffort(info.reasoning?.efforts)
      if (top === undefined || top === String(config.reasoningEffort)) return config
      // DSH keeps the effort in the request header, which every later request
      // inherits, so a boost that only rewrote this config would silently raise
      // the Session for good. Remember what it displaced so turn end can undo it.
      displaced.set(sessionId, {
        provider: config.provider,
        model: config.model,
        ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: String(config.reasoningEffort) }),
      })
      return { ...config, reasoningEffort: top }
    } catch (error) {
      // A route this plugin cannot resolve is the selection path's problem, not
      // the boost's; leave the request as the session configured it.
      ctx.logger.warn('dsh-claude-ultra: ultrathink could not resolve "' + config.provider + '/' + config.model + '": ' + String(error))
      return config
    }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    const sessionId = String(agent.session.id)
    arms.clear(sessionId)
    keywords.clear(sessionId)
    boosts.clear(sessionId)
    displaced.delete(sessionId)
  })
}
