/**
 * Read a DSH Session log.
 *
 * The log is a concatenation of zstd frames, one per flush, so the whole file
 * cannot be handed to a single decompress call: \`zstdDecompressSync\` stops at
 * the first frame's end. This splits on the frame magic and decodes each frame
 * in turn, which is what the harness itself writes.
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

/** First four bytes of every zstd frame. */
const FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * Decode every zstd frame of one Session log.
 *
 * Node's zstd entry points stop at the first frame — both \`zstdDecompressSync\`
 * and a \`createZstdDecompress\` stream return only the leading frame's payload —
 * so the boundaries have to be found here. Frame magic is the only marker a
 * concatenated log carries.
 *
 * A boundary found this way can be wrong: the four magic bytes may occur inside
 * a compressed body. Undecoded input is therefore carried forward instead of
 * discarded, so a false boundary costs one failed attempt and the frame still
 * decodes whole. The same carry drops a torn tail, which is what an interrupted
 * writer leaves behind.
 * @param buffer - the whole \`.zstd\` file.
 * @returns the concatenated UTF-8 payload.
 */
export function decodeSessionLog(buffer) {
  const starts = []
  for (let index = 0; index + FRAME_MAGIC.length <= buffer.length; index += 1) {
    if (buffer.compare(FRAME_MAGIC, 0, FRAME_MAGIC.length, index, index + FRAME_MAGIC.length) === 0) starts.push(index)
  }
  let text = ''
  let pending = Buffer.alloc(0)
  for (let frame = 0; frame < starts.length; frame += 1) {
    const end = frame + 1 < starts.length ? starts[frame + 1] : buffer.length
    pending = Buffer.concat([pending, buffer.subarray(starts[frame], end)])
    try {
      text += zstdDecompressSync(pending).toString('utf8')
      pending = Buffer.alloc(0)
    } catch {
      continue
    }
  }
  return text
}

/**
 * Read one Session log into its events, in order.
 * @param path - the \`.zstd\` file.
 * @returns the parsed events; a line that is not JSON is skipped.
 */
export function readSessionEvents(path) {
  return decodeSessionLog(readFileSync(path))
    .split('\n')
    .filter(line => line.trim() !== '')
    .flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
}

/** Text of one logged message's text blocks. */
function textOf(content) {
  return (content ?? []).map(block => (block?.type === 'text' ? block.text ?? '' : '')).join('')
}

/**
 * Reduce one Session's events to the facts a verification cares about.
 *
 * Attribution runs on the logged turn number, not on arrival order: DSH appends
 * \`system/message\` before the \`user/message\` it was assembled for, so pairing
 * "the latest prompt" with "the latest system message" shifts every turn by one.
 * Prompts have no turn of their own, so they are attached by position — the
 * n-th typed prompt belongs to turn n.
 * @param events - events from {@link readSessionEvents}.
 * @returns the working directory and one entry per turn.
 */
export function summarizeSession(events) {
  const header = events.find(event => event.type === 'session')
  const byTurn = new Map()
  const turnOf = (turn) => {
    if (!byTurn.has(turn)) byTurn.set(turn, { turn, prompt: undefined, system: [], config: undefined })
    return byTurn.get(turn)
  }
  const prompts = []
  let current
  for (const event of events) {
    if (event.type === 'system/message') {
      current = event.data?.turn
      if (typeof current !== 'number') continue
      const text = textOf(event.data?.message?.content)
      turnOf(current).system.push({
        turn: current,
        step: event.data?.step,
        enter: text.includes('Ultracode is on:'),
        still: text.includes('Ultracode is still on'),
        exit: text.includes('Ultracode is off'),
        keyword: text.includes('The user included the keyword'),
      })
      continue
    }
    if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
      prompts.push(textOf(event.data.content))
      continue
    }
    if (event.type === 'request/header' && current !== undefined && turnOf(current).config === undefined) {
      turnOf(current).config = event.data?.header?.config
    }
  }
  const turns = [...byTurn.keys()]
    .sort((left, right) => left - right)
    .map((turn) => {
      const entry = turnOf(turn)
      entry.prompt = prompts[turn - 1]
      return entry
    })
  return { id: header?.id, cwd: header?.cwd, turns }
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('decode-session.mjs')) {
  const target = process.argv[2]
  if (target === undefined) {
    process.stderr.write('usage: node tests/decode-session.mjs <session.v4.jsonl.zstd>\n')
    process.exitCode = 2
  } else {
    const summary = summarizeSession(readSessionEvents(target))
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n')
  }
}
