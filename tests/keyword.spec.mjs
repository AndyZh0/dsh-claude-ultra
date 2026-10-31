import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findUltraKeyword, hasUltrathinkKeyword, hasUltraKeyword, textOfBlocks } from '../lib/index.js'

/** The single accepted occurrence of a one-match prompt. */
function only(text, word = 'ultracode') {
  const matches = findUltraKeyword(text, word)
  assert.equal(matches.length, 1, 'expected exactly one match in ' + JSON.stringify(text))
  return matches[0]
}

/** The accepted occurrences' words. */
function words(text, word = 'ultracode') {
  return findUltraKeyword(text, word).map(match => match.word)
}

test('a bare keyword is accepted', () => {
  assert.deepEqual(only('ultracode'), { word: 'ultracode', start: 0, end: 9 })
})

test('the keyword is matched without regard to case', () => {
  for (const text of ['UltraCode', 'ULTRACODE', 'ultraCode']) {
    assert.equal(only(text).word, text)
  }
})

test('a keyword inside a sentence is accepted', () => {
  assert.deepEqual(only('please ultracode this'), { word: 'ultracode', start: 7, end: 16 })
})

test('a trailing period that does not start a name is accepted', () => {
  assert.equal(only('ultracode.').end, 9)
  assert.equal(only('ultracode. And more').end, 9)
})

test('other trailing punctuation is accepted', () => {
  for (const text of ['ultracode!', 'ultracode,', 'ultracode:', 'ultracode)']) {
    assert.equal(words(text).length, 1, JSON.stringify(text))
  }
})

test('a prompt that starts with a slash command never triggers', () => {
  assert.deepEqual(findUltraKeyword('/ultracode', 'ultracode'), [])
  assert.deepEqual(findUltraKeyword('/please ultracode', 'ultracode'), [])
})

test('a keyword inside a delimiter pair is rejected', () => {
  // All seven pairs are delimited spans, parentheses and brackets included,
  // so a keyword inside any of them is not an opt-in.
  const delimited = [
    '\u0060ultracode\u0060',
    '"ultracode"',
    "'ultracode'",
    '<ultracode>',
    '{ultracode}',
    '[ultracode]',
    '(ultracode)',
  ]
  for (const text of delimited) {
    assert.deepEqual(findUltraKeyword(text, 'ultracode'), [], JSON.stringify(text))
  }
})

test('a delimited keyword is rejected in the middle of a prompt too', () => {
  const delimited = [
    'run \u0060ultracode\u0060 now',
    'say "ultracode" now',
    "say 'ultracode' now",
    'a <ultracode> b',
    'a {ultracode} b',
    'a [ultracode] b',
    'a (ultracode) b',
  ]
  for (const text of delimited) {
    assert.deepEqual(findUltraKeyword(text, 'ultracode'), [], JSON.stringify(text))
  }
})

test('an unclosed delimiter does not hide a keyword', () => {
  assert.equal(words('a (ultracode').length, 1)
  assert.equal(words('a [ultracode').length, 1)
})

test('a keyword glued to a path character is rejected', () => {
  for (const text of ['/ultracode', 'please /ultracode', '\\\\ultracode', 'please \\\\ultracode', '-ultracode', 'please -ultracode']) {
    assert.deepEqual(findUltraKeyword(text, 'ultracode'), [], JSON.stringify(text))
  }
})

test('a keyword that runs into another character is rejected', () => {
  for (const text of ['ultracode/', 'ultracode\\\\', 'ultracode-', 'ultracode?']) {
    assert.deepEqual(findUltraKeyword(text, 'ultracode'), [], JSON.stringify(text))
  }
})

test('a keyword that starts a file name is rejected', () => {
  assert.deepEqual(findUltraKeyword('ultracode.js', 'ultracode'), [])
  assert.deepEqual(findUltraKeyword('see ultracode.md for more', 'ultracode'), [])
})

test('a longer word that merely contains the keyword is rejected', () => {
  for (const text of ['ultracodes', 'xultracode', 'preultracodepost']) {
    assert.deepEqual(findUltraKeyword(text, 'ultracode'), [], JSON.stringify(text))
  }
})

test('a prompt with no keyword at all yields nothing', () => {
  assert.deepEqual(findUltraKeyword('', 'ultracode'), [])
  assert.deepEqual(findUltraKeyword('just a question', 'ultracode'), [])
})

test('the reported offsets index the matched text', () => {
  const text = 'say ultracode now'
  const match = only(text)
  assert.equal(text.slice(match.start, match.end), match.word)
  assert.equal(match.start, 4)
  assert.equal(match.end, 13)
})

test('every accepted occurrence is reported', () => {
  const matches = findUltraKeyword('ultracode and ULTRACODE', 'ultracode')
  assert.equal(matches.length, 2)
  assert.deepEqual(matches.map(match => match.word), ['ultracode', 'ULTRACODE'])
  assert.deepEqual(matches.map(match => match.start), [0, 14])
  assert.deepEqual(matches.map(match => match.end), [9, 23])
})

test('the word to look for is a parameter', () => {
  assert.equal(only('please ultrathink now', 'ultrathink').word, 'ultrathink')
  assert.deepEqual(findUltraKeyword('ultracode', 'ultrathink'), [])
})

test('hasUltraKeyword reports whether any occurrence is accepted', () => {
  assert.equal(hasUltraKeyword('ultracode'), true)
  assert.equal(hasUltraKeyword('please UltraCode this'), true)
  assert.equal(hasUltraKeyword('just a question'), false)
  assert.equal(hasUltraKeyword('\u0060ultracode\u0060'), false)
  assert.equal(hasUltraKeyword('/ultracode'), false)
})

test('textOfBlocks joins the text blocks of a message', () => {
  assert.equal(textOfBlocks([{ type: 'text', text: 'please ultra' }, { type: 'text', text: 'code this' }]), 'please ultracode this')
})

test('textOfBlocks ignores everything but the text blocks', () => {
  assert.equal(textOfBlocks([{ type: 'image' }, { type: 'text', text: 'a' }, { type: 'text' }]), 'a')
  assert.equal(textOfBlocks([{ type: 'image', text: 'ignored' }, { type: 'text', text: 'kept' }]), 'kept')
})

test('textOfBlocks tolerates a message with no blocks', () => {
  assert.equal(textOfBlocks(undefined), '')
  assert.equal(textOfBlocks([]), '')
})

test('textOfBlocks output is what the matcher reads', () => {
  const blocks = [{ type: 'text', text: 'please ultra' }, { type: 'text', text: 'code this' }]
  assert.equal(hasUltraKeyword(textOfBlocks(blocks)), true)
})

// --- the ultrathink keyword -------------------------------------------------
//
// ultrathink is looser than ultracode. Claude's reminder emitter tests the bare
// word /\bultrathink\b/i (byte offset 294821831), not the span-aware matcher it
// uses for ultracode, so quoting, backticking, a leading slash, a trailing dot
// and parentheses all still fire. Only an inflected or embedded word does not.

test('a bare ultrathink is matched without regard to case', () => {
  assert.equal(hasUltrathinkKeyword('ultrathink'), true)
  assert.equal(hasUltrathinkKeyword('UltraThink'), true)
  assert.equal(hasUltrathinkKeyword('ULTRATHINK'), true)
  assert.equal(hasUltrathinkKeyword('please ultrathink about this'), true)
  assert.equal(hasUltrathinkKeyword('just a question'), false)
})

test('a delimited, slashed or dotted ultrathink still boosts', () => {
  const accepted = [
    '\u0060ultrathink\u0060',
    '"ultrathink"',
    "'ultrathink'",
    '<ultrathink>',
    '{ultrathink}',
    '[ultrathink]',
    '(ultrathink)',
    '/ultrathink',
    'please /ultrathink',
    'ultrathink.',
    'ultrathink.js',
    '-ultrathink',
    'ultrathink?',
    'ultrathink/',
    'run \u0060ultrathink\u0060 now',
  ]
  for (const text of accepted) {
    assert.equal(hasUltrathinkKeyword(text), true, JSON.stringify(text))
  }
})

test('an inflected or embedded ultrathink does not boost', () => {
  for (const text of ['ultrathinks', 'ultrathinking', 'ultrathinked', 'xultrathink', 'preultrathinkpost']) {
    assert.equal(hasUltrathinkKeyword(text), false, JSON.stringify(text))
  }
})

test('the same shapes still do not opt in as ultracode', () => {
  const rejected = [
    '\u0060ultracode\u0060',
    '"ultracode"',
    "'ultracode'",
    '<ultracode>',
    '{ultracode}',
    '[ultracode]',
    '(ultracode)',
    '/ultracode',
    'please /ultracode',
    'ultracode.js',
    '-ultracode',
    'ultracode?',
    'ultracode/',
  ]
  for (const text of rejected) {
    assert.equal(hasUltraKeyword(text), false, JSON.stringify(text))
  }
})

test('the two keywords treat the same shapes differently', () => {
  const shapes = ['\u0060%s\u0060', '"%s"', "'%s'", '<%s>', '{%s}', '[%s]', '(%s)', '/%s', 'please /%s', '%s.js', '%s?', '-%s', '%s/']
  for (const shape of shapes) {
    const ultrathink = shape.replaceAll('%s', 'ultrathink')
    const ultracode = shape.replaceAll('%s', 'ultracode')
    assert.equal(hasUltrathinkKeyword(ultrathink), true, 'ultrathink: ' + ultrathink)
    assert.equal(hasUltraKeyword(ultracode), false, 'ultracode: ' + ultracode)
  }
})

test('the ultrathink offsets index the matched text', () => {
  const text = 'say ultrathink now'
  const matches = findUltraKeyword(text, 'ultrathink')
  assert.equal(matches.length, 1)
  assert.equal(text.slice(matches[0].start, matches[0].end), 'ultrathink')
  assert.equal(matches[0].word, 'ultrathink')
})

test('the two keywords do not trigger each other', () => {
  assert.equal(hasUltraKeyword('ultrathink'), false)
  assert.equal(hasUltrathinkKeyword('ultracode'), false)
  assert.equal(hasUltraKeyword('ultracode and ultrathink'), true)
  assert.equal(hasUltrathinkKeyword('ultracode and ultrathink'), true)
})
