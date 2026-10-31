/** The Connection Fetch route that arms Ultra for the next model request. */
import type { ClaudeUltraContext, UltraCallConfig } from './ports.ts'
import type { UltraArmStore } from './arms.ts'
import { mappedUltraEffort } from './mode.ts'
import { CLAUDE_ULTRA_ARM_ENDPOINT, CLAUDE_ULTRA_ARM_PATH } from './protocol.ts'

/** One decoded client request envelope. */
interface ClaudeUltraEnvelope {
  readonly rpcId: string
  readonly method: string
  readonly payload: unknown
}

/** One decoded arm request. */
interface ClaudeUltraArmPayload {
  readonly sessionId: string
  readonly provider: string
  readonly model: string
  readonly effort: string
}

/** Read the request envelope, rejecting anything this endpoint does not serve. */
function readEnvelope(body: unknown): ClaudeUltraEnvelope | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const record = body as Record<string, unknown>
  const rpcId = record.rpcId
  const method = record.method
  if (typeof rpcId !== 'string' || typeof method !== 'string') return undefined
  return { rpcId, method, payload: record.payload }
}

/** Read one non-empty string member. */
function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Decode and validate the arm payload. */
function readArmPayload(payload: unknown): ClaudeUltraArmPayload | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const record = payload as Record<string, unknown>
  const sessionId = readString(record, 'sessionId')
  const provider = readString(record, 'provider')
  const model = readString(record, 'model')
  const effort = readString(record, 'effort')
  if (sessionId === undefined || provider === undefined || model === undefined || effort === undefined) return undefined
  return { sessionId, provider, model, effort }
}

/** Human-readable failure text. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Register the arm route.
 *
 * The registration rides the caller's fiber, so the plugin's disposal removes it.
 * @param ctx - Host context carrying Connection, sessions, and the LLM service.
 * @param arms - pre-request arm store.
 */
export function registerClaudeUltraArmRoute(ctx: ClaudeUltraContext, arms: UltraArmStore): void {
  ctx.connection.fetch.register({
    path: CLAUDE_ULTRA_ARM_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request: Request): Promise<Response> {
      const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (mediaType !== 'application/json') return new Response('Expected application/json.', { status: 415 })
      let body: unknown
      try {
        body = await request.json()
      } catch (error) {
        // A body that is not JSON is a caller bug, not a server failure.
        return new Response('Invalid JSON body: ' + String(error), { status: 400 })
      }
      const envelope = readEnvelope(body)
      if (envelope === undefined || envelope.method !== CLAUDE_ULTRA_ARM_ENDPOINT) {
        return new Response('Invalid Ultra RPC envelope for ' + CLAUDE_ULTRA_ARM_ENDPOINT + '.', { status: 400 })
      }
      const respond = (result: unknown): Response => Response.json({ type: 'server-response', rpcId: envelope.rpcId, result })
      const payload = readArmPayload(envelope.payload)
      if (payload === undefined) {
        return respond({ ok: false, error: { code: 'claude-ultra/bad-request', message: 'sessionId, provider, model, and effort are required' } })
      }
      const session = ctx.sessions.get(payload.sessionId)
      if (session === undefined) {
        return respond({ ok: false, error: { code: 'claude-ultra/unknown-session', message: 'no such session' } })
      }
      try {
        const info = await ctx.llm.resolveModelInfo(payload.provider, payload.model)
        const mapped = mappedUltraEffort(info.reasoning?.efforts)
        if (mapped === undefined) {
          return respond({ ok: false, error: { code: 'claude-ultra/unsupported-model', message: 'this model advertises no reasoning effort usable by Ultra' } })
        }
        if (payload.effort !== mapped) {
          return respond({ ok: false, error: { code: 'claude-ultra/unsupported-effort', message: 'expected effort ' + mapped + ', received ' + payload.effort } })
        }
        await ctx.llm.resolveCallConfig({ provider: payload.provider, model: payload.model, reasoningEffort: payload.effort })
      } catch (error) {
        return respond({ ok: false, error: { code: 'claude-ultra/model-unavailable', message: errorMessage(error) } })
      }
      arms.set(payload.sessionId, { provider: payload.provider, model: payload.model, effort: payload.effort })
      return respond({ ok: true, value: { effort: payload.effort } })
    },
  })
}

/** Re-exported so the route's call-config shape stays visible to typecheck. */
export type ClaudeUltraCallConfig = UltraCallConfig
