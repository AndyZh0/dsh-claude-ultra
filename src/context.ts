/** The system-prompt contribution that carries the Ultra mode into model requests. */
import type {
  ClaudeUltraContext,
  UltraAgent,
  UltraModelSelection,
  UltraModelSelectionProjection,
  UltraSession,
} from './ports.ts'
import type { UltraArmRecord, UltraArmStore } from './arms.ts'
import { CLAUDE_ULTRA_PROJECTION_KEY, CLAUDE_ULTRA_SYSTEM_SECTION } from './protocol.ts'
import type { ClaudeUltraModeState, UltraReminder } from './projection.ts'
import { EMPTY_CLAUDE_ULTRA_MODE_STATE } from './projection.ts'
import { ULTRA_ENTER_FULL, ULTRA_ENTER_STILL, ULTRA_EXIT, usageHintFor } from './prompts.ts'

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
 * The arm intent wins while it still matches the selection; a selection after an
 * entry snapshot forces the exit text; otherwise the last snapshot is
 * authoritative. A subagent with no snapshot of its own inherits an active
 * parent, so a child spawned under Ultra starts with the full entry text.
 * @param ctx - Host context carrying projections and the agent registry.
 * @param agent - Agent entering prompt assembly.
 * @param arms - pre-request arm store.
 * @returns the reminder to materialize, or null when Ultra is not active.
 */
export function resolveClaudeUltraReminder(ctx: ClaudeUltraContext, agent: UltraAgent, arms: UltraArmStore): UltraReminder | null {
  const state = ultraStateOf(ctx, agent.session)
  const selection = selectionOf(ctx, agent)
  if (armMatches(arms.get(String(agent.session.id)), selection)) return isEntering(state) ? 'still' : 'full'
  if (isEntering(state) && state.dirty) return 'off'
  if (state.mode !== null) return state.mode
  if (!isSubagent(agent)) return null
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
 * Register the system-prompt section that carries the Ultra mode.
 *
 * A section contributed through this waterfall is retained by the assembly and
 * by the later runtime-context refresh, is model-visible, and is logged in the
 * system message that the durable projection folds back into the tier state.
 * @param ctx - Host context carrying the system-prompt registry.
 * @param arms - pre-request arm store.
 * @returns the disposer removing the contribution.
 */
export function registerClaudeUltraSystemPrompt(ctx: ClaudeUltraContext, arms: UltraArmStore): () => void {
  return ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const result = await next()
    const agent = context.agent
    if (agent === undefined) return result
    const reminder = resolveClaudeUltraReminder(ctx, agent, arms)
    if (reminder === null) return result
    const text = usageHintFor(isSubagent(agent)) + String.fromCharCode(10) + String.fromCharCode(10) + reminderText(reminder)
    return { ...result, sections: [...result.sections, { name: CLAUDE_ULTRA_SYSTEM_SECTION, text }] }
  })
}
