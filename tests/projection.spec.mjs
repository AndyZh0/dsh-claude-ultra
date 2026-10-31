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

const MODEL_SELECTION = { type: 'model/selection' }

function state(mode, dirty) {
  return { mode, dirty }
}

test('a logged entry into ultracode folds to full', () => {
  const folded = applyClaudeUltraModeProjection(EMPTY_CLAUDE_ULTRA_MODE_STATE, systemMessage(ULTRA_ENTER_FULL))
  assert.deepEqual(folded, { mode: 'full', dirty: false })
})

test('a logged repeat reminder folds to still', () => {
  const folded = applyClaudeUltraModeProjection(EMPTY_CLAUDE_ULTRA_MODE_STATE, systemMessage(ULTRA_ENTER_STILL))
  assert.deepEqual(folded, { mode: 'still', dirty: false })
})

test('a logged exit reminder folds to off', () => {
  const folded = applyClaudeUltraModeProjection(state('full', false), systemMessage(ULTRA_EXIT))
  assert.deepEqual(folded, { mode: 'off', dirty: false })
})

test('the reminder is read out of the text blocks, not the whole message', () => {
  const folded = applyClaudeUltraModeProjection(state('off', false), systemMessage('preamble ', ULTRA_ENTER_FULL, ' trailing'))
  assert.deepEqual(folded, { mode: 'full', dirty: false })
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

test('a repeated identical entry returns the identical reference', () => {
  const before = state('full', false)
  assert.equal(applyClaudeUltraModeProjection(before, systemMessage(ULTRA_ENTER_FULL)), before)
})

test('a model selection after an entry marks the state dirty', () => {
  const before = state('full', false)
  const folded = applyClaudeUltraModeProjection(before, MODEL_SELECTION)
  assert.deepEqual(folded, { mode: 'full', dirty: true })
  assert.notEqual(folded, before)
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
  assert.deepEqual(folded, { mode: 'full', dirty: false })
})

test('an unrelated event type leaves the state identical', () => {
  const before = state('still', false)
  assert.equal(applyClaudeUltraModeProjection(before, { type: 'tool/call' }), before)
})

test('the projection definition is keyed and versioned', () => {
  assert.equal(claudeUltraModeProjection.key, 'claudeUltraMode')
  assert.equal(claudeUltraModeProjection.stateVersion, 1)
})

test('the projection starts empty', () => {
  assert.deepEqual(claudeUltraModeProjection.init(), { mode: null, dirty: false })
})

test('the persisted-state schema accepts the folded states', () => {
  for (const value of [state('off', false), state('full', true), state('still', false), state(null, false)]) {
    assert.deepEqual(claudeUltraModeProjection.stateSchema.parse(value), value)
  }
})

test('the persisted-state schema rejects an unknown mode', () => {
  assert.throws(() => claudeUltraModeProjection.stateSchema.parse({ mode: 'nope', dirty: false }))
})
