/** The system-prompt contribution that carries the Ultra mode into model requests. */
import type {
  ClaudeUltraContext,
  UltraAgent,
  UltraModelSelection,
  UltraModelSelectionProjection,
  UltraSession,
  UltraUserMessage,
} from './ports.ts'
import { hasUltraKeyword, textOfBlocks } from './keyword.ts'
import type { UltraKeywordStore } from './keyword-store.ts'
import type { UltraArmRecord, UltraArmStore } from './arms.ts'
import { CLAUDE_ULTRA_KEYWORD_SECTION, CLAUDE_ULTRA_PROJECTION_KEY, CLAUDE_ULTRA_SYSTEM_SECTION } from './protocol.ts'
import type { ClaudeUltraModeState, UltraReminder } from './projection.ts'
import { EMPTY_CLAUDE_ULTRA_MODE_STATE } from './projection.ts'
import { ULTRA_ENTER_FULL, ULTRA_ENTER_STILL, ULTRA_EXIT, ULTRA_KEYWORD_REQUEST, usageHintFor } from './prompts.ts'

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
 * @param ctx - Host context carrying the agent dispatch.
 * @param keywords - per-Session keyword store.
 * @returns the disposer removing both listeners.
 */
export function registerClaudeUltraKeywordCapture(ctx: ClaudeUltraContext, keywords: UltraKeywordStore): () => void {
  const offInserted = ctx.on('agent/inbox/inserted', ({ agent, message }: { agent: UltraAgent; message: UltraUserMessage }) => {
    if (message.source?.kind !== 'user') return
    keywords.set(String(agent.session.id), hasUltraKeyword(textOfBlocks(message.content)))
  })
  const offPreStep = ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    const consumed = messages.some((message: UltraUserMessage) => message.source?.kind === 'user')
    const result = await next()
    // A step that claimed a typed prompt belongs to the turn that prompt opened,
    // so its assembly has already read the opt-in.
    if (consumed) keywords.clear(String(agent.session.id))
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
 * @returns the disposer removing the contribution.
 */
export function registerClaudeUltraSystemPrompt(ctx: ClaudeUltraContext, arms: UltraArmStore, keywords: UltraKeywordStore): () => void {
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
    return sections.length === result.sections.length ? result : { ...result, sections }
  })
}
