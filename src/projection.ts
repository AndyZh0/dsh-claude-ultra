/** Durable Ultra mode projection folded from the logged system messages. */
import { z as zod } from 'zod'
import type { UltraProjectionDefinition, UltraSessionEvent } from './ports.ts'
import { textOfBlocks } from './keyword.ts'
import { CLAUDE_ULTRA_PROJECTION_KEY } from './protocol.ts'
import { ULTRA_ENTER_FULL, ULTRA_ENTER_STILL, ULTRA_EXIT } from './prompts.ts'

/**
 * Which Ultra reminder the last assembly materialized.
 *
 * Claude distinguishes the first entry into ultracode ('full') from a turn that
 * is already under it (its 'sparse' variant), and emits a separate reminder on
 * exit.
 */
export type UltraReminder = 'full' | 'still' | 'off'

/**
 * Folded reminder, whether a model selection arrived after the snapshot, and the
 * prompt count that decides the next repeat.
 */
export interface ClaudeUltraModeState {
  readonly mode: UltraReminder | null
  readonly dirty: boolean
  /** Typed prompts the log holds. */
  readonly prompts: number
  /** {@link prompts} as it stood when the last reminder was logged. */
  readonly markerAt: number
}

/** Empty state used before a Session has an Ultra snapshot. */
export const EMPTY_CLAUDE_ULTRA_MODE_STATE: ClaudeUltraModeState = { mode: null, dirty: false, prompts: 0, markerAt: 0 }

/** Persisted-state schema for the projection. */
const claudeUltraModeStateSchema = zod.object({
  mode: zod.union([zod.literal('full'), zod.literal('still'), zod.literal('off')]).nullable(),
  dirty: zod.boolean(),
  prompts: zod.number(),
  markerAt: zod.number(),
})

/**
 * Advance the Ultra projection by one Session event.
 *
 * A typed prompt is counted but never read: DSH logs `system/message` before
 * `user/message`, so a keyword taken from here would trail the turn by one. The
 * count is what the repeat interval is measured against, and it is correct as
 * read, because an assembly sees every prompt logged before its own.
 * @param state - state before the event.
 * @param event - next committed Session event.
 * @returns the original or advanced state.
 */
export function applyClaudeUltraModeProjection(state: ClaudeUltraModeState, event: UltraSessionEvent): ClaudeUltraModeState {
  if (event.type === 'model/selection') {
    return state.mode === 'full' || state.mode === 'still'
      ? (state.dirty ? state : { ...state, dirty: true })
      : state
  }
  if (event.type === 'user/message') {
    return event.data?.source?.kind === 'user' ? { ...state, prompts: state.prompts + 1 } : state
  }
  // The Host materializes Ultra in the system prompt, so the logged system
  // message is the durable record of which reminder the model last received.
  if (event.type === 'system/message') {
    const text = textOfBlocks(event.data?.message?.content)
    const mode: UltraReminder | null = text.includes(ULTRA_ENTER_FULL)
      ? 'full'
      : text.includes(ULTRA_ENTER_STILL)
        ? 'still'
        : text.includes(ULTRA_EXIT)
          ? 'off'
          : null
    if (mode === null) return state
    return state.mode === mode && !state.dirty && state.markerAt === state.prompts
      ? state
      : { mode, dirty: false, prompts: state.prompts, markerAt: state.prompts }
  }
  return state
}

/** The Session projection definition registered by the Host half. */
export const claudeUltraModeProjection = {
  key: CLAUDE_ULTRA_PROJECTION_KEY,
  stateVersion: 2,
  stateSchema: claudeUltraModeStateSchema,
  init: (): ClaudeUltraModeState => EMPTY_CLAUDE_ULTRA_MODE_STATE,
  apply: applyClaudeUltraModeProjection,
  wire: {
    viewSchema: claudeUltraModeStateSchema,
    view: (state: ClaudeUltraModeState): ClaudeUltraModeState => state,
  },
} satisfies UltraProjectionDefinition<ClaudeUltraModeState>
