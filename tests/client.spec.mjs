import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, inject } from '../.test/client.js'

const NS = 'claudeUltra'
const KEY = 'claudeUltraMode'
const CHANNEL = '/api'
const ENDPOINT = 'dsh-claude-ultra/arm'

/** One catalog model advertising the given reasoning levels. */
function model(ids, extra = {}) {
  return { id: 'astra', name: 'Astra', reasoning: { efforts: ids.map(id => ({ id })) }, ...extra }
}

/** A model that advertises no reasoning metadata at all. */
const PLAIN_MODEL = { id: 'astra', name: 'Astra' }

const TOP = model(['low', 'high', 'max'])
const SELECTION = { provider: 'acme', model: 'astra' }

/** A projection face reporting one fixed snapshot. */
function face(snapshot) {
  return { getSnapshot: () => snapshot, subscribe: () => () => {} }
}

/**
 * Mount the browser half over a fake client context. faces maps a session id to
 * its claudeUltraMode projection face; a key present with an undefined value
 * stands for a binding whose face has not been published yet.
 */
function harness(options = {}) {
  const dictionaries = []
  const effects = []
  const bindings = []
  const listeners = []
  const tiers = []
  const rpcCalls = []
  const faceOfCalls = []
  const faces = options.faces ?? {}

  const services = {
    codexModelTiers: { register(tier) { tiers.push(tier); return () => {} } },
    sessions: {
      binding(sessionId) {
        if (!(sessionId in faces)) return undefined
        const projected = faces[sessionId]
        return {
          session: {
            projections: {
              faceOf(key) {
                faceOfCalls.push({ sessionId, key })
                return projected
              },
            },
          },
        }
      },
    },
    connection: {
      rpc: {
        async call(channel, endpoint, payload) {
          rpcCalls.push([channel, endpoint, payload])
          return options.rpcResult ?? { ok: true, value: undefined }
        },
      },
    },
  }

  if (options.omit !== undefined) delete services[options.omit]

  const ctx = {
    effect(callback, label) {
      const dispose = callback()
      effects.push({ label, dispose })
      return dispose
    },
    locale: {
      register(namespace, dicts) { dictionaries.push({ namespace, dicts }); return () => {} },
      bind(namespace) {
        bindings.push(namespace)
        const registered = dictionaries.find(entry => entry.namespace === namespace)
        const table = registered === undefined ? {} : registered.dicts.en
        return (key) => table[key] ?? key
      },
    },
    on(event, listener) { listeners.push({ event, listener }); return () => {} },
    get(name) { return services[name] },
  }

  apply(ctx)
  return { ctx, dictionaries, effects, bindings, listeners, tiers, rpcCalls, faceOfCalls, services }
}

/** The single contributed tier. */
function tierOf(options) {
  const harnessed = harness(options)
  assert.equal(harnessed.tiers.length, 1)
  return { ...harnessed, tier: harnessed.tiers[0] }
}

test('the browser half declares only services that are always present', () => {
  // codexModelTiers belongs to the switcher. Declaring it here would leave this
  // boot entry pending whenever the switcher is absent, which the client boot
  // audit reports as a failed plugin load.
  assert.deepEqual([...inject], ['sessions', 'connection', 'locale'])
  assert.ok(!inject.includes('codexModelTiers'))
})

test('a composition without the switcher contributes no tier and still activates', () => {
  // Reading the optional peer with ctx.get rather than ctx.inject is what keeps
  // this boot entry activated: a pending inject is reported by the client boot
  // audit as a failed plugin load.
  const h = harness({ omit: 'codexModelTiers' })
  assert.deepEqual(h.tiers, [])
  assert.equal(h.dictionaries.length, 1)
})

test('a switcher that publishes its service later still receives the tier', () => {
  const h = harness({ omit: 'codexModelTiers' })
  assert.deepEqual(h.tiers, [])
  const published = h.listeners.find(entry => entry.event === 'internal/service')
  assert.ok(published, 'the plugin must watch for the service being published')
  h.services.codexModelTiers = { register(tier) { h.tiers.push(tier); return () => {} } }
  published.listener('codexModelTiers', h.services.codexModelTiers)
  assert.equal(h.tiers.length, 1)
  assert.equal(h.tiers[0].id, 'ultra')
  // A second publication must not register the tier twice.
  published.listener('codexModelTiers', h.services.codexModelTiers)
  assert.equal(h.tiers.length, 1)
})

test('the dictionaries register under the plugin namespace with matching key sets', () => {
  const h = harness()
  assert.equal(h.dictionaries.length, 1)
  const [registered] = h.dictionaries
  assert.equal(registered.namespace, NS)
  const keys = Object.keys(registered.dicts.zh).sort()
  assert.ok(keys.length > 0)
  assert.deepEqual(keys, Object.keys(registered.dicts.en).sort())
  assert.ok(h.bindings.includes(NS))
})

test('exactly one Ultra tier is contributed', () => {
  const h = harness()
  assert.equal(h.tiers.length, 1)
  assert.equal(h.tiers[0].id, 'ultra')
})

test('the tier label comes from the plugin dictionary', () => {
  const h = harness()
  assert.equal(h.tiers[0].label, 'Ultra')
  assert.ok(typeof h.tiers[0].description === 'string' && h.tiers[0].description.length > 0)
})

test('the tier is unavailable when the model exposes no usable effort', () => {
  const { tier } = tierOf()
  assert.equal(tier.available(undefined), false)
  assert.equal(tier.available(PLAIN_MODEL), false)
  assert.equal(tier.available(model(['off'])), false)
})

test('the tier is available when the model exposes a usable effort', () => {
  const { tier } = tierOf()
  assert.equal(tier.available(model(['off', 'low', 'high'])), true)
  assert.equal(tier.available(TOP), true)
})

test('the tier submits the same effort the Host maps', () => {
  const { tier } = tierOf()
  assert.equal(tier.effort(TOP), 'max')
  assert.equal(tier.effort(model(['off', 'low', 'high'])), 'high')
  assert.equal(tier.effort(model(['off'])), undefined)
})

test('apply refuses a model Ultra cannot use without submitting a selection', async () => {
  const { tier, rpcCalls } = tierOf()
  const selects = []
  const result = await tier.apply('session-1', SELECTION, model(['off']), async (value) => {
    selects.push(value)
    return { ok: true, value: undefined }
  })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'claude-ultra/unsupported')
  assert.deepEqual(selects, [])
  assert.deepEqual(rpcCalls, [])
})

test('apply selects the mapped effort and then arms the Host', async () => {
  const { tier, rpcCalls } = tierOf()
  const selects = []
  const result = await tier.apply('session-1', SELECTION, TOP, async (value) => {
    selects.push(value)
    return { ok: true, value: undefined }
  })
  assert.deepEqual(selects, [{ provider: 'acme', model: 'astra', reasoningEffort: 'max' }])
  assert.deepEqual(rpcCalls, [[CHANNEL, ENDPOINT, { sessionId: 'session-1', provider: 'acme', model: 'astra', effort: 'max' }]])
  assert.deepEqual(result, { ok: true, value: undefined })
})

test('a rejected selection short-circuits before the Host is armed', async () => {
  const { tier, rpcCalls } = tierOf()
  const failure = { ok: false, error: { code: 'switcher/rejected', message: 'nope' } }
  const result = await tier.apply('session-1', SELECTION, TOP, async () => failure)
  assert.equal(result, failure)
  assert.deepEqual(rpcCalls, [])
})

test('a selection that never lands propagates as undefined', async () => {
  const { tier, rpcCalls } = tierOf()
  const result = await tier.apply('session-1', SELECTION, TOP, async () => undefined)
  assert.equal(result, undefined)
  assert.deepEqual(rpcCalls, [])
})

test('an arm failure from the Host is reported back to the switcher', async () => {
  const failure = { ok: false, error: { code: 'claude-ultra/unknown-session', message: 'no such session' } }
  const { tier } = tierOf({ rpcResult: failure })
  const result = await tier.apply('session-1', SELECTION, TOP, async () => ({ ok: true, value: undefined }))
  assert.equal(result, failure)
})

test('activation reads the claudeUltraMode face of the session', () => {
  const { tier, faceOfCalls } = tierOf({ faces: { s1: face({ mode: 'full', dirty: false }) } })
  assert.equal(tier.active('s1').getSnapshot(), true)
  assert.deepEqual(faceOfCalls, [{ sessionId: 's1', key: KEY }])
})

test('activation is true only while Ultra is on and not yet dirtied', () => {
  const { tier } = tierOf({ faces: {
    full: face({ mode: 'full', dirty: false }),
    still: face({ mode: 'still', dirty: false }),
    dirty: face({ mode: 'full', dirty: true }),
    off: face({ mode: 'off', dirty: false }),
    empty: face({ mode: null, dirty: false }),
  } })
  assert.equal(tier.active('full').getSnapshot(), true)
  assert.equal(tier.active('still').getSnapshot(), true)
  assert.equal(tier.active('dirty').getSnapshot(), false)
  assert.equal(tier.active('off').getSnapshot(), false)
  assert.equal(tier.active('empty').getSnapshot(), false)
})

test('activation is false without a binding or without a face', () => {
  const { tier } = tierOf({ faces: { bound: undefined } })
  assert.equal(tier.active('bound').getSnapshot(), false)
  assert.equal(tier.active('unbound').getSnapshot(), false)
})

test('activation resolves each session face once', () => {
  const { tier, faceOfCalls } = tierOf({ faces: { s1: face({ mode: 'full', dirty: false }) } })
  assert.equal(tier.active('s1'), tier.active('s1'))
  assert.equal(faceOfCalls.length, 1)
})

test('activation subscribes through the projection face', () => {
  const listeners = []
  const projected = {
    getSnapshot: () => ({ mode: 'full', dirty: false }),
    subscribe(listener) { listeners.push(listener); return () => { listeners.pop() } },
  }
  const { tier } = tierOf({ faces: { s1: projected } })
  const stop = tier.active('s1').subscribe(() => {})
  assert.equal(listeners.length, 1)
  stop()
  assert.equal(listeners.length, 0)
})
