import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createClaudeUltraArmStore, registerClaudeUltraArmRoute } from '../lib/index.js'

const PATH = '/api/dsh-claude-ultra/arm'
const ENDPOINT = 'dsh-claude-ultra/arm'
const SESSION = 'session-1'
const PAYLOAD = { sessionId: SESSION, provider: 'acme', model: 'astra', effort: 'max' }
const LEVELS = { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }, { id: 'max' }] } }

/** Register the route against a fake Host and return the captured registration. */
function setup(options = {}) {
  const arms = createClaudeUltraArmStore()
  const sessions = options.sessions ?? [SESSION]
  let route
  const ctx = {
    connection: { fetch: { register(candidate) { route = candidate; return () => {} } } },
    sessions: { get: (id) => (sessions.includes(id) ? { id } : undefined) },
    llm: {
      resolveModelInfo: async () => options.modelInfo ?? LEVELS,
      resolveCallConfig: async (request) => {
        if (options.callConfigError !== undefined) throw options.callConfigError
        return request
      },
    },
  }
  registerClaudeUltraArmRoute(ctx, arms)
  return { arms, route }
}

/** One POST to the arm endpoint. */
function post(body, contentType = 'application/json') {
  return new Request('http://localhost' + PATH, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

/** One RPC envelope addressed to the arm endpoint. */
function envelope(payload, method = ENDPOINT, rpcId = 'rpc-1') {
  return { rpcId, method, payload }
}

/** The result member of a JSON response. */
async function resultOf(response) {
  const body = await response.json()
  assert.equal(body.type, 'server-response')
  return body
}

test('the route registers the arm endpoint', () => {
  const { route } = setup()
  assert.equal(route.path, PATH)
  assert.deepEqual(route.methods, ['POST'])
  assert.equal(route.requestBody, 'buffered')
})

test('a non-JSON content type is rejected with 415', async () => {
  const { route } = setup()
  const response = await route.fetch(post('{}', 'text/plain'))
  assert.equal(response.status, 415)
})

test('a body that does not parse as JSON is a 400', async () => {
  const { route } = setup()
  const response = await route.fetch(post('not json at all'))
  assert.equal(response.status, 400)
})

test('an envelope addressed to another endpoint is a 400', async () => {
  const { route } = setup()
  const response = await route.fetch(post(envelope(PAYLOAD, 'other/endpoint')))
  assert.equal(response.status, 400)
})

test('an envelope with no method is a 400', async () => {
  const { route } = setup()
  const response = await route.fetch(post({ rpcId: 'rpc-1', payload: PAYLOAD }))
  assert.equal(response.status, 400)
})

test('a payload missing required fields answers ok:false', async () => {
  const { route } = setup()
  const response = await route.fetch(post(envelope({ sessionId: SESSION, provider: 'acme' })))
  assert.equal(response.status, 200)
  const body = await resultOf(response)
  assert.equal(body.rpcId, 'rpc-1')
  assert.equal(body.result.ok, false)
  assert.equal(body.result.error.code, 'claude-ultra/bad-request')
})

test('an empty string payload field is missing, not present', async () => {
  const { route } = setup()
  const response = await route.fetch(post(envelope({ ...PAYLOAD, effort: '' })))
  const body = await resultOf(response)
  assert.equal(body.result.error.code, 'claude-ultra/bad-request')
})

test('an unknown session is refused', async () => {
  const { route } = setup({ sessions: [] })
  const response = await route.fetch(post(envelope(PAYLOAD)))
  const body = await resultOf(response)
  assert.equal(body.result.ok, false)
  assert.equal(body.result.error.code, 'claude-ultra/unknown-session')
})

test('a model with no usable effort is refused', async () => {
  const { route } = setup({ modelInfo: { reasoning: { efforts: [{ id: 'off' }] } } })
  const response = await route.fetch(post(envelope(PAYLOAD)))
  const body = await resultOf(response)
  assert.equal(body.result.error.code, 'claude-ultra/unsupported-model')
})

test('an effort other than the mapped one is refused', async () => {
  const { route } = setup()
  const response = await route.fetch(post(envelope({ ...PAYLOAD, effort: 'high' })))
  const body = await resultOf(response)
  assert.equal(body.result.error.code, 'claude-ultra/unsupported-effort')
  assert.ok(body.result.error.message.includes('max'))
})

test('a model the adapter cannot resolve is reported as unavailable', async () => {
  const { route } = setup({ callConfigError: new Error('no route') })
  const response = await route.fetch(post(envelope(PAYLOAD)))
  const body = await resultOf(response)
  assert.equal(body.result.error.code, 'claude-ultra/model-unavailable')
  assert.ok(body.result.error.message.includes('no route'))
})

test('the happy path arms the session for the mapped effort', async () => {
  const { arms, route } = setup()
  const response = await route.fetch(post(envelope(PAYLOAD)))
  assert.equal(response.status, 200)
  const body = await resultOf(response)
  assert.deepEqual(body.result, { ok: true, value: { effort: 'max' } })
  assert.deepEqual(arms.get(SESSION), { provider: 'acme', model: 'astra', effort: 'max' })
})

test('a refused arm request leaves the store untouched', async () => {
  const { arms, route } = setup()
  await route.fetch(post(envelope({ ...PAYLOAD, effort: 'high' })))
  assert.equal(arms.get(SESSION), undefined)
})

test('the mapped effort is the highest advertised level when there is no max', async () => {
  const { arms, route } = setup({ modelInfo: { reasoning: { efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }] } } })
  const response = await route.fetch(post(envelope({ ...PAYLOAD, effort: 'high' })))
  const body = await resultOf(response)
  assert.deepEqual(body.result, { ok: true, value: { effort: 'high' } })
  assert.deepEqual(arms.get(SESSION), { provider: 'acme', model: 'astra', effort: 'high' })
})
