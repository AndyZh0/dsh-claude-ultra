import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'
import {
  ULTRATHINK_EFFORT,
  ULTRA_ENTER_FULL,
  ULTRA_ENTER_STILL,
  ULTRA_EXIT,
  ULTRA_KEYWORD_REQUEST,
} from '../lib/index.js'
import { decodeSessionLog, readSessionEvents, summarizeSession } from './decode-session.mjs'

/** First four bytes of every zstd frame. */
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** The decoder as the CLI entry point, for the subprocess cases. */
const DECODER = fileURLToPath(new URL('./decode-session.mjs', import.meta.url))

const roots = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** A scratch directory removed when the suite ends. */
function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-decode-session-'))
  roots.push(root)
  return root
}

/** Write one Session log, one frame per chunk, and return its path. */
function writeLog(...chunks) {
  const path = join(scratch(), 'session.v4.jsonl.zstd')
  writeFileSync(path, Buffer.concat(chunks.map(frame)))
  return path
}

/** One zstd frame holding one flushed chunk of a Session log. */
function frame(text) {
  return zstdCompressSync(Buffer.from(text, 'utf8'))
}

/** A Session log: one zstd frame per chunk, concatenated. */
function logBuffer(...chunks) {
  return Buffer.concat(chunks.map(frame))
}

/** Offsets where a zstd frame begins. */
function frameStarts(buffer) {
  const starts = []
  for (let index = 0; index + MAGIC.length <= buffer.length; index += 1) {
    if (buffer.compare(MAGIC, 0, MAGIC.length, index, index + MAGIC.length) === 0) starts.push(index)
  }
  return starts
}

/** One NDJSON chunk holding the given events. */
function lines(...events) {
  return events.map(event => JSON.stringify(event)).join('\n') + '\n'
}

function sessionEvent(id = 'session-1', cwd = '/work') {
  return { type: 'session', id, cwd }
}

function systemEvent(turn, text, step = 1) {
  return { type: 'system/message', data: { turn, step, message: { content: [{ type: 'text', text }] } } }
}

function userEvent(text, kind = 'user') {
  return { type: 'user/message', data: { source: { kind }, content: [{ type: 'text', text }] } }
}

function headerEvent(config) {
  return { type: 'request/header', data: { header: { config } } }
}

/** The single system entry of one turn. */
function systemOf(summary, turn) {
  const entry = summary.turns.find(candidate => candidate.turn === turn)
  assert.ok(entry !== undefined, 'no turn ' + turn)
  return entry.system
}

// --- the codec the fixtures need --------------------------------------------

test('node:zlib exposes the zstd codec the fixtures are built with', () => {
  assert.equal(typeof zstdCompressSync, 'function', 'node:zlib.zstdCompressSync is required to build fixtures')
})

// --- one frame per flush ----------------------------------------------------

test('a single frame decodes to its payload', () => {
  const buffer = logBuffer('{"a":1}\n')
  assert.equal(frameStarts(buffer).length, 1)
  assert.equal(decodeSessionLog(buffer), '{"a":1}\n')
})

test('every concatenated frame decodes, in order', () => {
  const buffer = logBuffer('one\n', 'two\n', 'three\n')
  assert.equal(frameStarts(buffer).length, 3, 'the fixture must really be three frames')
  assert.equal(decodeSessionLog(buffer), 'one\ntwo\nthree\n')
})

test('a buffer with no frame at all decodes to nothing', () => {
  assert.equal(decodeSessionLog(Buffer.alloc(0)), '')
  assert.equal(decodeSessionLog(Buffer.from('not a zstd file')), '')
})

// --- the interrupted writer -------------------------------------------------

test('bytes after the last complete frame do not corrupt the payload', () => {
  const buffer = Buffer.concat([logBuffer('one\n', 'two\n'), Buffer.from([0x00, 0x11, 0x22, 0x33])])
  assert.equal(decodeSessionLog(buffer), 'one\ntwo\n')
})

// A writer killed mid-append leaves the frame magic and a partial body. zstd
// ignores trailing bytes after a complete frame, so only this shape reaches the
// decode failure the reader has to swallow.
test('a torn tail that begins a frame is skipped, not thrown', () => {
  const buffer = Buffer.concat([logBuffer('one\n', 'two\n'), MAGIC, Buffer.alloc(32, 0xff)])
  assert.equal(frameStarts(buffer).length, 3)
  assert.equal(decodeSessionLog(buffer), 'one\ntwo\n')
})

test('a log that is nothing but a torn frame decodes to nothing', () => {
  assert.equal(decodeSessionLog(Buffer.concat([MAGIC, Buffer.alloc(32, 0xff)])), '')
})

// --- reading a log off disk -------------------------------------------------

test('a line that is not JSON is skipped, not thrown', () => {
  const path = writeLog(
    lines(sessionEvent(), systemEvent(1, 'hello')) + 'this is not json at all\n' + lines(userEvent('prompt A')),
  )
  assert.deepEqual(readSessionEvents(path).map(event => event.type), ['session', 'system/message', 'user/message'])
})

test('blank lines are skipped', () => {
  const path = writeLog(lines(sessionEvent()) + '\n\n' + lines(systemEvent(1, 'hello')))
  assert.deepEqual(readSessionEvents(path).map(event => event.type), ['session', 'system/message'])
})

test('a multi-frame log file is read whole', () => {
  const path = writeLog(lines(sessionEvent()), lines(systemEvent(1, 'hello')), lines(userEvent('prompt A')))
  assert.equal(frameStarts(readFileSync(path)).length, 3, 'the fixture must really be three frames')
  assert.deepEqual(readSessionEvents(path).map(event => event.type), ['session', 'system/message', 'user/message'])
})

// --- turn attribution -------------------------------------------------------

test('a prompt belongs to its own turn, not to the latest system message', () => {
  // Real DSH order: the assembled system message is logged before the prompt it
  // was assembled for, so pairing the latest prompt with the latest system
  // message shifts every turn by one.
  const events = [
    sessionEvent(),
    systemEvent(1, 'turn one system prompt'),
    userEvent('prompt A'),
    headerEvent({ provider: 'acme', model: 'astra' }),
    systemEvent(2, 'turn two system prompt'),
    userEvent('prompt B'),
  ]
  const summary = summarizeSession(events)
  assert.deepEqual(summary.turns.map(turn => turn.turn), [1, 2])
  assert.equal(summary.turns[0].prompt, 'prompt A')
  assert.equal(summary.turns[1].prompt, 'prompt B')
})

test('three turns in DSH order keep every prompt with its own turn', () => {
  const summary = summarizeSession([
    systemEvent(1, 's1'), userEvent('A'),
    systemEvent(2, 's2'), userEvent('B'),
    systemEvent(3, 's3'), userEvent('C'),
  ])
  assert.deepEqual(summary.turns.map(turn => turn.prompt), ['A', 'B', 'C'])
})

test('each turn carries the flags of its own system message', () => {
  const summary = summarizeSession([
    systemEvent(1, ULTRA_ENTER_FULL),
    userEvent('prompt A'),
    systemEvent(2, ULTRA_ENTER_STILL),
    userEvent('prompt B'),
  ])
  assert.equal(summary.turns[0].prompt, 'prompt A')
  assert.equal(summary.turns[1].prompt, 'prompt B')
  assert.deepEqual(systemOf(summary, 1), [{ turn: 1, step: 1, enter: true, still: false, exit: false, keyword: false, ultrathink: false }])
  assert.deepEqual(systemOf(summary, 2), [{ turn: 2, step: 1, enter: false, still: true, exit: false, keyword: false, ultrathink: false }])
})

test('turns are reported in turn order, not arrival order', () => {
  const summary = summarizeSession([systemEvent(2, 'second'), systemEvent(1, 'first')])
  assert.deepEqual(summary.turns.map(turn => turn.turn), [1, 2])
})

// --- the Ultra flags --------------------------------------------------------

/** Every flag one logged system message can carry. */
const FLAGS = ['enter', 'still', 'exit', 'keyword', 'ultrathink']

test('each shipped reminder sets exactly its own flag', () => {
  const cases = [
    [ULTRA_ENTER_FULL, 'enter'],
    [ULTRA_ENTER_STILL, 'still'],
    [ULTRA_EXIT, 'exit'],
    [ULTRA_KEYWORD_REQUEST, 'keyword'],
    [ULTRATHINK_EFFORT, 'ultrathink'],
  ]
  cases.forEach(([text, expected], index) => {
    const summary = summarizeSession([systemEvent(index + 1, text)])
    const [entry] = systemOf(summary, index + 1)
    for (const flag of FLAGS) {
      assert.equal(entry[flag], flag === expected, expected + ' case, flag ' + flag)
    }
  })
})

test('the decoder matches the reminder substrings it is written against', () => {
  const cases = [
    ['Ultracode is on: go', 'enter'],
    ['Ultracode is still on — go', 'still'],
    ['Ultracode is off — go', 'exit'],
    ['The user included the keyword "ultracode", opting this turn into multi-agent orchestration', 'keyword'],
    ['The user included the keyword "ultrathink", requesting deeper reasoning on this turn', 'ultrathink'],
  ]
  cases.forEach(([text, expected], index) => {
    const [entry] = systemOf(summarizeSession([systemEvent(index + 1, text)]), index + 1)
    for (const flag of FLAGS) {
      assert.equal(entry[flag], flag === expected, expected + ' case, flag ' + flag)
    }
  })
})

test('an unrelated system message sets no flag', () => {
  const summary = summarizeSession([systemEvent(1, 'just the base system prompt')])
  assert.deepEqual(systemOf(summary, 1), [{ turn: 1, step: 1, enter: false, still: false, exit: false, keyword: false, ultrathink: false }])
})

// Both keyword reminders open with "The user included the keyword", so a flag
// matched on that prefix alone would report the wrong one.

test('the two keyword reminders are not conflated', () => {
  const [ultracode] = systemOf(summarizeSession([systemEvent(1, ULTRA_KEYWORD_REQUEST)]), 1)
  assert.equal(ultracode.keyword, true)
  assert.equal(ultracode.ultrathink, false)
  const [ultrathink] = systemOf(summarizeSession([systemEvent(1, ULTRATHINK_EFFORT)]), 1)
  assert.equal(ultrathink.keyword, false)
  assert.equal(ultrathink.ultrathink, true)
})

test('the shared keyword prefix alone sets neither flag', () => {
  const [entry] = systemOf(summarizeSession([systemEvent(1, 'The user included the keyword')]), 1)
  assert.equal(entry.keyword, false)
  assert.equal(entry.ultrathink, false)
})

test('a message carrying both reminders sets both flags', () => {
  const [entry] = systemOf(summarizeSession([systemEvent(1, ULTRA_KEYWORD_REQUEST + ' ' + ULTRATHINK_EFFORT)]), 1)
  assert.equal(entry.keyword, true)
  assert.equal(entry.ultrathink, true)
})

test('each turn carries the keyword flag of its own reminder', () => {
  const summary = summarizeSession([
    systemEvent(1, ULTRA_KEYWORD_REQUEST),
    userEvent('prompt A'),
    systemEvent(2, ULTRATHINK_EFFORT),
    userEvent('prompt B'),
  ])
  assert.equal(systemOf(summary, 1)[0].keyword, true)
  assert.equal(systemOf(summary, 1)[0].ultrathink, false)
  assert.equal(systemOf(summary, 2)[0].keyword, false)
  assert.equal(systemOf(summary, 2)[0].ultrathink, true)
})

test('the reminder text is read out of the text blocks', () => {
  const event = {
    type: 'system/message',
    data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Ultracode is ' }, { type: 'text', text: 'on: go' }] } },
  }
  assert.equal(summarizeSession([event]).turns[0].system[0].enter, true)
})

test('a non-text block does not contribute reminder text', () => {
  const event = {
    type: 'system/message',
    data: { turn: 1, step: 1, message: { content: [{ type: 'image', text: ULTRA_ENTER_FULL }] } },
  }
  assert.equal(summarizeSession([event]).turns[0].system[0].enter, false)
})

test('the step of each system message is recorded', () => {
  const summary = summarizeSession([systemEvent(1, 'first', 1), systemEvent(1, 'second', 4)])
  assert.deepEqual(systemOf(summary, 1).map(entry => entry.step), [1, 4])
})

test('a system message with no logged turn is skipped', () => {
  const event = { type: 'system/message', data: { message: { content: [{ type: 'text', text: ULTRA_ENTER_FULL }] } } }
  assert.deepEqual(summarizeSession([event]).turns, [])
})

// --- prompts the human did not type -----------------------------------------

test('a message the human did not type is not a prompt', () => {
  const summary = summarizeSession([
    systemEvent(1, 's1'),
    userEvent('injected context', 'runtime-context'),
    userEvent('prompt A'),
  ])
  assert.equal(summary.turns[0].prompt, 'prompt A')
})

test('a turn whose only message is not typed has no prompt', () => {
  const summary = summarizeSession([systemEvent(1, 's1'), userEvent('injected context', 'runtime-context')])
  assert.equal(summary.turns[0].prompt, undefined)
})

// --- request headers --------------------------------------------------------

test('a request header attaches to the turn of the most recent system message', () => {
  const summary = summarizeSession([
    systemEvent(1, 's1'),
    headerEvent({ provider: 'acme', model: 'astra', reasoningEffort: 'max' }),
    systemEvent(2, 's2'),
    headerEvent({ provider: 'acme', model: 'sol' }),
  ])
  assert.deepEqual(summary.turns[0].config, { provider: 'acme', model: 'astra', reasoningEffort: 'max' })
  assert.deepEqual(summary.turns[1].config, { provider: 'acme', model: 'sol' })
})

test('only the first request header of a turn is kept', () => {
  const summary = summarizeSession([
    systemEvent(1, 's1'),
    headerEvent({ provider: 'first' }),
    headerEvent({ provider: 'second' }),
  ])
  assert.deepEqual(summary.turns[0].config, { provider: 'first' })
})

test('a request header before any system message is ignored', () => {
  assert.deepEqual(summarizeSession([headerEvent({ provider: 'first' })]).turns, [])
})

test('a turn with no request header has no config', () => {
  assert.equal(summarizeSession([systemEvent(1, 's1')]).turns[0].config, undefined)
})

// --- turns without a prompt, and the empty session --------------------------

test('a turn with no typed prompt has no prompt', () => {
  const summary = summarizeSession([systemEvent(1, 's1'), systemEvent(2, 's2')])
  assert.equal(summary.turns.length, 2)
  assert.equal(summary.turns[0].prompt, undefined)
  assert.equal(summary.turns[1].prompt, undefined)
})

test('the session header supplies the id and working directory', () => {
  const summary = summarizeSession([sessionEvent('session-9', 'D:/work'), systemEvent(1, 's1')])
  assert.equal(summary.id, 'session-9')
  assert.equal(summary.cwd, 'D:/work')
})

test('an empty event list summarizes to an empty session', () => {
  assert.deepEqual(summarizeSession([]), { id: undefined, cwd: undefined, turns: [] })
})

// --- the command line -------------------------------------------------------

test('the decoder prints a usage line and exits 2 without a path', () => {
  const result = spawnSync(process.execPath, [DECODER], { encoding: 'utf8' })
  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /usage: node tests\/decode-session\.mjs/)
})

test('the decoder prints the summary as JSON for a log path', () => {
  const path = writeLog(lines(sessionEvent('session-7'), systemEvent(1, ULTRA_ENTER_FULL), userEvent('prompt A')))
  const result = spawnSync(process.execPath, [DECODER, path], { encoding: 'utf8' })
  assert.equal(result.status, 0)
  const summary = JSON.parse(result.stdout)
  assert.equal(summary.id, 'session-7')
  assert.equal(summary.turns[0].prompt, 'prompt A')
  assert.equal(summary.turns[0].system[0].enter, true)
})
