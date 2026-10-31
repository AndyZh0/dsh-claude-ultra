import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ROOT_USAGE_HINT,
  SUBAGENT_USAGE_HINT,
  ULTRATHINK_EFFORT,
  ULTRA_ENTER_FULL,
  ULTRA_ENTER_STILL,
  ULTRA_EXIT,
  ULTRA_KEYWORD_REQUEST,
  usageHintFor,
} from '../lib/index.js'

// These literals are Claude Code 2.1.316's own ultracode text. They are pinned
// verbatim so a later edit cannot silently reword what the model reads.

test('the full entry reminder is Claude wording with the DSH tools named', () => {
  assert.equal(ULTRA_ENTER_FULL, "Ultracode is on: optimize for the most exhaustive, correct answer — not the fastest or cheapest. Use the 'subagent' and 'subagent_fork' tools on every substantive task; token cost is not a constraint. See the **Ultracode** section and quality patterns in the DSH agent-team usage notes below. Solo only on conversational/trivial turns.")
})

test('the entry reminder no longer names a tool DSH does not have', () => {
  assert.equal(ULTRA_ENTER_FULL.includes('the Workflow tool'), false)
})

test('the repeat reminder is Claude wording with the DSH tools named', () => {
  assert.equal(ULTRA_ENTER_STILL, "Ultracode is still on — use the 'subagent' and 'subagent_fork' tools; see the Ultracode section of the DSH agent-team usage notes below.")
})

test('the exit reminder is Claude wording', () => {
  assert.equal(ULTRA_EXIT, "Ultracode is off — the standard opt-in rule for multi-agent delegation applies again. Only delegate when the user has explicitly asked for sub-agents, delegation, or parallel agent work; a task that would merely benefit from parallelism does not count.")
})

test('the ultracode keyword reminder is pinned even though this plugin does not emit it', () => {
  assert.equal(ULTRA_KEYWORD_REQUEST, "The user included the keyword \"ultracode\", opting this turn into multi-agent orchestration — use the 'subagent' and 'subagent_fork' tools to fulfill the request.")
})

test('the ultrathink reminder is pinned even though this plugin does not emit it', () => {
  assert.equal(ULTRATHINK_EFFORT, "The user included the keyword \"ultrathink\", requesting deeper reasoning on this turn. Reason as thoroughly as the task warrants.")
})

test('the root usage hint names every DSH delegation tool', () => {
  for (const tool of ['subagent', 'subagent_fork', 'send_message', 'list_agents', 'interrupt_agent']) {
    assert.ok(ROOT_USAGE_HINT.includes(tool), 'root hint is missing ' + tool)
  }
})

test('the subagent usage hint names every DSH delegation tool', () => {
  for (const tool of ['subagent', 'subagent_fork', 'send_message', 'list_agents', 'interrupt_agent']) {
    assert.ok(SUBAGENT_USAGE_HINT.includes(tool), 'subagent hint is missing ' + tool)
  }
})

test('the two usage hints are different texts', () => {
  assert.notEqual(ROOT_USAGE_HINT, SUBAGENT_USAGE_HINT)
  assert.ok(ROOT_USAGE_HINT.length > 0)
  assert.ok(SUBAGENT_USAGE_HINT.length > 0)
})

test('usageHintFor selects the hint matching the speaking agent', () => {
  assert.equal(usageHintFor(false), ROOT_USAGE_HINT)
  assert.equal(usageHintFor(true), SUBAGENT_USAGE_HINT)
})
