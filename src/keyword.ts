import type { UltraContentBlock } from './ports.ts'

/**
 * Claude's ultra-keyword matcher, ported from Claude Code 2.1.316.
 *
 * Claude does not test a bare regular expression. Its \`ia\` helper (byte offset
 * 290054287 in \`bin/claude.exe\`) first scans the prompt for delimited spans,
 * then rejects a keyword that falls inside one, rejects a prompt that starts
 * with a slash command, and rejects a keyword glued to a path or identifier
 * character. The port keeps that behavior so the trigger agrees with Claude's.
 */

/** Delimiter pairs whose interior cannot carry a keyword. */
const DELIMITERS: Record<string, string> = {
  '\u0060': '\u0060',
  '"': '"',
  '<': '>',
  '{': '}',
  '[': ']',
  '(': ')',
  "'": "'",
}

/** One delimited span of the prompt. */
interface DelimitedSpan {
  readonly start: number
  readonly end: number
}

/** One accepted keyword occurrence. */
export interface UltraKeywordMatch {
  readonly word: string
  readonly start: number
  readonly end: number
}

/**
 * Join the text blocks of one logged message.
 * @param blocks - content blocks, when the caller has any.
 * @returns the concatenated text.
 */
export function textOfBlocks(blocks: readonly UltraContentBlock[] | undefined): string {
  return (blocks ?? []).map(block => (block.type === 'text' ? block.text ?? '' : '')).join('')
}

/** Whether one character can continue a word. */
function isWordCharacter(character: string | undefined): boolean {
  return character !== undefined && /[\p{L}\p{N}_]/u.test(character)
}

/** Collect the spans whose interior a keyword must not fall inside. */
function delimitedSpans(text: string): DelimitedSpan[] {
  const spans: DelimitedSpan[] = []
  let open: string | undefined
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] as string
    if (open !== undefined) {
      if (open === '[' && character === '[') {
        start = index
        continue
      }
      if (character !== DELIMITERS[open]) continue
      if (open === "'" && isWordCharacter(text[index + 1])) continue
      spans.push({ start, end: index + 1 })
      open = undefined
      continue
    }
    const opensAngle = character === '<' && index + 1 < text.length && /[a-zA-Z/]/.test(text[index + 1] as string)
    const opensApostrophe = character === "'" && !isWordCharacter(text[index - 1])
    const opensPair = character !== '<' && character !== "'" && character in DELIMITERS
    if (opensAngle || opensApostrophe || opensPair) {
      open = character
      start = index
    }
  }
  return spans
}

/**
 * Find every occurrence of one ultra keyword that Claude would honor.
 * @param text - the prompt as typed, before slash-command or skill expansion.
 * @param word - the keyword to look for.
 * @returns the accepted occurrences, in order.
 */
export function findUltraKeyword(text: string, word: string): readonly UltraKeywordMatch[] {
  if (!new RegExp(word, 'i').test(text)) return []
  if (text.startsWith('/')) return []
  const spans = delimitedSpans(text)
  const found: UltraKeywordMatch[] = []
  for (const match of text.matchAll(new RegExp('\\b' + word + '\\b', 'gi'))) {
    const start = match.index
    const end = start + match[0].length
    if (spans.some(span => start >= span.start && start < span.end)) continue
    const before = text[start - 1]
    const after = text[end]
    if (before === '/' || before === '\\' || before === '-') continue
    if (after === '/' || after === '\\' || after === '-' || after === '?') continue
    if (after === '.' && isWordCharacter(text[end + 1])) continue
    found.push({ word: match[0], start, end })
  }
  return found
}

/**
 * Whether one prompt opts its turn into multi-agent orchestration.
 * @param text - the prompt as typed.
 * @returns whether Claude's ultracode keyword is present.
 */
export function hasUltraKeyword(text: string): boolean {
  return findUltraKeyword(text, 'ultracode').length > 0
}

/**
 * Whether one prompt asks for deeper reasoning on its turn.
 * @param text - the prompt as typed.
 * @returns whether Claude's ultrathink keyword is present.
 */
export function hasUltrathinkKeyword(text: string): boolean {
  return findUltraKeyword(text, 'ultrathink').length > 0
}
