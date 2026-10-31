import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyClaudeUltraModeProjection,
  claudeUltraModeProjection,
  EMPTY_CLAUDE_ULTRA_MODE_STATE,
  ULTRA_ENTER_FULL,
  ULTRA_ENTER_STILL,
  ULTRA_EXIT,
} from '../lib/index.js'

/** A logged system message carrying the given text blocks. */
function systemMessage(...texts) {
  return {
    type: 'system/message',
    data: { message: { content: texts.map(text => ({ type: 'text', text })) } },
  }
}

/** A logged user message of the given origin. */
function userMessage(kind, text = 'a prompt') {
  const data = { content: [{ type: 'text', text }] }
  if (kind !== undefined) data.source = { kind }
  return { type: 'user/message', data }
}

/** The source of a message the human typed. */
const TYPED = 'user'

/** One logged user message the human typed. */
function typed(text = 'a prompt') {
  return userMessage(TYPED, text)
}

const MODEL_SELECTION = { type: 'model/selection' }

function state(mode, dirty, prompts = 0, markerAt = 0) {
  return { mode, dirty, prompts, markerAt }
}

/** Fold a run of events into the projection, as the Session log would. */
function fold(...events) {
  return events.reduce((current, event) => applyClaudeUltraModeProjection(current, event), EMPTY_CLAUDE_ULTRA_MODE_STATE)
}

/** A run of n typed prompts. */
function typedPrompts(count) {
  return Array.from({ length: count }, () => typed())
}

test('a logged entry into ultracode folds to full', () => {
  const folded = applyClaudeUltraModeProjection(EMPTY_CLAUDE_ULTRA_MODE_STATE, systemMessage(ULTRA_ENTER_FULL))
  assert.deepEqual(folded, { mode: 'full', dirty: false, prompts: 0, markerAt: 0 })
})

test('a logged repeat reminder folds to still', () => {
  const folded = applyClaudeUltraModeProjection(EMPTY_CLAUDE_ULTRA_MODE_STATE, systemMessage(ULTRA_ENTER_STILL))
  assert.deepEqual(folded, { mode: 'still', dirty: false, prompts: 0, markerAt: 0 })
})

test('a logged exit reminder folds to off', () => {
  const folded = applyClaudeUltraModeProjection(state('full', false), systemMessage(ULTRA_EXIT))
  assert.deepEqual(folded, { mode: 'off', dirty: false, prompts: 0, markerAt: 0 })
})

test('the reminder is read out of the text blocks, not the whole message', () => {
  const folded = applyClaudeUltraModeProjection(state('off', false), systemMessage('preamble ', ULTRA_ENTER_FULL, ' trailing'))
  assert.deepEqual(folded, { mode: 'full', dirty: false, prompts: 0, markerAt: 0 })
})

test('a non-text block does not contribute reminder text', () => {
  const event = {
    type: 'system/message',
    data: { message: { content: [{ type: 'image', text: ULTRA_ENTER_FULL }] } },
  }
  const before = state('off', false)
  assert.equal(applyClaudeUltraModeProjection(before, event), before)
})

test('an unrelated system message leaves the state identical', () => {
  const before = state('full', false)
  assert.equal(applyClaudeUltraModeProjection(before, systemMessage('just the base system prompt')), before)
})

test('a repeated identical reminder at the same count returns the identical reference', () => {
  const before = state('full', false)
  assert.equal(applyClaudeUltraModeProjection(before, systemMessage(ULTRA_ENTER_FULL)), before)
})

test('a repeated reminder after a new prompt re-marks the count', () => {
  const before = state('full', false, 1, 0)
  const folded = applyClaudeUltraModeProjection(before, systemMessage(ULTRA_ENTER_FULL))
  assert.deepEqual(folded, { mode: 'full', dirty: false, prompts: 1, markerAt: 1 })
  assert.notEqual(folded, before)
})

test('a logged reminder records the prompt count it was logged at', () => {
  const folded = fold(...typedPrompts(3), systemMessage(ULTRA_ENTER_FULL))
  assert.deepEqual(folded, { mode: 'full', dirty: false, prompts: 3, markerAt: 3 })
})

test('a model selection after an entry marks the state dirty', () => {
  const before = state('full', false)
  const folded = applyClaudeUltraModeProjection(before, MODEL_SELECTION)
  assert.deepEqual(folded, { mode: 'full', dirty: true, prompts: 0, markerAt: 0 })
  assert.notEqual(folded, before)
})

test('a model selection leaves the prompt count and the marker alone', () => {
  const folded = applyClaudeUltraModeProjection(state('full', false, 4, 4), MODEL_SELECTION)
  assert.deepEqual(folded, { mode: 'full', dirty: true, prompts: 4, markerAt: 4 })
})

test('a second model selection returns the identical reference', () => {
  const dirty = applyClaudeUltraModeProjection(state('full', false), MODEL_SELECTION)
  assert.equal(applyClaudeUltraModeProjection(dirty, MODEL_SELECTION), dirty)
})

test('a model selection while Ultra is off leaves the state identical', () => {
  const before = state('off', false)
  assert.equal(applyClaudeUltraModeProjection(before, MODEL_SELECTION), before)
})

test('a model selection before any entry leaves the state identical', () => {
  const before = state(null, false)
  assert.equal(applyClaudeUltraModeProjection(before, MODEL_SELECTION), before)
})

test('an entry after a dirty selection clears the dirty flag', () => {
  const folded = applyClaudeUltraModeProjection(state('full', true), systemMessage(ULTRA_ENTER_FULL))
  assert.deepEqual(folded, { mode: 'full', dirty: false, prompts: 0, markerAt: 0 })
})

test('an unrelated event type leaves the state identical', () => {
  const before = state('still', false)
  assert.equal(applyClaudeUltraModeProjection(before, { type: 'tool/call' }), before)
})

// --- the prompt count -------------------------------------------------------
//
// A typed prompt is counted but never read: DSH logs system/message before
// user/message, so a keyword taken from here would trail the turn by one. The
// count is what the repeat interval is measured against.

test('a typed prompt is counted', () => {
  const folded = applyClaudeUltraModeProjection(state(null, false), typed())
  assert.deepEqual(folded, { mode: null, dirty: false, prompts: 1, markerAt: 0 })
})

test('a typed prompt is counted from an entering state without touching the mode', () => {
  const folded = applyClaudeUltraModeProjection(state('full', false, 3, 3), typed())
  assert.deepEqual(folded, { mode: 'full', dirty: false, prompts: 4, markerAt: 3 })
})

test('a message the human did not type is not counted', () => {
  const before = state(null, false, 2, 1)
  assert.equal(applyClaudeUltraModeProjection(before, userMessage('runtime-context')), before)
  assert.equal(applyClaudeUltraModeProjection(before, userMessage('skill-catalog')), before)
})

test('a user message with no source is not counted', () => {
  const before = state(null, false, 2, 1)
  assert.equal(applyClaudeUltraModeProjection(before, userMessage(undefined)), before)
})

test('a typed prompt carrying the keyword text is counted but folds no mode', () => {
  const folded = applyClaudeUltraModeProjection(state(null, false), typed('please ultracode this'))
  assert.deepEqual(folded, { mode: null, dirty: false, prompts: 1, markerAt: 0 })
})

test('a typed prompt carrying reminder text does not fold a mode', () => {
  const folded = applyClaudeUltraModeProjection(state(null, false), typed(ULTRA_ENTER_FULL))
  assert.equal(folded.mode, null)
  assert.equal(folded.dirty, false)
  assert.equal(folded.prompts, 1)
})

test('a system message with no reminder leaves the count and the marker alone', () => {
  const before = state('full', false, 5, 2)
  const folded = applyClaudeUltraModeProjection(before, systemMessage('just the base system prompt'))
  assert.equal(folded, before)
})

// --- the definition ---------------------------------------------------------

test('the projection definition is keyed and versioned', () => {
  assert.equal(claudeUltraModeProjection.key, 'claudeUltraMode')
  assert.equal(claudeUltraModeProjection.stateVersion, 2)
})

test('the projection starts empty', () => {
  assert.deepEqual(claudeUltraModeProjection.init(), { mode: null, dirty: false, prompts: 0, markerAt: 0 })
})

test('the persisted-state schema accepts the folded states', () => {
  const accepted = [
    state('off', false),
    state('full', true),
    state('still', false),
    state(null, false),
    state('full', false, 12, 2),
  ]
  for (const value of accepted) {
    assert.deepEqual(claudeUltraModeProjection.stateSchema.parse(value), value)
  }
})

test('the persisted-state schema rejects an unknown mode', () => {
  assert.throws(() => claudeUltraModeProjection.stateSchema.parse({ mode: 'nope', dirty: false, prompts: 0, markerAt: 0 }))
})

test('the persisted-state schema rejects a state without the prompt count', () => {
  assert.throws(() => claudeUltraModeProjection.stateSchema.parse({ mode: 'off', dirty: false, markerAt: 0 }))
})

test('the persisted-state schema rejects a state without the marker', () => {
  assert.throws(() => claudeUltraModeProjection.stateSchema.parse({ mode: 'off', dirty: false, prompts: 0 }))
})
