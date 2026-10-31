import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mappedUltraEffort } from '../lib/index.js'

/** Advertised levels, in the display order an adapter reports them. */
function efforts(...ids) {
  return ids.map(id => ({ id }))
}

test('Ultra takes the advertised max level when the model has one', () => {
  assert.equal(mappedUltraEffort(efforts('low', 'high', 'max')), 'max')
})

test('without max, Ultra takes the highest advertised level', () => {
  assert.equal(mappedUltraEffort(efforts('off', 'low', 'high')), 'high')
})

test('a model whose only level is off has no Ultra', () => {
  assert.equal(mappedUltraEffort(efforts('off')), undefined)
})

test('a model that advertises no levels has no Ultra', () => {
  assert.equal(mappedUltraEffort(undefined), undefined)
})

test('a trailing ultra marker is skipped in favour of a real level', () => {
  assert.equal(mappedUltraEffort(efforts('off', 'low', 'high', 'ultra')), 'high')
})

test('off and ultra alone are not usable levels', () => {
  assert.equal(mappedUltraEffort(efforts('ultra')), undefined)
})
