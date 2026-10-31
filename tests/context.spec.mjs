import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  apply,
  applyClaudeUltraModeProjection,
  CLAUDE_ULTRA_KEYWORD_SECTION,
  CLAUDE_ULTRA_ULTRATHINK_SECTION,
  createClaudeUltraArmStore,
  createClaudeUltraBoostStore,
  createClaudeUltraKeywordStore,
  EMPTY_CLAUDE_ULTRA_MODE_STATE,
  registerClaudeUltraKeywordCapture,
  resolveClaudeUltraReminder,
  SUBAGENT_USAGE_HINT,
  ULTRATHINK_EFFORT,
  ULTRA_ENTER_FULL,
  ULTRA_ENTER_STILL,
  ULTRA_EXIT,
  ULTRA_KEYWORD_REQUEST,
  usageHintFor,
} from '../lib/index.js'

const KEY = 'claudeUltraMode'
const SECTION = 'claude-ultra:mode'
const KEYWORD_SECTION = 'claude-ultra:keyword'
const ULTRATHINK_SECTION = 'claude-ultra:ultrathink'
const ARM = { provider: 'acme', model: 'astra', effort: 'max' }
// The shipped repeat interval, pinned here so a change to ULTRA_SPARSE_INTERVAL
// in src/prompts.ts fails this suite instead of silently re-timing the reminder.
const SPARSE_INTERVAL = 10

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

/** One inbox message as the capture listener reads it. */
function inboxMessage(texts, source) {
  const message = { content: texts.map(text => ({ type: 'text', text })) }
  if (source !== undefined) message.source = source
  return message
}

/** The source of a message the human typed. */
const TYPED = { kind: 'user' }

/**
 * A Host context carrying only what this plugin reads. states maps a session id
 * to its projections; listeners collects the registered event listeners.
 */
function context(options = {}) {
  const states = options.states ?? {}
  const agents = options.agents ?? {}
  const listeners = new Map()
  const warnings = []
  const modelInfoCalls = []
  const routes = []
  const selectCalls = []
  // A test passes sessionController to control the optional service: undefined
  // stands for a composition without it, {} for one that does not serve it.
  const controller = 'sessionController' in options
    ? options.sessionController
    : {
      selectModel: async (selection) => {
        selectCalls.push(selection)
        if (options.selectModelError !== undefined) throw options.selectModelError
      },
    }
  return {
    effect(callback) { return callback() },
    on(event, listener) {
      const registered = listeners.get(event) ?? []
      registered.push(listener)
      listeners.set(event, registered)
      return () => {
        const index = registered.indexOf(listener)
        if (index >= 0) registered.splice(index, 1)
      }
    },
    emit(event, ...args) {
      return (listeners.get(event) ?? []).map(listener => listener(...args))
    },
    logger: { warn(message) { warnings.push(message) } },
    sessionProjections: {
      register: () => () => {},
      stateOf: (session, key) => states[session.id]?.[key],
    },
    sessions: { get: (id) => ({ id }) },
    llm: {
      resolveModelInfo: async (provider, model) => {
        modelInfoCalls.push({ provider, model })
        if (options.modelInfoError !== undefined) throw options.modelInfoError
        return options.modelInfo ?? {}
      },
      resolveCallConfig: async (request) => request,
    },
    agents: { get: (id) => agents[id] },
    connection: { fetch: { register(candidate) { routes.push(candidate); return () => {} } } },
    get: (name) => (name === 'sessionController' ? controller : undefined),
    listeners,
    warnings,
    modelInfoCalls,
    routes,
    selectCalls,
  }
}

function armsWith(entries = {}) {
  const arms = createClaudeUltraArmStore()
  for (const [sessionId, record] of Object.entries(entries)) arms.set(sessionId, record)
  return arms
}

function modeState(mode, dirty, prompts = 0, markerAt = 0) {
  return { [KEY]: { mode, dirty, prompts, markerAt } }
}

// --- resolveClaudeUltraReminder ---------------------------------------------

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

test('an exit snapshot does not repeat the exit reminder', () => {
  const ctx = context({ states: { root: modeState('off', false) } })
  assert.equal(resolveClaudeUltraReminder(ctx, agent('root'), createClaudeUltraArmStore()), null)
})

test('a repeat snapshot below the interval keeps quiet', () => {
  const ctx = context({ states: { root: modeState('still', false) } })
  assert.equal(resolveClaudeUltraReminder(ctx, agent('root'), createClaudeUltraArmStore()), null)
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

test('a subagent whose own snapshot left Ultra still inherits an active parent', () => {
  // The subagent branch runs whenever the child's own snapshot is not entering,
  // and it does not ask whether that snapshot recorded an exit.
  const child = agent('child', { header: { origin: 'subagent', parentSession: 'parent' } })
  const ctx = context({
    states: { child: modeState('off', false), parent: modeState('full', false) },
    agents: { parent: agent('parent') },
  })
  assert.equal(resolveClaudeUltraReminder(ctx, child, createClaudeUltraArmStore()), 'full')
})

// --- the keyword store ------------------------------------------------------

test('the keyword store reports false for a session it has never seen', () => {
  assert.equal(createClaudeUltraKeywordStore().get('session-1'), false)
})

test('the keyword store records one session and reports it back', () => {
  const keywords = createClaudeUltraKeywordStore()
  keywords.set('session-1', true)
  assert.equal(keywords.get('session-1'), true)
  keywords.set('session-1', false)
  assert.equal(keywords.get('session-1'), false)
})

test('the keyword store is per session', () => {
  const keywords = createClaudeUltraKeywordStore()
  keywords.set('session-1', true)
  assert.equal(keywords.get('session-2'), false)
})

test('the keyword store forgets a cleared session', () => {
  const keywords = createClaudeUltraKeywordStore()
  keywords.set('session-1', true)
  keywords.clear('session-1')
  assert.equal(keywords.get('session-1'), false)
})

test('clearing a session the keyword store has never seen is a no-op', () => {
  const keywords = createClaudeUltraKeywordStore()
  keywords.set('session-1', true)
  keywords.clear('session-2')
  assert.equal(keywords.get('session-1'), true)
  assert.equal(keywords.get('session-2'), false)
})

// --- the boost store --------------------------------------------------------

test('the boost store reports false for a session it has never seen', () => {
  assert.equal(createClaudeUltraBoostStore().get('session-1'), false)
})

test('the boost store records one session and reports it back', () => {
  const boosts = createClaudeUltraBoostStore()
  boosts.set('session-1', true)
  assert.equal(boosts.get('session-1'), true)
  boosts.set('session-1', false)
  assert.equal(boosts.get('session-1'), false)
})

test('the boost store is per session', () => {
  const boosts = createClaudeUltraBoostStore()
  boosts.set('session-1', true)
  assert.equal(boosts.get('session-2'), false)
})

test('the boost store forgets a cleared session', () => {
  const boosts = createClaudeUltraBoostStore()
  boosts.set('session-1', true)
  boosts.clear('session-1')
  assert.equal(boosts.get('session-1'), false)
})

test('clearing a session the boost store has never seen is a no-op', () => {
  const boosts = createClaudeUltraBoostStore()
  boosts.set('session-1', true)
  boosts.clear('session-2')
  assert.equal(boosts.get('session-1'), true)
  assert.equal(boosts.get('session-2'), false)
})

// --- the inbox capture listener ---------------------------------------------

/** Register the capture hooks over a fresh store. */
function capture(options = {}) {
  const ctx = context(options)
  const keywords = createClaudeUltraKeywordStore()
  const boosts = createClaudeUltraBoostStore()
  const dispose = registerClaudeUltraKeywordCapture(ctx, keywords, boosts)
  const inserted = ctx.listeners.get('agent/inbox/inserted')
  assert.ok(Array.isArray(inserted), 'the capture registered no inbox listener')
  assert.equal(inserted.length, 1)
  const insert = (sessionId, message) => inserted[0]({ agent: agent(sessionId), message })
  const preStep = async (sessionId, messages, next, turn = 1) => {
    const results = ctx.emit('agent/pre-step', { agent: agent(sessionId), messages, turn }, next)
    assert.equal(results.length, 1, 'the capture registered no pre-step listener')
    return await results[0]
  }
  return { ctx, keywords, boosts, insert, preStep, dispose }
}

test('a typed prompt carrying the keyword records the opt-in', () => {
  const { keywords, insert } = capture()
  insert('session-1', inboxMessage(['please ultracode this'], TYPED))
  assert.equal(keywords.get('session-1'), true)
})

test('a typed prompt without the keyword records the opt-in as off', () => {
  const { keywords, insert } = capture()
  insert('session-1', inboxMessage(['just a question'], TYPED))
  assert.equal(keywords.get('session-1'), false)
})

test('a later typed prompt without the keyword clears the opt-in', () => {
  const { keywords, insert } = capture()
  insert('session-1', inboxMessage(['please ultracode this'], TYPED))
  assert.equal(keywords.get('session-1'), true)
  insert('session-1', inboxMessage(['and now something else'], TYPED))
  assert.equal(keywords.get('session-1'), false)
})

test('the opt-in is read out of the text blocks of the prompt', () => {
  const { keywords, insert } = capture()
  insert('session-1', inboxMessage(['please ultra', 'code this'], TYPED))
  assert.equal(keywords.get('session-1'), true)
})

test('a prompt whose keyword sits in a delimited span is not an opt-in', () => {
  const { keywords, insert } = capture()
  insert('session-1', inboxMessage(['run \u0060ultracode\u0060 now'], TYPED))
  assert.equal(keywords.get('session-1'), false)
})

test('a prompt that starts with a slash command is not an opt-in', () => {
  const { keywords, insert } = capture()
  insert('session-1', inboxMessage(['/ultracode'], TYPED))
  assert.equal(keywords.get('session-1'), false)
})

test('a message the human did not type leaves the opt-in untouched', () => {
  for (const kind of ['runtime-context', 'skill-catalog', 'time-context']) {
    const { keywords, insert } = capture()
    keywords.set('session-1', true)
    insert('session-1', inboxMessage(['please ultracode this'], { kind }))
    assert.equal(keywords.get('session-1'), true, kind + ' cleared the opt-in')
    assert.equal(keywords.get('session-2'), false, kind + ' set the opt-in')
  }
})

test('a message the human did not type does not turn the opt-in on', () => {
  const { keywords, insert } = capture()
  insert('session-1', inboxMessage(['please ultracode this'], { kind: 'runtime-context' }))
  assert.equal(keywords.get('session-1'), false)
})

test('a message with no source leaves the opt-in untouched', () => {
  const { keywords, insert } = capture()
  keywords.set('session-1', true)
  insert('session-1', inboxMessage(['please ultracode this']))
  assert.equal(keywords.get('session-1'), true)
  assert.equal(keywords.get('session-2'), false)
})

test('a message with an empty source leaves the opt-in untouched', () => {
  const { keywords, insert } = capture()
  keywords.set('session-1', true)
  insert('session-1', inboxMessage(['please ultracode this'], {}))
  assert.equal(keywords.get('session-1'), true)
})

test('the capture records each session separately', () => {
  const { keywords, insert } = capture()
  insert('session-1', inboxMessage(['please ultracode this'], TYPED))
  insert('session-2', inboxMessage(['nothing here'], TYPED))
  assert.equal(keywords.get('session-1'), true)
  assert.equal(keywords.get('session-2'), false)
})

test('ultracode alone records the opt-in and no boost', () => {
  const { keywords, boosts, insert } = capture()
  insert('session-1', inboxMessage(['please ultracode this'], TYPED))
  assert.equal(keywords.get('session-1'), true)
  assert.equal(boosts.get('session-1'), false)
})

test('ultrathink alone records the boost and no opt-in', () => {
  const { keywords, boosts, insert } = capture()
  insert('session-1', inboxMessage(['please ultrathink about this'], TYPED))
  assert.equal(keywords.get('session-1'), false)
  assert.equal(boosts.get('session-1'), true)
})

test('both keywords record both', () => {
  const { keywords, boosts, insert } = capture()
  insert('session-1', inboxMessage(['ultracode and ultrathink'], TYPED))
  assert.equal(keywords.get('session-1'), true)
  assert.equal(boosts.get('session-1'), true)
})

test('a later prompt with neither keyword clears both', () => {
  const { keywords, boosts, insert } = capture()
  insert('session-1', inboxMessage(['ultracode and ultrathink'], TYPED))
  insert('session-1', inboxMessage(['and now nothing at all'], TYPED))
  assert.equal(keywords.get('session-1'), false)
  assert.equal(boosts.get('session-1'), false)
})

test('the boost is read out of the text blocks of the prompt', () => {
  const { boosts, insert } = capture()
  insert('session-1', inboxMessage(['please ultra', 'think about this'], TYPED))
  assert.equal(boosts.get('session-1'), true)
})

test('a delimited ultrathink still boosts', () => {
  const { boosts, insert } = capture()
  insert('session-1', inboxMessage(['run `ultrathink` now'], TYPED))
  assert.equal(boosts.get('session-1'), true)
})

test('a slash-prefixed ultrathink still boosts', () => {
  const { boosts, insert } = capture()
  insert('session-1', inboxMessage(['/ultrathink'], TYPED))
  assert.equal(boosts.get('session-1'), true)
})

test('an inflected ultrathink does not boost', () => {
  const { boosts, insert } = capture()
  insert('session-1', inboxMessage(['ultrathinks about it'], TYPED))
  assert.equal(boosts.get('session-1'), false)
})

test('the capture reads the loose matcher for ultrathink and the strict one for ultracode', () => {
  const { keywords, boosts, insert } = capture()
  insert('session-1', inboxMessage(['run `ultracode` and ultrathink'], TYPED))
  assert.equal(keywords.get('session-1'), false)
  assert.equal(boosts.get('session-1'), true)
})

test('ultracode does not boost and ultrathink does not opt in', () => {
  const { keywords, boosts, insert } = capture()
  insert('session-1', inboxMessage(['ultracode'], TYPED))
  assert.equal(keywords.get('session-1'), true)
  assert.equal(boosts.get('session-1'), false)
  insert('session-2', inboxMessage(['ultrathink'], TYPED))
  assert.equal(keywords.get('session-2'), false)
  assert.equal(boosts.get('session-2'), true)
})

test('a message the human did not type leaves both stores untouched', () => {
  for (const kind of ['runtime-context', 'skill-catalog', 'time-context']) {
    const { keywords, boosts, insert } = capture()
    keywords.set('session-1', true)
    boosts.set('session-1', true)
    insert('session-1', inboxMessage(['ultracode and ultrathink'], { kind }))
    assert.equal(keywords.get('session-1'), true, kind + ' cleared the opt-in')
    assert.equal(boosts.get('session-1'), true, kind + ' cleared the boost')
    assert.equal(keywords.get('session-2'), false, kind + ' set the opt-in')
    assert.equal(boosts.get('session-2'), false, kind + ' set the boost')
  }
})

test('a message with no source leaves both stores untouched', () => {
  const { keywords, boosts, insert } = capture()
  keywords.set('session-1', true)
  boosts.set('session-1', true)
  insert('session-1', inboxMessage(['ultracode and ultrathink']))
  assert.equal(keywords.get('session-1'), true)
  assert.equal(boosts.get('session-1'), true)
})

test('a step that claimed a typed prompt leaves the boost standing', async () => {
  // The boost covers every step of its turn, so the pre-step clear is the
  // opt-in's alone; agent/request consumes the boost and turn/end clears it.
  const { boosts, insert, preStep } = capture()
  insert('session-1', inboxMessage(['ultrathink'], TYPED))
  await preStep('session-1', [inboxMessage(['ultrathink'], TYPED)], async () => 'upstream')
  assert.equal(boosts.get('session-1'), true)
})

test('a step that claimed a typed prompt clears the opt-in', async () => {
  const { keywords, insert, preStep } = capture()
  insert('session-1', inboxMessage(['please ultracode this'], TYPED))
  assert.equal(keywords.get('session-1'), true)
  await preStep('session-1', [inboxMessage(['please ultracode this'], TYPED)], async () => 'upstream')
  assert.equal(keywords.get('session-1'), false)
})

test('a step whose messages are all runtime context leaves the opt-in standing', async () => {
  const { keywords, insert, preStep } = capture()
  insert('session-1', inboxMessage(['please ultracode this'], TYPED))
  await preStep('session-1', [inboxMessage(['context'], { kind: 'runtime-context' })], async () => 'upstream')
  assert.equal(keywords.get('session-1'), true)
})

test('a step with no messages leaves the opt-in standing', async () => {
  const { keywords, insert, preStep } = capture()
  insert('session-1', inboxMessage(['please ultracode this'], TYPED))
  await preStep('session-1', [], async () => 'upstream')
  assert.equal(keywords.get('session-1'), true)
})

test('a step that claimed a typed prompt only clears its own session', async () => {
  const { keywords, insert, preStep } = capture()
  insert('session-1', inboxMessage(['please ultracode this'], TYPED))
  insert('session-2', inboxMessage(['please ultracode this'], TYPED))
  await preStep('session-1', [inboxMessage(['please ultracode this'], TYPED)], async () => 'upstream')
  assert.equal(keywords.get('session-1'), false)
  assert.equal(keywords.get('session-2'), true)
})

test('the pre-step listener delegates upstream and returns its result', async () => {
  const { preStep } = capture()
  const upstream = { ok: true }
  let calls = 0
  const result = await preStep('session-1', [], async () => {
    calls += 1
    return upstream
  })
  assert.equal(calls, 1)
  assert.equal(result, upstream)
})

test('disposing the capture removes both listeners', () => {
  const { ctx, dispose } = capture()
  assert.equal((ctx.listeners.get('agent/inbox/inserted') ?? []).length, 1)
  assert.equal((ctx.listeners.get('agent/pre-step') ?? []).length, 1)
  dispose()
  assert.equal((ctx.listeners.get('agent/inbox/inserted') ?? []).length, 0)
  assert.equal((ctx.listeners.get('agent/pre-step') ?? []).length, 0)
})

// --- the assembled sections -------------------------------------------------

/** Mount the plugin and return its system-prompt listener. */
function mount(options = {}) {
  const ctx = context(options)
  apply(ctx)
  const registered = ctx.listeners.get('system-prompt/assemble')
  assert.ok(Array.isArray(registered), 'the plugin registered no assemble listener')
  assert.equal(registered.length, 1)
  return { ctx, listener: registered[0] }
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

/** Splice one message into the session's inbox, as the composer does. */
function insert(ctx, sessionId, message) {
  const dispatched = ctx.emit('agent/inbox/inserted', { agent: agent(sessionId), message })
  assert.equal(dispatched.length, 1, 'the plugin registered no inbox listener')
}

test('the assembly listener delegates upstream and appends one Ultra section', async () => {
  const { listener } = mount({ states: { root: modeState('still', false, SPARSE_INTERVAL, 0) } })
  const upstream = { sections: [{ name: 'base', text: 'base' }] }
  const { result, counter } = await assemble(listener, upstream, { agent: agent('root') })
  assert.equal(counter.next, 1)
  assert.equal(result.sections.length, 2)
  assert.equal(result.sections[0], upstream.sections[0])
  assert.equal(result.sections[1].name, SECTION)
  assert.equal(result.sections[1].text, usageHintFor(false) + '\n\n' + ULTRA_ENTER_STILL)
})

test('an assembly below the repeat interval appends nothing', async () => {
  const { listener } = mount({ states: { root: modeState('still', false, SPARSE_INTERVAL - 1, 0) } })
  const upstream = { sections: [{ name: 'base', text: 'base' }] }
  const { result, counter } = await assemble(listener, upstream, { agent: agent('root') })
  assert.equal(counter.next, 1)
  assert.equal(result, upstream)
})

test('a subagent assembly carries the subagent usage hint', async () => {
  const child = agent('child', { header: { origin: 'subagent', parentSession: 'parent' } })
  const { listener } = mount({ states: { parent: modeState('full', false) }, agents: { parent: agent('parent') } })
  const { result } = await assemble(listener, { sections: [] }, { agent: child })
  assert.equal(result.sections.length, 1)
  assert.equal(result.sections[0].text, SUBAGENT_USAGE_HINT + '\n\n' + ULTRA_ENTER_FULL)
})

test('an exit assembly carries the exit reminder', async () => {
  const { listener } = mount({ states: { root: modeState('full', true) } })
  const { result } = await assemble(listener, { sections: [] }, { agent: agent('root') })
  assert.equal(result.sections.length, 1)
  assert.equal(result.sections[0].text, usageHintFor(false) + '\n\n' + ULTRA_EXIT)
})

test('an assembly with no agent is returned unchanged', async () => {
  const { listener } = mount()
  const upstream = { sections: [{ name: 'base', text: 'base' }] }
  const { result, counter } = await assemble(listener, upstream, {})
  assert.equal(counter.next, 1)
  assert.equal(result, upstream)
})

test('an inactive Ultra mode leaves the assembly unchanged', async () => {
  const { listener } = mount()
  const upstream = { sections: [{ name: 'base', text: 'base' }] }
  const { result, counter } = await assemble(listener, upstream, { agent: agent('root') })
  assert.equal(counter.next, 1)
  assert.equal(result, upstream)
})

test('an empty snapshot leaves the assembly unchanged', async () => {
  const { listener } = mount({ states: { root: modeState(null, false) } })
  const upstream = { sections: [{ name: 'base', text: 'base' }] }
  const { result, counter } = await assemble(listener, upstream, { agent: agent('root') })
  assert.equal(counter.next, 1)
  assert.equal(result, upstream)
})

test('a typed prompt alone appends only the keyword section', async () => {
  const { ctx, listener } = mount()
  const upstream = { sections: [{ name: 'base', text: 'base' }] }
  insert(ctx, 'root', inboxMessage(['please ultracode this'], TYPED))
  const { result, counter } = await assemble(listener, upstream, { agent: agent('root') })
  assert.equal(counter.next, 1)
  assert.equal(result.sections.length, 2)
  assert.equal(result.sections[0], upstream.sections[0])
  assert.equal(result.sections[1].name, KEYWORD_SECTION)
  assert.equal(result.sections[1].text, ULTRA_KEYWORD_REQUEST)
})

test('the keyword section carries the pinned keyword request text', async () => {
  const { ctx, listener } = mount()
  insert(ctx, 'root', inboxMessage(['please ultracode this'], TYPED))
  const { result } = await assemble(listener, { sections: [] }, { agent: agent('root') })
  assert.equal(result.sections.length, 1)
  assert.equal(result.sections[0].name, CLAUDE_ULTRA_KEYWORD_SECTION)
  assert.equal(result.sections[0].text, ULTRA_KEYWORD_REQUEST)
})

test('a standing reminder and a typed prompt append two sections, mode first', async () => {
  const { ctx, listener } = mount({ states: { root: modeState('still', false, SPARSE_INTERVAL, 0) } })
  const upstream = { sections: [{ name: 'base', text: 'base' }] }
  insert(ctx, 'root', inboxMessage(['please ultracode this'], TYPED))
  const { result, counter } = await assemble(listener, upstream, { agent: agent('root') })
  assert.equal(counter.next, 1)
  assert.equal(result.sections.length, 3)
  assert.equal(result.sections[0], upstream.sections[0])
  assert.equal(result.sections[1].name, SECTION)
  assert.equal(result.sections[2].name, KEYWORD_SECTION)
  assert.equal(result.sections[1].text, usageHintFor(false) + '\n\n' + ULTRA_ENTER_STILL)
  assert.equal(result.sections[2].text, ULTRA_KEYWORD_REQUEST)
})

test('a subagent assembly carries both sections with the subagent hint', async () => {
  const child = agent('child', { header: { origin: 'subagent', parentSession: 'parent' } })
  const { ctx, listener } = mount({ states: { parent: modeState('still', false) }, agents: { parent: agent('parent') } })
  insert(ctx, 'child', inboxMessage(['please ultracode this'], TYPED))
  const { result, counter } = await assemble(listener, { sections: [] }, { agent: child })
  assert.equal(counter.next, 1)
  assert.equal(result.sections.length, 2)
  assert.equal(result.sections[0].name, SECTION)
  assert.equal(result.sections[0].text, SUBAGENT_USAGE_HINT + '\n\n' + ULTRA_ENTER_FULL)
  assert.equal(result.sections[1].name, KEYWORD_SECTION)
})

test('an opt-in recorded for another session is not appended', async () => {
  const { ctx, listener } = mount()
  insert(ctx, 'other', inboxMessage(['please ultracode this'], TYPED))
  const upstream = { sections: [] }
  const { result } = await assemble(listener, upstream, { agent: agent('root') })
  assert.equal(result, upstream)
})

test('a prompt the human did not type is not appended', async () => {
  const { ctx, listener } = mount()
  insert(ctx, 'root', inboxMessage(['please ultracode this'], { kind: 'runtime-context' }))
  const upstream = { sections: [] }
  const { result } = await assemble(listener, upstream, { agent: agent('root') })
  assert.equal(result, upstream)
})

test('the opt-in stands until a step claims the typed prompt', async () => {
  const { ctx, listener } = mount()
  const upstream = { sections: [] }
  insert(ctx, 'root', inboxMessage(['please ultracode this'], TYPED))
  const first = await assemble(listener, upstream, { agent: agent('root') })
  assert.equal(first.result.sections.length, 1)
  assert.equal(first.result.sections[0].name, KEYWORD_SECTION)
  const results = ctx.emit('agent/pre-step', { agent: agent('root'), messages: [inboxMessage(['please ultracode this'], TYPED)] }, async () => upstream)
  assert.equal(results.length, 1)
  await results[0]
  const second = await assemble(listener, upstream, { agent: agent('root') })
  assert.equal(second.result, upstream)
})

test('a turn boundary alone does not clear the opt-in', async () => {
  // Clearing at turn/end would drop the opt-in of a prompt the user queued
  // mid-turn, so the clear belongs to the step that consumed the prompt.
  const { ctx, listener } = mount()
  const upstream = { sections: [] }
  insert(ctx, 'root', inboxMessage(['please ultracode this'], TYPED))
  ctx.emit('session/event', { id: 'root' }, { type: 'turn/end', data: { turn: TURN } })
  const { result } = await assemble(listener, upstream, { agent: agent('root') })
  assert.equal(result.sections.length, 1)
  assert.equal(result.sections[0].name, KEYWORD_SECTION)
})

test('a step that claimed no typed prompt leaves the opt-in standing', async () => {
  const { ctx, listener } = mount()
  const upstream = { sections: [] }
  insert(ctx, 'root', inboxMessage(['please ultracode this'], TYPED))
  const results = ctx.emit('agent/pre-step', { agent: agent('root'), messages: [inboxMessage(['context'], { kind: 'runtime-context' })] }, async () => upstream)
  await results[0]
  const { result } = await assemble(listener, upstream, { agent: agent('root') })
  assert.equal(result.sections.length, 1)
  assert.equal(result.sections[0].name, KEYWORD_SECTION)
})

test('an unrelated session event leaves the opt-in standing', async () => {
  const { ctx, listener } = mount()
  const upstream = { sections: [] }
  insert(ctx, 'root', inboxMessage(['please ultracode this'], TYPED))
  ctx.emit('session/event', { id: 'root' }, { type: 'tool/call' })
  const { result } = await assemble(listener, upstream, { agent: agent('root') })
  assert.equal(result.sections.length, 1)
  assert.equal(result.sections[0].name, KEYWORD_SECTION)
})

test('disposing the agent forgets the opt-in', async () => {
  const { ctx, listener } = mount()
  const upstream = { sections: [] }
  insert(ctx, 'root', inboxMessage(['please ultracode this'], TYPED))
  ctx.emit('agent/disposed', { agent: agent('root') })
  const { result } = await assemble(listener, upstream, { agent: agent('root') })
  assert.equal(result, upstream)
})

// --- the ultrathink section -------------------------------------------------

test('a boost alone appends only the ultrathink section', async () => {
  const { ctx, listener } = mount()
  const upstream = { sections: [{ name: 'base', text: 'base' }] }
  insert(ctx, 'root', inboxMessage(['please ultrathink about this'], TYPED))
  const { result, counter } = await assemble(listener, upstream, { agent: agent('root') })
  assert.equal(counter.next, 1)
  assert.equal(result.sections.length, 2)
  assert.equal(result.sections[0], upstream.sections[0])
  assert.equal(result.sections[1].name, ULTRATHINK_SECTION)
  assert.equal(result.sections[1].text, ULTRATHINK_EFFORT)
})

test('the ultrathink section carries the pinned ultrathink text', async () => {
  const { ctx, listener } = mount()
  insert(ctx, 'root', inboxMessage(['ultrathink'], TYPED))
  const { result } = await assemble(listener, { sections: [] }, { agent: agent('root') })
  assert.equal(result.sections.length, 1)
  assert.equal(result.sections[0].name, CLAUDE_ULTRA_ULTRATHINK_SECTION)
  assert.equal(result.sections[0].text, ULTRATHINK_EFFORT)
})

test('all three conditions append mode, keyword, then ultrathink', async () => {
  const { ctx, listener } = mount({ states: { root: modeState('still', false, SPARSE_INTERVAL, 0) } })
  const upstream = { sections: [{ name: 'base', text: 'base' }] }
  insert(ctx, 'root', inboxMessage(['ultracode and ultrathink'], TYPED))
  const { result, counter } = await assemble(listener, upstream, { agent: agent('root') })
  assert.equal(counter.next, 1)
  assert.equal(result.sections.length, 4)
  assert.equal(result.sections[0], upstream.sections[0])
  assert.deepEqual(result.sections.slice(1).map(section => section.name), [SECTION, KEYWORD_SECTION, ULTRATHINK_SECTION])
  assert.equal(result.sections[1].text, usageHintFor(false) + '\n\n' + ULTRA_ENTER_STILL)
  assert.equal(result.sections[2].text, ULTRA_KEYWORD_REQUEST)
  assert.equal(result.sections[3].text, ULTRATHINK_EFFORT)
})

test('a subagent assembly carries all three sections with the subagent hint', async () => {
  const child = agent('child', { header: { origin: 'subagent', parentSession: 'parent' } })
  const { ctx, listener } = mount({ states: { parent: modeState('still', false) }, agents: { parent: agent('parent') } })
  insert(ctx, 'child', inboxMessage(['ultracode and ultrathink'], TYPED))
  const { result } = await assemble(listener, { sections: [] }, { agent: child })
  assert.deepEqual(result.sections.map(section => section.name), [SECTION, KEYWORD_SECTION, ULTRATHINK_SECTION])
  assert.equal(result.sections[0].text, SUBAGENT_USAGE_HINT + '\n\n' + ULTRA_ENTER_FULL)
})

test('a boost recorded for another session is not appended', async () => {
  const { ctx, listener } = mount()
  insert(ctx, 'other', inboxMessage(['ultrathink'], TYPED))
  const upstream = { sections: [] }
  const { result } = await assemble(listener, upstream, { agent: agent('root') })
  assert.equal(result, upstream)
})

test('a boost the human did not type is not appended', async () => {
  const { ctx, listener } = mount()
  insert(ctx, 'root', inboxMessage(['ultrathink'], { kind: 'runtime-context' }))
  const upstream = { sections: [] }
  const { result } = await assemble(listener, upstream, { agent: agent('root') })
  assert.equal(result, upstream)
})

test('with no mode, no keyword and no boost the assembly is the identical upstream', async () => {
  const { ctx, listener } = mount()
  const upstream = { sections: [{ name: 'base', text: 'base' }] }
  insert(ctx, 'root', inboxMessage(['nothing here at all'], TYPED))
  const { result, counter } = await assemble(listener, upstream, { agent: agent('root') })
  assert.equal(counter.next, 1)
  assert.equal(result, upstream)
})

// --- the request-time boost -------------------------------------------------

/** The reasoning levels an adapter advertises for one route. */
const LEVELS = { reasoning: { efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }, { id: 'max' }] } }
const NO_MAX = { reasoning: { efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }] } }

/** The turn every boost test binds its prompt to. */
const TURN = 1

/** Run one agent/request with a fixed upstream config. */
async function request(ctx, sessionId, config, turn = TURN) {
  const results = ctx.emit('agent/request', { agent: agent(sessionId), turn }, async () => config)
  assert.equal(results.length, 1, 'the plugin registered no agent/request listener')
  return await results[0]
}

/**
 * Let the step that claims a typed prompt bind the boost, as agent/pre-step does.
 * @param ctx - the mounted context.
 * @param sessionId - session whose prompt was claimed.
 * @param turn - the turn the claiming step belongs to.
 * @param text - the prompt that was spliced into the inbox.
 */
async function claim(ctx, sessionId, turn = TURN, text = 'ultrathink') {
  const message = inboxMessage([text], TYPED)
  const results = ctx.emit('agent/pre-step', { agent: agent(sessionId), messages: [message], turn }, async () => 'upstream')
  assert.equal(results.length, 1, 'the plugin registered no pre-step listener')
  await results[0]
}

/** Arm one session through the plugin's own route. */
async function armSession(ctx, sessionId, payload) {
  const route = ctx.routes[0]
  assert.ok(route !== undefined, 'the plugin registered no arm route')
  const response = await route.fetch(new Request('http://localhost' + route.path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rpcId: 'rpc-1', method: 'dsh-claude-ultra/arm', payload: { sessionId, ...payload } }),
  }))
  const body = await response.json()
  assert.equal(body.result.ok, true, JSON.stringify(body.result))
}

test('a boost rewrites the request to the top advertised level', async () => {
  const { ctx } = mount({ modelInfo: LEVELS })
  insert(ctx, 'root', inboxMessage(['ultrathink'], TYPED))
  await claim(ctx, 'root')
  const config = { provider: 'acme', model: 'astra', reasoningEffort: 'low' }
  const result = await request(ctx, 'root', config)
  assert.deepEqual(result, { provider: 'acme', model: 'astra', reasoningEffort: 'max' })
  assert.notEqual(result, config)
  assert.deepEqual(ctx.modelInfoCalls, [{ provider: 'acme', model: 'astra' }])
})

test('a boost without a max level rewrites to the highest advertised level', async () => {
  const { ctx } = mount({ modelInfo: NO_MAX })
  insert(ctx, 'root', inboxMessage(['ultrathink'], TYPED))
  await claim(ctx, 'root')
  const result = await request(ctx, 'root', { provider: 'acme', model: 'astra', reasoningEffort: 'low' })
  assert.equal(result.reasoningEffort, 'high')
})

test('a boost leaves a request already at the top level alone', async () => {
  const { ctx } = mount({ modelInfo: LEVELS })
  insert(ctx, 'root', inboxMessage(['ultrathink'], TYPED))
  await claim(ctx, 'root')
  const config = { provider: 'acme', model: 'astra', reasoningEffort: 'max' }
  assert.equal(await request(ctx, 'root', config), config)
})

test('a boost leaves a model with no usable level alone', async () => {
  const { ctx } = mount({ modelInfo: { reasoning: { efforts: [{ id: 'off' }] } } })
  insert(ctx, 'root', inboxMessage(['ultrathink'], TYPED))
  await claim(ctx, 'root')
  const config = { provider: 'acme', model: 'astra', reasoningEffort: 'low' }
  assert.equal(await request(ctx, 'root', config), config)
})

test('a boost leaves an unresolvable route alone and warns once', async () => {
  const { ctx } = mount({ modelInfoError: new Error('no route') })
  insert(ctx, 'root', inboxMessage(['ultrathink'], TYPED))
  await claim(ctx, 'root')
  const config = { provider: 'acme', model: 'astra', reasoningEffort: 'low' }
  assert.equal(await request(ctx, 'root', config), config)
  assert.equal(ctx.warnings.length, 1)
  assert.ok(ctx.warnings[0].includes('ultrathink'))
  assert.ok(ctx.warnings[0].includes('no route'))
})

test('the boost is not consumed by a request', async () => {
  const { ctx } = mount({ modelInfo: LEVELS })
  insert(ctx, 'root', inboxMessage(['ultrathink'], TYPED))
  await claim(ctx, 'root')
  const first = await request(ctx, 'root', { provider: 'acme', model: 'astra', reasoningEffort: 'low' })
  const second = await request(ctx, 'root', { provider: 'acme', model: 'astra', reasoningEffort: 'low' })
  assert.equal(first.reasoningEffort, 'max')
  assert.equal(second.reasoningEffort, 'max')
  assert.equal(ctx.modelInfoCalls.length, 2)
})

test('the turn a boost is bound to clears it', async () => {
  const { ctx } = mount({ modelInfo: LEVELS })
  insert(ctx, 'root', inboxMessage(['ultrathink'], TYPED))
  await claim(ctx, 'root')
  ctx.emit('session/event', { id: 'root' }, { type: 'turn/end', data: { turn: TURN } })
  const config = { provider: 'acme', model: 'astra', reasoningEffort: 'low' }
  assert.equal(await request(ctx, 'root', config), config)
  assert.deepEqual(ctx.modelInfoCalls, [])
})

test('disposing the agent clears the boost', async () => {
  const { ctx } = mount({ modelInfo: LEVELS })
  insert(ctx, 'root', inboxMessage(['ultrathink'], TYPED))
  ctx.emit('agent/disposed', { agent: agent('root') })
  const config = { provider: 'acme', model: 'astra', reasoningEffort: 'low' }
  assert.equal(await request(ctx, 'root', config), config)
  assert.deepEqual(ctx.modelInfoCalls, [])
})

test('a request with no boost is left alone and never resolves the model', async () => {
  const { ctx } = mount({ modelInfo: LEVELS })
  const config = { provider: 'acme', model: 'astra', reasoningEffort: 'low' }
  assert.equal(await request(ctx, 'root', config), config)
  assert.deepEqual(ctx.modelInfoCalls, [])
})

test('a boost on another session does not rewrite this one', async () => {
  const { ctx } = mount({ modelInfo: LEVELS })
  insert(ctx, 'other', inboxMessage(['ultrathink'], TYPED))
  const config = { provider: 'acme', model: 'astra', reasoningEffort: 'low' }
  assert.equal(await request(ctx, 'root', config), config)
  assert.deepEqual(ctx.modelInfoCalls, [])
})

test('an armed request whose effort landed does not warn, even with a boost', async () => {
  const { ctx } = mount({ modelInfo: LEVELS })
  await armSession(ctx, 'root', { provider: 'acme', model: 'astra', effort: 'max' })
  insert(ctx, 'root', inboxMessage(['ultrathink'], TYPED))
  await claim(ctx, 'root')
  const config = { provider: 'acme', model: 'astra', reasoningEffort: 'max' }
  assert.equal(await request(ctx, 'root', config), config)
  assert.deepEqual(ctx.warnings, [])
})

test('an armed request whose effort did not land warns once', async () => {
  const { ctx } = mount({ modelInfo: LEVELS })
  await armSession(ctx, 'root', { provider: 'acme', model: 'astra', effort: 'max' })
  const config = { provider: 'acme', model: 'astra', reasoningEffort: 'low' }
  await request(ctx, 'root', config)
  assert.equal(ctx.warnings.length, 1)
  assert.ok(ctx.warnings[0].includes('did not reach the request'))
})

test('the arm check reads the config before the boost rewrites it', async () => {
  const { ctx } = mount({ modelInfo: LEVELS })
  await armSession(ctx, 'root', { provider: 'acme', model: 'astra', effort: 'max' })
  insert(ctx, 'root', inboxMessage(['ultrathink'], TYPED))
  await claim(ctx, 'root')
  const result = await request(ctx, 'root', { provider: 'acme', model: 'astra', reasoningEffort: 'low' })
  // The arm did not land as the session configured it, even though the boost
  // raises the request to the same level afterwards.
  assert.equal(result.reasoningEffort, 'max')
  assert.equal(ctx.warnings.length, 1)
  assert.ok(ctx.warnings[0].includes('did not reach the request'))
})


// --- the turn-end undo of the boost -----------------------------------------

/** Let a void-ed undo promise settle. */
function flush() {
  return new Promise(resolve => { setImmediate(resolve) })
}

const BOOSTED = { provider: 'acme', model: 'astra', reasoningEffort: 'low' }

/** Mount a boosted session and run the request the boost rewrites. */
async function boosted(options = {}, config = BOOSTED) {
  const mounted = mount({ modelInfo: LEVELS, ...options })
  insert(mounted.ctx, 'root', inboxMessage(['ultrathink'], TYPED))
  await claim(mounted.ctx, 'root', TURN)
  const result = await request(mounted.ctx, 'root', config, TURN)
  return { ...mounted, result }
}

test('turn end puts the displaced selection back', async () => {
  const { ctx, result } = await boosted()
  assert.equal(result.reasoningEffort, 'max')
  ctx.emit('session/event', { id: 'root' }, { type: 'turn/end', data: { turn: TURN } })
  await flush()
  assert.deepEqual(ctx.selectCalls, [{ sessionId: 'root', provider: 'acme', model: 'astra', reasoningEffort: 'low' }])
})

test('the displaced selection omits an effort the config never carried', async () => {
  const { ctx, result } = await boosted({}, { provider: 'acme', model: 'astra' })
  assert.equal(result.reasoningEffort, 'max')
  ctx.emit('session/event', { id: 'root' }, { type: 'turn/end', data: { turn: TURN } })
  await flush()
  assert.equal(ctx.selectCalls.length, 1)
  assert.deepEqual(ctx.selectCalls[0], { sessionId: 'root', provider: 'acme', model: 'astra' })
  assert.equal('reasoningEffort' in ctx.selectCalls[0], false)
})

test('a request already at the top level records no displacement', async () => {
  const { ctx, result } = await boosted({}, { provider: 'acme', model: 'astra', reasoningEffort: 'max' })
  assert.equal(result.reasoningEffort, 'max')
  ctx.emit('session/event', { id: 'root' }, { type: 'turn/end', data: { turn: TURN } })
  await flush()
  assert.deepEqual(ctx.selectCalls, [])
})

test('a model with no usable level records no displacement', async () => {
  const { ctx } = await boosted({ modelInfo: { reasoning: { efforts: [{ id: 'off' }] } } })
  ctx.emit('session/event', { id: 'root' }, { type: 'turn/end', data: { turn: TURN } })
  await flush()
  assert.deepEqual(ctx.selectCalls, [])
})

test('an unresolvable route records no displacement', async () => {
  const { ctx } = await boosted({ modelInfoError: new Error('no route') })
  ctx.emit('session/event', { id: 'root' }, { type: 'turn/end', data: { turn: TURN } })
  await flush()
  assert.deepEqual(ctx.selectCalls, [])
})

test('an unboosted turn records no displacement', async () => {
  const { ctx } = mount({ modelInfo: LEVELS })
  await request(ctx, 'root', BOOSTED)
  ctx.emit('session/event', { id: 'root' }, { type: 'turn/end', data: { turn: TURN } })
  await flush()
  assert.deepEqual(ctx.selectCalls, [])
})

test('a composition without the session controller is a silent no-op', async () => {
  const { ctx } = await boosted({ sessionController: undefined })
  ctx.emit('session/event', { id: 'root' }, { type: 'turn/end', data: { turn: TURN } })
  await flush()
  assert.deepEqual(ctx.warnings, [])
})

test('a session controller that does not serve selectModel is a silent no-op', async () => {
  const { ctx } = await boosted({ sessionController: {} })
  ctx.emit('session/event', { id: 'root' }, { type: 'turn/end', data: { turn: TURN } })
  await flush()
  assert.deepEqual(ctx.warnings, [])
})

test('a rejected undo warns once and does not escape', async () => {
  const rejections = []
  const onRejection = (reason) => rejections.push(reason)
  process.on('unhandledRejection', onRejection)
  try {
    const { ctx } = await boosted({ selectModelError: new Error('undo refused') })
    ctx.emit('session/event', { id: 'root' }, { type: 'turn/end', data: { turn: TURN } })
    await flush()
    assert.equal(ctx.selectCalls.length, 1)
    assert.equal(ctx.warnings.length, 1)
    assert.ok(ctx.warnings[0].includes('was not undone'))
    assert.ok(ctx.warnings[0].includes('undo refused'))
    assert.deepEqual(rejections, [])
  } finally {
    process.off('unhandledRejection', onRejection)
  }
})

test('a model selection during the turn cancels the undo', async () => {
  const { ctx } = await boosted()
  ctx.emit('session/event', { id: 'root' }, { type: 'model/selection' })
  ctx.emit('session/event', { id: 'root' }, { type: 'turn/end', data: { turn: TURN } })
  await flush()
  assert.deepEqual(ctx.selectCalls, [])
})

test('disposing the agent cancels the undo', async () => {
  const { ctx } = await boosted()
  ctx.emit('agent/disposed', { agent: agent('root') })
  ctx.emit('session/event', { id: 'root' }, { type: 'turn/end', data: { turn: TURN } })
  await flush()
  assert.deepEqual(ctx.selectCalls, [])
})

test('the undo is submitted once for two turn ends', async () => {
  const { ctx } = await boosted()
  ctx.emit('session/event', { id: 'root' }, { type: 'turn/end', data: { turn: TURN } })
  ctx.emit('session/event', { id: 'root' }, { type: 'turn/end', data: { turn: TURN } })
  await flush()
  assert.equal(ctx.selectCalls.length, 1)
})

test('the undo belongs to the session that was boosted', async () => {
  const { ctx } = await boosted()
  ctx.emit('session/event', { id: 'other' }, { type: 'turn/end', data: { turn: TURN } })
  await flush()
  assert.deepEqual(ctx.selectCalls, [])
})

test('turn end submits the undo and leaves the keyword store to its own hook', async () => {
  const { ctx, listener } = mount({ modelInfo: LEVELS, states: { root: modeState('still', false, SPARSE_INTERVAL, 0) } })
  insert(ctx, 'root', inboxMessage(['ultracode and ultrathink'], TYPED))
  await claim(ctx, 'root', TURN, 'ultracode and ultrathink')
  await request(ctx, 'root', BOOSTED)
  ctx.emit('session/event', { id: 'root' }, { type: 'turn/end', data: { turn: TURN } })
  await flush()
  assert.equal(ctx.selectCalls.length, 1)
  // The claiming step already consumed the opt-in, and turn end must not
  // resurrect it: the two stores have different lifetimes.
  const { result } = await assemble(listener, { sections: [] }, { agent: agent('root') })
  assert.deepEqual(result.sections.map(section => section.name), [SECTION])
})


// --- the reminder cadence ---------------------------------------------------
//
// Claude's attachment builder walks the conversation backwards from the newest
// message, counting user messages until it reaches the newest reminder. The fold
// records the prompt count and where the last reminder was logged; the resolver
// reproduces that cadence from the two.

/** A logged system message carrying the given text blocks. */
function systemMessage(...texts) {
  return { type: 'system/message', data: { message: { content: texts.map(text => ({ type: 'text', text })) } } }
}

/** A logged user message the human typed. */
function typedPrompt(text = 'a prompt') {
  return { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } }
}

/** Fold a run of events, starting from a given state. */
function foldFrom(state, ...events) {
  return events.reduce((current, event) => applyClaudeUltraModeProjection(current, event), state)
}



/** Fold a run of events into a fresh projection, as the Session log would. */
function fold(...events) {
  return foldFrom(EMPTY_CLAUDE_ULTRA_MODE_STATE, ...events)
}

/** A run of n typed prompts. */
function typedPrompts(count) {
  return Array.from({ length: count }, () => typedPrompt())
}

/** Resolve the reminder for a root agent holding one folded state. */
function reminderFor(state) {
  const ctx = context({ states: { root: { [KEY]: state } } })
  return resolveClaudeUltraReminder(ctx, agent('root'), createClaudeUltraArmStore())
}

/** Enter Ultra on the first turn, then run n typed prompts after it. */
function enteredThen(count) {
  return fold(systemMessage(ULTRA_ENTER_FULL), ...typedPrompts(count))
}

test('a fresh entry without an arm yields nothing', () => {
  assert.equal(reminderFor(enteredThen(0)), null)
})

test('the repeat reminder waits for the interval', () => {
  assert.equal(reminderFor(enteredThen(SPARSE_INTERVAL - 1)), null)
  assert.equal(reminderFor(enteredThen(SPARSE_INTERVAL)), 'still')
})

test('a logged reminder re-marks the count', () => {
  const due = enteredThen(12)
  assert.equal(reminderFor(due), 'still')
  const reMarked = applyClaudeUltraModeProjection(due, systemMessage(ULTRA_ENTER_STILL))
  assert.equal(reMarked.markerAt, 12)
  assert.equal(reminderFor(reMarked), null)
  assert.equal(reminderFor(foldFrom(reMarked, ...typedPrompts(SPARSE_INTERVAL - 1))), null)
  assert.equal(reminderFor(foldFrom(reMarked, ...typedPrompts(SPARSE_INTERVAL))), 'still')
})

test('the exit reminder is emitted once', () => {
  const dirty = applyClaudeUltraModeProjection(fold(systemMessage(ULTRA_ENTER_FULL)), { type: 'model/selection' })
  assert.equal(reminderFor(dirty), 'off')
  const exited = applyClaudeUltraModeProjection(dirty, systemMessage(ULTRA_EXIT))
  assert.equal(reminderFor(exited), null)
  assert.equal(reminderFor(foldFrom(exited, ...typedPrompts(50))), null)
})

test('an arm announces Ultra at the start of the interval', () => {
  const ctx = context()
  const root = agent('root', { config: selection() })
  assert.equal(resolveClaudeUltraReminder(ctx, root, armsWith({ root: ARM })), 'full')
})

test('an arm ignores the interval when Ultra is already on', () => {
  const entered = enteredThen(0)
  assert.equal(entered.prompts - entered.markerAt, 0)
  const ctx = context({ states: { root: { [KEY]: entered } } })
  const root = agent('root', { config: selection() })
  assert.equal(resolveClaudeUltraReminder(ctx, root, armsWith({ root: ARM })), 'still')
})

test('a subagent of an active parent still starts with the full entry', () => {
  const child = agent('child', { header: { origin: 'subagent', parentSession: 'parent' } })
  const ctx = context({ states: { parent: { [KEY]: enteredThen(0) } }, agents: { parent: agent('parent') } })
  assert.equal(resolveClaudeUltraReminder(ctx, child, createClaudeUltraArmStore()), 'full')
})

// --- the boost's turn binding -----------------------------------------------
//
// The boost is bound to the turn that claimed its prompt, not the turn that was
// running when it was typed. A prompt typed while the previous turn is still
// finishing is inserted before that turn's turn/end, which lands about a tenth
// of a second after the reply renders.

test('a fresh boost entry is unbound', () => {
  const boosts = createClaudeUltraBoostStore()
  boosts.set('session-1', true)
  assert.equal(boosts.get('session-1'), true)
  assert.equal(boosts.turnOf('session-1'), undefined)
})

test('bind records the claiming turn', () => {
  const boosts = createClaudeUltraBoostStore()
  boosts.set('session-1', true)
  boosts.bind('session-1', 4)
  assert.equal(boosts.turnOf('session-1'), 4)
  assert.equal(boosts.get('session-1'), true)
})

test('bind on a session with no entry is a no-op', () => {
  const boosts = createClaudeUltraBoostStore()
  boosts.bind('session-1', 4)
  assert.equal(boosts.turnOf('session-1'), undefined)
  assert.equal(boosts.get('session-1'), false)
})

test('release clears only the turn the entry is bound to', () => {
  const boosts = createClaudeUltraBoostStore()
  boosts.set('session-1', true)
  boosts.bind('session-1', 2)
  boosts.release('session-1', 1)
  assert.equal(boosts.get('session-1'), true)
  assert.equal(boosts.turnOf('session-1'), 2)
  boosts.release('session-1', 2)
  assert.equal(boosts.get('session-1'), false)
  assert.equal(boosts.turnOf('session-1'), undefined)
})

test('release on an unbound entry clears nothing', () => {
  const boosts = createClaudeUltraBoostStore()
  boosts.set('session-1', true)
  boosts.release('session-1', 1)
  assert.equal(boosts.get('session-1'), true)
})

test('set unbinds a previously bound entry', () => {
  const boosts = createClaudeUltraBoostStore()
  boosts.set('session-1', true)
  boosts.bind('session-1', 3)
  boosts.set('session-1', true)
  assert.equal(boosts.turnOf('session-1'), undefined)
  boosts.release('session-1', 3)
  assert.equal(boosts.get('session-1'), true, 'a turn the entry is no longer bound to must not release it')
})

// --- binding happens on the claim, not on the insertion ---------------------

test('a step that claimed a typed prompt binds its turn', async () => {
  const { boosts, insert, preStep } = capture()
  insert('session-1', inboxMessage(['ultrathink'], TYPED))
  assert.equal(boosts.turnOf('session-1'), undefined)
  await preStep('session-1', [inboxMessage(['ultrathink'], TYPED)], async () => 'upstream', 7)
  assert.equal(boosts.turnOf('session-1'), 7)
})

test('a step whose messages are all runtime context binds nothing', async () => {
  const { boosts, insert, preStep } = capture()
  insert('session-1', inboxMessage(['ultrathink'], TYPED))
  await preStep('session-1', [inboxMessage(['context'], { kind: 'runtime-context' })], async () => 'upstream', 7)
  assert.equal(boosts.turnOf('session-1'), undefined)
})

test('a step with no messages binds nothing', async () => {
  const { boosts, insert, preStep } = capture()
  insert('session-1', inboxMessage(['ultrathink'], TYPED))
  await preStep('session-1', [], async () => 'upstream', 7)
  assert.equal(boosts.turnOf('session-1'), undefined)
})

test('a claiming step for a session with no entry binds nothing', async () => {
  const { boosts, preStep } = capture()
  await preStep('session-1', [inboxMessage(['ultrathink'], TYPED)], async () => 'upstream', 7)
  assert.equal(boosts.turnOf('session-1'), undefined)
  assert.equal(boosts.get('session-1'), false)
})

test('a claiming step whose prompt carried no boost records none', async () => {
  const { boosts, insert, preStep } = capture()
  insert('session-1', inboxMessage(['nothing here'], TYPED))
  await preStep('session-1', [inboxMessage(['nothing here'], TYPED)], async () => 'upstream', 7)
  assert.equal(boosts.get('session-1'), false)
})

// --- the request gate -------------------------------------------------------

test('an unbound boost is not applied and does not resolve the model', async () => {
  const { ctx } = mount({ modelInfo: LEVELS })
  insert(ctx, 'root', inboxMessage(['ultrathink'], TYPED))
  const config = { provider: 'acme', model: 'astra', reasoningEffort: 'low' }
  assert.equal(await request(ctx, 'root', config, TURN), config)
  assert.deepEqual(ctx.modelInfoCalls, [])
})

test('a boost bound to another turn is not applied', async () => {
  const { ctx } = mount({ modelInfo: LEVELS })
  insert(ctx, 'root', inboxMessage(['ultrathink'], TYPED))
  await claim(ctx, 'root', TURN + 1)
  const config = { provider: 'acme', model: 'astra', reasoningEffort: 'low' }
  assert.equal(await request(ctx, 'root', config, TURN), config)
  assert.deepEqual(ctx.modelInfoCalls, [])
})

test('a boost bound to this turn is applied', async () => {
  const { ctx } = mount({ modelInfo: LEVELS })
  insert(ctx, 'root', inboxMessage(['ultrathink'], TYPED))
  await claim(ctx, 'root', TURN)
  const result = await request(ctx, 'root', { provider: 'acme', model: 'astra', reasoningEffort: 'low' }, TURN)
  assert.equal(result.reasoningEffort, 'max')
})

// --- the race the binding fixes ---------------------------------------------

test('a turn end for another turn leaves the boost standing', async () => {
  const { ctx } = mount({ modelInfo: LEVELS })
  insert(ctx, 'root', inboxMessage(['ultrathink'], TYPED))
  await claim(ctx, 'root', TURN + 1)
  ctx.emit('session/event', { id: 'root' }, { type: 'turn/end', data: { turn: TURN } })
  const result = await request(ctx, 'root', { provider: 'acme', model: 'astra', reasoningEffort: 'low' }, TURN + 1)
  assert.equal(result.reasoningEffort, 'max')
})

test('a turn end for the bound turn clears the boost', async () => {
  const { ctx } = mount({ modelInfo: LEVELS })
  insert(ctx, 'root', inboxMessage(['ultrathink'], TYPED))
  await claim(ctx, 'root', TURN + 1)
  ctx.emit('session/event', { id: 'root' }, { type: 'turn/end', data: { turn: TURN + 1 } })
  const config = { provider: 'acme', model: 'astra', reasoningEffort: 'low' }
  assert.equal(await request(ctx, 'root', config, TURN + 1), config)
  assert.deepEqual(ctx.modelInfoCalls, [])
})

test('a prompt queued during a turn boosts only the turn that claims it', async () => {
  const { ctx } = mount({ modelInfo: LEVELS })
  // The user types the ultrathink prompt while turn 1 is still running.
  insert(ctx, 'root', inboxMessage(['ultrathink'], TYPED))
  const running = { provider: 'acme', model: 'astra', reasoningEffort: 'low' }
  assert.equal(await request(ctx, 'root', running, TURN), running)
  assert.deepEqual(ctx.modelInfoCalls, [])
  // Turn 1 claimed no prompt, so its end releases nothing.
  ctx.emit('session/event', { id: 'root' }, { type: 'turn/end', data: { turn: TURN } })
  // Turn 2 claims the queued prompt, and only its request is boosted.
  await claim(ctx, 'root', TURN + 1)
  const boosted = await request(ctx, 'root', { provider: 'acme', model: 'astra', reasoningEffort: 'low' }, TURN + 1)
  assert.equal(boosted.reasoningEffort, 'max')
})

test('a turn end with no logged turn clears nothing', async () => {
  const { ctx } = mount({ modelInfo: LEVELS })
  // An entry nothing has claimed yet is the one a turn-less turn/end could
  // wrongly clear, because its bound turn is itself undefined.
  insert(ctx, 'root', inboxMessage(['ultrathink'], TYPED))
  ctx.emit('session/event', { id: 'root' }, { type: 'turn/end' })
  await claim(ctx, 'root', TURN)
  const unbound = await request(ctx, 'root', { provider: 'acme', model: 'astra', reasoningEffort: 'low' }, TURN)
  assert.equal(unbound.reasoningEffort, 'max')
  // A bound entry is left alone too.
  ctx.emit('session/event', { id: 'root' }, { type: 'turn/end' })
  const bound = await request(ctx, 'root', { provider: 'acme', model: 'astra', reasoningEffort: 'low' }, TURN)
  assert.equal(bound.reasoningEffort, 'max')
})

test('disposing the agent clears a bound boost', async () => {
  const { ctx } = mount({ modelInfo: LEVELS })
  insert(ctx, 'root', inboxMessage(['ultrathink'], TYPED))
  await claim(ctx, 'root', TURN)
  ctx.emit('agent/disposed', { agent: agent('root') })
  const config = { provider: 'acme', model: 'astra', reasoningEffort: 'low' }
  assert.equal(await request(ctx, 'root', config, TURN), config)
  assert.deepEqual(ctx.modelInfoCalls, [])
})
