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

/** Folded reminder plus whether a model selection arrived after the snapshot. */
export interface ClaudeUltraModeState {
  readonly mode: UltraReminder | null
  readonly dirty: boolean
}

/** Empty state used before a Session has an Ultra snapshot. */
export const EMPTY_CLAUDE_ULTRA_MODE_STATE: ClaudeUltraModeState = { mode: null, dirty: false }

/** Persisted-state schema for the projection. */
const claudeUltraModeStateSchema = zod.object({
  mode: zod.union([zod.literal('full'), zod.literal('still'), zod.literal('off')]).nullable(),
  dirty: zod.boolean(),
})

/**
 * Advance the Ultra projection by one Session event.
 *
 * The fold deliberately ignores `user/message`: DSH logs `system/message`
 * before it, so a keyword read from here would trail the turn by one. The
 * keyword opt-in is held in memory instead, fed by `agent/inbox/inserted`.
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
  // The Host materializes Ultra in the system prompt, so the logged system
  // message is the durable record of which reminder the model last received.
  if (event.type === 'system/message') {
    const text = textOfBlocks(event.data?.message?.content)
    if (text.includes(ULTRA_ENTER_FULL)) return state.mode === 'full' && !state.dirty ? state : { mode: 'full', dirty: false }
    if (text.includes(ULTRA_ENTER_STILL)) return state.mode === 'still' && !state.dirty ? state : { mode: 'still', dirty: false }
    if (text.includes(ULTRA_EXIT)) return state.mode === 'off' && !state.dirty ? state : { mode: 'off', dirty: false }
    return state
  }
  return state
}

/** The Session projection definition registered by the Host half. */
export const claudeUltraModeProjection = {
  key: CLAUDE_ULTRA_PROJECTION_KEY,
  stateVersion: 1,
  stateSchema: claudeUltraModeStateSchema,
  init: (): ClaudeUltraModeState => EMPTY_CLAUDE_ULTRA_MODE_STATE,
  apply: applyClaudeUltraModeProjection,
  wire: {
    viewSchema: claudeUltraModeStateSchema,
    view: (state: ClaudeUltraModeState): ClaudeUltraModeState => state,
  },
} satisfies UltraProjectionDefinition<ClaudeUltraModeState>
