import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createClaudeUltraArmStore } from '../lib/index.js'

const RECORD = { provider: 'acme', model: 'astra', effort: 'max' }

test('an unarmed session has no record', () => {
  assert.equal(createClaudeUltraArmStore().get('session-1'), undefined)
})

test('an armed route is readable back', () => {
  const arms = createClaudeUltraArmStore()
  arms.set('session-1', RECORD)
  assert.deepEqual(arms.get('session-1'), RECORD)
})

test('arms are per session', () => {
  const arms = createClaudeUltraArmStore()
  arms.set('session-1', RECORD)
  assert.equal(arms.get('session-2'), undefined)
})

test('mutating the object passed to set does not change stored state', () => {
  const arms = createClaudeUltraArmStore()
  const record = { provider: 'acme', model: 'astra', effort: 'max' }
  arms.set('session-1', record)
  record.effort = 'low'
  record.provider = 'other'
  assert.deepEqual(arms.get('session-1'), RECORD)
})

test('mutating the object returned by get does not change stored state', () => {
  const arms = createClaudeUltraArmStore()
  arms.set('session-1', RECORD)
  const read = arms.get('session-1')
  read.effort = 'low'
  assert.deepEqual(arms.get('session-1'), RECORD)
})

test('each read returns a fresh record', () => {
  const arms = createClaudeUltraArmStore()
  arms.set('session-1', RECORD)
  assert.notEqual(arms.get('session-1'), arms.get('session-1'))
})

test('clear removes the arm', () => {
  const arms = createClaudeUltraArmStore()
  arms.set('session-1', RECORD)
  arms.clear('session-1')
  assert.equal(arms.get('session-1'), undefined)
})

test('clearing an unarmed session is harmless', () => {
  const arms = createClaudeUltraArmStore()
  arms.clear('session-1')
  assert.equal(arms.get('session-1'), undefined)
})
