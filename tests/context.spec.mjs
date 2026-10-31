import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  apply,
  createClaudeUltraArmStore,
  resolveClaudeUltraReminder,
  SUBAGENT_USAGE_HINT,
  ULTRA_ENTER_FULL,
  ULTRA_EXIT,
  usageHintFor,
} from '../lib/index.js'

const KEY = 'claudeUltraMode'
const SECTION = 'claude-ultra:mode'
const ARM = { provider: 'acme', model: 'astra', effort: 'max' }

/** The selection the next request will use. */
function selection(overrides = {}) {
  return { provider: 'acme', model: 'astra', reasoningEffort: 'max', ...overrides }
}

/** One agent as this plugin reads it. */
function agent(id, options = {}) {
  const config = options.config
  return {
    session: {
      id,
      header: options.header ?? {},
      requestHeader: () => (config === undefined ? undefined : { config }),
    },
  }
}

/**
 * A Host context carrying only what this plugin reads. states maps a session id
 * to its projections; listeners collects the registered event listeners.
 */
function context(options = {}) {
  const states = options.states ?? {}
  const agents = options.agents ?? {}
  const listeners = new Map()
  return {
    effect(callback) { return callback() },
    on(event, listener) {
      const registered = listeners.get(event) ?? []
      registered.push(listener)
      listeners.set(event, registered)
      return () => {}
    },
    logger: { warn() {} },
    sessionProjections: {
      register: () => () => {},
      stateOf: (session, key) => states[session.id]?.[key],
    },
    sessions: { get: () => undefined },
    llm: {
      resolveModelInfo: async () => ({}),
      resolveCallConfig: async (request) => request,
    },
    agents: { get: (id) => agents[id] },
    connection: { fetch: { register: () => () => {} } },
    listeners,
  }
}

function armsWith(entries = {}) {
  const arms = createClaudeUltraArmStore()
  for (const [sessionId, record] of Object.entries(entries)) arms.set(sessionId, record)
  return arms
}

function modeState(mode, dirty) {
  return { [KEY]: { mode, dirty } }
}

test('an unarmed root agent with no snapshot has no reminder', () => {
  assert.equal(resolveClaudeUltraReminder(context(), agent('root'), createClaudeUltraArmStore()), null)
})

test('an arm matching the next selection materializes the full entry', () => {
  const ctx = context()
  const root = agent('root', { config: selection() })
  assert.equal(resolveClaudeUltraReminder(ctx, root, armsWith({ root: ARM })), 'full')
})

test('an arm matching while Ultra is already on materializes the repeat reminder', () => {
  const ctx = context({ states: { root: modeState('full', false) } })
  const root = agent('root', { config: selection() })
  assert.equal(resolveClaudeUltraReminder(ctx, root, armsWith({ root: ARM })), 'still')
})

test('an arm that does not match the selection is ignored', () => {
  const ctx = context()
  const root = agent('root', { config: selection({ model: 'sol' }) })
  assert.equal(resolveClaudeUltraReminder(ctx, root, armsWith({ root: ARM })), null)
})

test('a selection after an entry snapshot materializes the exit reminder', () => {
  const ctx = context({ states: { root: modeState('full', true) } })
  assert.equal(resolveClaudeUltraReminder(ctx, agent('root'), createClaudeUltraArmStore()), 'off')
})

test('a snapshot that already records the exit keeps it standing', () => {
  const ctx = context({ states: { root: modeState('off', false) } })
  assert.equal(resolveClaudeUltraReminder(ctx, agent('root'), createClaudeUltraArmStore()), 'off')
})

test('a repeat snapshot without an arm keeps repeating', () => {
  const ctx = context({ states: { root: modeState('still', false) } })
  assert.equal(resolveClaudeUltraReminder(ctx, agent('root'), createClaudeUltraArmStore()), 'still')
})

test('the pending model selection is read from the projection', () => {
  const ctx = context({ states: { root: { modelSelection: { pending: selection() } } } })
  const root = agent('root', { config: selection({ model: 'sol' }) })
  assert.equal(resolveClaudeUltraReminder(ctx, root, armsWith({ root: ARM })), 'full')
})

test('the last used model selection stands in when nothing is pending', () => {
  const ctx = context({ states: { root: { modelSelection: { lastUsed: selection() } } } })
  const root = agent('root', { config: selection({ model: 'sol' }) })
  assert.equal(resolveClaudeUltraReminder(ctx, root, armsWith({ root: ARM })), 'full')
})

test('without a selection projection the logged request header is the fallback', () => {
  const ctx = context()
  const root = agent('root', { config: selection() })
  assert.equal(resolveClaudeUltraReminder(ctx, root, armsWith({ root: ARM })), 'full')
})

test('a subagent inherits a matching arm from its parent', () => {
  const child = agent('child', { header: { origin: 'subagent', parentSession: 'parent' }, config: selection() })
  const ctx = context({ agents: { parent: agent('parent', { config: selection() }) } })
  assert.equal(resolveClaudeUltraReminder(ctx, child, armsWith({ parent: ARM })), 'full')
})

test('a subagent of an active parent starts with the full entry', () => {
  const child = agent('child', { header: { origin: 'subagent', parentSession: 'parent' } })
  const ctx = context({ states: { parent: modeState('still', false) }, agents: { parent: agent('parent') } })
  assert.equal(resolveClaudeUltraReminder(ctx, child, createClaudeUltraArmStore()), 'full')
})

test('a subagent of a parent that already left Ultra has no reminder', () => {
  const child = agent('child', { header: { origin: 'subagent', parentSession: 'parent' } })
  const ctx = context({ states: { parent: modeState('full', true) }, agents: { parent: agent('parent') } })
  assert.equal(resolveClaudeUltraReminder(ctx, child, createClaudeUltraArmStore()), null)
})

test('a subagent with no parent header has no reminder', () => {
  const child = agent('child', { header: { origin: 'subagent' } })
  assert.equal(resolveClaudeUltraReminder(context(), child, createClaudeUltraArmStore()), null)
})

test('a subagent whose parent session is not live has no reminder', () => {
  const child = agent('child', { header: { origin: 'subagent', parentSession: 'parent' } })
  assert.equal(resolveClaudeUltraReminder(context(), child, createClaudeUltraArmStore()), null)
})

test('a subagent with its own exit snapshot does not inherit the parent', () => {
  const child = agent('child', { header: { origin: 'subagent', parentSession: 'parent' } })
  const ctx = context({
    states: { child: modeState('off', false), parent: modeState('full', false) },
    agents: { parent: agent('parent') },
  })
  assert.equal(resolveClaudeUltraReminder(ctx, child, createClaudeUltraArmStore()), 'off')
})

/** Mount the plugin and return its system-prompt listener. */
function mount(options = {}) {
  const ctx = context(options)
  apply(ctx)
  const registered = ctx.listeners.get('system-prompt/assemble')
  assert.ok(Array.isArray(registered), 'the plugin registered no assemble listener')
  assert.equal(registered.length, 1)
  return registered[0]
}

/** Run one assembly with a counting next(). */
async function assemble(listener, upstream, assembleContext) {
  const counter = { next: 0 }
  const result = await listener(upstream, assembleContext, async () => {
    counter.next += 1
    return upstream
  })
  return { result, counter }
}

test('the assembly listener delegates upstream and appends one Ultra section', async () => {
  const listener = mount({ states: { root: modeState('full', false) } })
  const upstream = { sections: [{ name: 'base', text: 'base' }] }
  const { result, counter } = await assemble(listener, upstream, { agent: agent('root') })
  assert.equal(counter.next, 1)
  assert.equal(result.sections.length, 2)
  assert.equal(result.sections[0], upstream.sections[0])
  assert.equal(result.sections[1].name, SECTION)
  assert.equal(result.sections[1].text, usageHintFor(false) + '\n\n' + ULTRA_ENTER_FULL)
})

test('a subagent assembly carries the subagent usage hint', async () => {
  const child = agent('child', { header: { origin: 'subagent', parentSession: 'parent' } })
  const listener = mount({ states: { parent: modeState('full', false) }, agents: { parent: agent('parent') } })
  const { result } = await assemble(listener, { sections: [] }, { agent: child })
  assert.equal(result.sections.length, 1)
  assert.equal(result.sections[0].text, SUBAGENT_USAGE_HINT + '\n\n' + ULTRA_ENTER_FULL)
})

test('an exit assembly carries the exit reminder', async () => {
  const listener = mount({ states: { root: modeState('off', false) } })
  const { result } = await assemble(listener, { sections: [] }, { agent: agent('root') })
  assert.equal(result.sections.length, 1)
  assert.equal(result.sections[0].text, usageHintFor(false) + '\n\n' + ULTRA_EXIT)
})

test('an assembly with no agent is returned unchanged', async () => {
  const listener = mount()
  const upstream = { sections: [{ name: 'base', text: 'base' }] }
  const { result, counter } = await assemble(listener, upstream, {})
  assert.equal(counter.next, 1)
  assert.equal(result, upstream)
})

test('an inactive Ultra mode leaves the assembly unchanged', async () => {
  const listener = mount()
  const upstream = { sections: [{ name: 'base', text: 'base' }] }
  const { result, counter } = await assemble(listener, upstream, { agent: agent('root') })
  assert.equal(counter.next, 1)
  assert.equal(result, upstream)
})
