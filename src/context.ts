/** The system-prompt contribution that carries the Ultra mode into model requests. */
import type {
  ClaudeUltraContext,
  UltraAgent,
  UltraModelSelection,
  UltraModelSelectionProjection,
  UltraSession,
  UltraUserMessage,
} from './ports.ts'
import { hasUltrathinkKeyword, hasUltraKeyword, textOfBlocks } from './keyword.ts'
import type { UltraKeywordStore } from './keyword-store.ts'
import type { UltraBoostStore } from './boost-store.ts'
import type { UltraArmRecord, UltraArmStore } from './arms.ts'
import {
  CLAUDE_ULTRA_KEYWORD_SECTION,
  CLAUDE_ULTRA_PROJECTION_KEY,
  CLAUDE_ULTRA_SYSTEM_SECTION,
  CLAUDE_ULTRA_ULTRATHINK_SECTION,
} from './protocol.ts'
import type { ClaudeUltraModeState, UltraReminder } from './projection.ts'
import { EMPTY_CLAUDE_ULTRA_MODE_STATE } from './projection.ts'
import {
  ULTRATHINK_EFFORT,
  ULTRA_ENTER_FULL,
  ULTRA_ENTER_STILL,
  ULTRA_EXIT,
  ULTRA_KEYWORD_REQUEST,
  ULTRA_SPARSE_INTERVAL,
  usageHintFor,
} from './prompts.ts'

/**
 * Read one Session's Ultra projection.
 * @param ctx - Host context carrying the projection registry.
 * @param session - Session to read.
 * @returns the folded state, or the empty state.
 */
function ultraStateOf(ctx: ClaudeUltraContext, session: UltraSession): ClaudeUltraModeState {
  return ctx.sessionProjections.stateOf<ClaudeUltraModeState>(session, CLAUDE_ULTRA_PROJECTION_KEY) ?? EMPTY_CLAUDE_ULTRA_MODE_STATE
}

/**
 * Read the selection that the next request will use.
 * @param ctx - Host context carrying the projection registry.
 * @param agent - Agent whose Session is read.
 * @returns the pending selection, the last used selection, or the logged header.
 */
function selectionOf(ctx: ClaudeUltraContext, agent: UltraAgent): UltraModelSelection | undefined {
  const projected = ctx.sessionProjections.stateOf<UltraModelSelectionProjection>(agent.session, 'modelSelection')
  const selected = projected?.pending ?? projected?.lastUsed ?? undefined
  if (selected !== undefined) return selected
  const config = agent.session.requestHeader()?.config
  if (config === undefined) return undefined
  return {
    provider: config.provider,
    model: config.model,
    ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: String(config.reasoningEffort) }),
  }
}

/**
 * Test whether an armed route is the selection the next request will use.
 * @param arm - armed route, when one exists.
 * @param selection - current or pending selection.
 * @returns whether the route and mapped effort agree.
 */
function armMatches(arm: UltraArmRecord | undefined, selection: UltraModelSelection | undefined): boolean {
  return arm !== undefined
    && selection !== undefined
    && arm.provider === selection.provider
    && arm.model === selection.model
    && arm.effort === selection.reasoningEffort
}

/** Whether one agent is a delegated child rather than a root conversation. */
function isSubagent(agent: UltraAgent): boolean {
  return agent.session.header.origin === 'subagent'
}

/** Whether one folded state records an entry into ultracode. */
function isEntering(state: ClaudeUltraModeState): boolean {
  return state.mode === 'full' || state.mode === 'still'
}

/**
 * Resolve the reminder one Agent's next assembly must materialize.
 *
 * Claude's cadence, from the attachment builder in the same bundle (byte offset
 * 294845975): the full text on the first turn under ultracode, the short text
 * once every {@link ULTRA_SPARSE_INTERVAL} typed prompts, the exit text once
 * when the mode ends, and nothing otherwise. The interval is measured from the
 * prompt count the last reminder was logged at, which reproduces Claude's
 * backwards scan for the newest reminder and the user messages newer than it.
 *
 * The arm intent wins while it still matches the selection, so a tier the user
 * just picked is always announced; a selection after an entry snapshot forces
 * the exit text. A subagent with no snapshot of its own inherits an active
 * parent, so a child spawned under Ultra starts with the full entry text.
 * @param ctx - Host context carrying projections and the agent registry.
 * @param agent - Agent entering prompt assembly.
 * @param arms - pre-request arm store.
 * @returns the reminder to materialize, or null when this turn gets none.
 */
export function resolveClaudeUltraReminder(ctx: ClaudeUltraContext, agent: UltraAgent, arms: UltraArmStore): UltraReminder | null {
  const state = ultraStateOf(ctx, agent.session)
  const selection = selectionOf(ctx, agent)
  if (armMatches(arms.get(String(agent.session.id)), selection)) return isEntering(state) ? 'still' : 'full'
  if (isEntering(state)) {
    if (state.dirty) return 'off'
    return state.prompts - state.markerAt >= ULTRA_SPARSE_INTERVAL ? 'still' : null
  }
  if (!isSubagent(agent)) return null
  // A child's own snapshot records what it was last told; the parent's current
  // state decides whether the child runs under Ultra now, so a child that once
  // left still inherits an active parent.
  const parentId = agent.session.header.parentSession
  if (parentId === undefined) return null
  const parent = ctx.agents.get(parentId)
  if (parent === undefined) return null
  const parentState = ultraStateOf(ctx, parent.session)
  if (armMatches(arms.get(String(parent.session.id)), selectionOf(ctx, parent))) return 'full'
  if (!isEntering(parentState)) return null
  return parentState.dirty ? null : 'full'
}

/** Render one reminder into the section body. */
function reminderText(reminder: UltraReminder): string {
  if (reminder === 'full') return ULTRA_ENTER_FULL
  if (reminder === 'still') return ULTRA_ENTER_STILL
  return ULTRA_EXIT
}

/**
 * Track the keyword opt-in of the prompt a turn is about to assemble.
 *
 * The opt-in cannot be folded from the Session log: DSH appends \`system/message\`
 * before \`user/message\`, so a fold trails the turn by one. It is held in memory
 * instead, set when the prompt enters the inbox and cleared once the turn that
 * claimed it has assembled.
 *
 * The two hooks are ordered around the assembly by agent-loop \`agent.ts\`:
 * \`inbox.claim\` and \`systemPrompt.assemble\` run before the \`agent/pre-step\`
 * waterfall, so a prompt inserted before the turn is visible to its first
 * assembly, and the claim — which would be too early — is not what clears it.
 * The ultrathink boost is read from the same prompt. It is consumed later —
 * \`agent/request\` — and cleared at the turn's end, so it covers every step of
 * the turn rather than only its first request.
 * @param ctx - Host context carrying the agent dispatch.
 * @param keywords - per-Session keyword store.
 * @param boosts - per-Session ultrathink store.
 * @returns the disposer removing both listeners.
 */
export function registerClaudeUltraKeywordCapture(ctx: ClaudeUltraContext, keywords: UltraKeywordStore, boosts: UltraBoostStore): () => void {
  const offInserted = ctx.on('agent/inbox/inserted', ({ agent, message }: { agent: UltraAgent; message: UltraUserMessage }) => {
    if (message.source?.kind !== 'user') return
    const text = textOfBlocks(message.content)
    const sessionId = String(agent.session.id)
    keywords.set(sessionId, hasUltraKeyword(text))
    boosts.set(sessionId, hasUltrathinkKeyword(text))
  })
  const offPreStep = ctx.on('agent/pre-step', async ({ agent, messages, turn }, next) => {
    const consumed = messages.some((message: UltraUserMessage) => message.source?.kind === 'user')
    const result = await next()
    const sessionId = String(agent.session.id)
    // A step that claimed a typed prompt belongs to the turn that prompt opened,
    // so its assembly has already read the opt-in.
    if (consumed) {
      keywords.clear(sessionId)
      // The boost is bound here rather than at its insertion, because a prompt
      // typed while a turn is still running is inserted before that turn ends
      // and would otherwise be bound to the wrong one.
      boosts.bind(sessionId, turn)
    }
    return result
  })
  return () => {
    offInserted()
    offPreStep()
  }
}

/**
 * Register the system-prompt section that carries the Ultra mode.
 *
 * A section contributed through this waterfall is retained by the assembly and
 * by the later runtime-context refresh, is model-visible, and is logged in the
 * system message that the durable projection folds back into the tier state.
 * @param ctx - Host context carrying the system-prompt registry.
 * @param arms - pre-request arm store.
 * @param keywords - per-Session keyword store.
 * @param boosts - per-Session ultrathink store.
 * @returns the disposer removing the contribution.
 */
export function registerClaudeUltraSystemPrompt(
  ctx: ClaudeUltraContext,
  arms: UltraArmStore,
  keywords: UltraKeywordStore,
  boosts: UltraBoostStore,
): () => void {
  return ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const result = await next()
    const agent = context.agent
    if (agent === undefined) return result
    const sections = [...result.sections]
    const reminder = resolveClaudeUltraReminder(ctx, agent, arms)
    if (reminder !== null) {
      sections.push({
        name: CLAUDE_ULTRA_SYSTEM_SECTION,
        text: usageHintFor(isSubagent(agent)) + String.fromCharCode(10) + String.fromCharCode(10) + reminderText(reminder),
      })
    }
    // Claude emits the keyword reminder in the same turn as the standing one,
    // so this rides its own section rather than replacing it.
    if (keywords.get(String(agent.session.id))) {
      sections.push({ name: CLAUDE_ULTRA_KEYWORD_SECTION, text: ULTRA_KEYWORD_REQUEST })
    }
    // Claude's ultrathink is a per-turn effort raise, announced on its own.
    if (boosts.get(String(agent.session.id))) {
      sections.push({ name: CLAUDE_ULTRA_ULTRATHINK_SECTION, text: ULTRATHINK_EFFORT })
    }
    return sections.length === result.sections.length ? result : { ...result, sections }
  })
}
