/**
 * Claude Ultra mode, browser half.
 *
 * The composer's model seat belongs to dsh-codex-effort-switcher, which
 * publishes the \`codexModelTiers\` client service. This plugin contributes one
 * tier: the Ultra stop above the model's own levels. Selecting it submits the
 * model's top reasoning effort through the switcher's own selection path and
 * then arms the Host half for the next request.
 *
 * The switcher is reached only through that service, inside a nested
 * \`ctx.inject\`. A composition without the switcher leaves this plugin with
 * nothing to contribute instead of leaving its boot entry pending.
 */
import { mappedUltraEffort } from './mode.ts'
import { CLAUDE_ULTRA_API_CHANNEL, CLAUDE_ULTRA_ARM_ENDPOINT, CLAUDE_ULTRA_PROJECTION_KEY } from './protocol.ts'
import { en, zh } from './client/locales.ts'

/** Dictionary namespace owned by this plugin. */
const NS = 'claudeUltra'

/**
 * Services this plugin's apply requires.
 *
 * \`codexModelTiers\` is deliberately absent: it belongs to
 * dsh-codex-effort-switcher, and a required service that never appears leaves
 * this boot entry pending, which the client boot audit reports as a failed
 * plugin load and blanks the whole surface. The switcher is reached through the
 * nested \`ctx.inject\` below instead, so a composition without it degrades to
 * "no Ultra tier" rather than a broken client.
 */
export const inject = ['sessions', 'connection', 'locale']

/** One adapter-owned reasoning level of an exact model route. */
interface ReasoningEffort {
  readonly id: string
}

/** Reasoning metadata advertised for an exact model route. */
interface ModelReasoning {
  readonly efforts: readonly ReasoningEffort[]
}

/** One model inside its provider group. */
interface CatalogModel {
  readonly id: string
  readonly name: string
  readonly reasoning?: ModelReasoning
}

/** Complete provider/model/effort selection for one Session. */
interface ModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** Answer envelope shared by the client remote services. */
type RemoteResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string } }

/** Identity-stable bare observable: the renderer's subscription contract. */
interface ObservableSnapshot<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

/** One additional effort-like tier contributed to the switcher. */
interface SeatTier {
  readonly id: string
  readonly label: string
  readonly description?: string
  available(model: CatalogModel | undefined): boolean
  effort(model: CatalogModel): string | undefined
  active(sessionId: string): ObservableSnapshot<boolean>
  apply(
    sessionId: string,
    selection: ModelSelection,
    model: CatalogModel,
    select: (selection: ModelSelection) => Promise<RemoteResult<void> | undefined>,
  ): Promise<RemoteResult<void> | undefined>
}

/** Registry the switcher publishes for contributed tiers. */
interface SeatTierRegistry {
  register(tier: SeatTier): () => void
}

/** One projected value of a Session, as the client store exposes it. */
interface ProjectionFace {
  getSnapshot(): unknown
  subscribe(listener: () => void): () => void
}

/** The Session face this plugin reads. */
interface SessionBinding {
  readonly session: { readonly projections: { faceOf(key: string): ProjectionFace | undefined } }
}

/** The Session index this plugin reads. */
interface ClientSessions {
  binding?(sessionId: string): SessionBinding | undefined
}

/** The Connection handle's RPC face. */
interface ClientConnection {
  readonly rpc: { call(channel: string, endpoint: string, payload: unknown): Promise<RemoteResult<unknown>> }
}

/** Translate function bound to this plugin's namespace. */
type Translate = (key: string) => string

/** The locale runtime face. */
interface ClientLocale {
  register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void
  bind(namespace: string): (key: string) => string
}

/** The public browser services this plugin's apply consumes. */
interface ClientContext {
  effect(callback: () => () => void, label?: string): void
  on(event: 'internal/service', listener: (name: string, value: unknown) => void): () => void
  get(name: string): unknown
  readonly locale: ClientLocale
}

/** Store reported while a Session has no Ultra projection face yet. */
const INACTIVE_STORE: ObservableSnapshot<boolean> = {
  getSnapshot: () => false,
  subscribe: () => () => { /* a constant store has nothing to unsubscribe */ },
}

/**
 * Read the tier's activation out of the Host's projection view.
 * @param value - raw projection snapshot.
 * @returns whether the mode is entering and no later selection has dirtied it.
 */
function isActive(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { mode?: unknown; dirty?: unknown }
  return (candidate.mode === 'full' || candidate.mode === 'still') && candidate.dirty === false
}

/**
 * Register the Ultra tier over the switcher's tier registry.
 * @param ctx - client root context.
 */
/**
 * Contribute the Ultra tier to the switcher's registry.
 * @param ctx - client context, used to own the contribution's disposal.
 * @param t - translate function bound to this plugin's namespace.
 * @param tiers - the switcher's tier registry.
 * @param index - the Session index.
 * @param rpc - the Connection handle.
 */
function registerUltraTier(
  ctx: ClientContext,
  t: Translate,
  tiers: SeatTierRegistry,
  index: ClientSessions,
  rpc: ClientConnection,
): void {
  // The projection face is resolved once per Session and then kept: the
  // renderer subscribes to an identity-stable store, so a face that appears
  // later is not re-resolved here.
  const stores = new Map<string, ObservableSnapshot<boolean>>()
  const activeStore = (sessionId: string): ObservableSnapshot<boolean> => {
    const existing = stores.get(sessionId)
    if (existing !== undefined) return existing
    const face = index.binding?.(sessionId)?.session.projections.faceOf(CLAUDE_ULTRA_PROJECTION_KEY)
    const store: ObservableSnapshot<boolean> = face === undefined
      ? INACTIVE_STORE
      : {
        getSnapshot: () => isActive(face.getSnapshot()),
        subscribe: (listener: () => void) => face.subscribe(listener),
      }
    stores.set(sessionId, store)
    return store
  }

  const tier: SeatTier = {
    id: 'ultra',
    label: t('tier.label'),
    description: t('tier.description'),
    available: (model: CatalogModel | undefined): boolean =>
      model !== undefined && mappedUltraEffort(model.reasoning?.efforts) !== undefined,
    effort: (model: CatalogModel): string | undefined => mappedUltraEffort(model.reasoning?.efforts),
    active: activeStore,
    async apply(
      sessionId: string,
      selection: ModelSelection,
      model: CatalogModel,
      select: (selection: ModelSelection) => Promise<RemoteResult<void> | undefined>,
    ): Promise<RemoteResult<void> | undefined> {
      const effort = mappedUltraEffort(model.reasoning?.efforts)
      if (effort === undefined) {
        return { ok: false, error: { code: 'claude-ultra/unsupported', message: t('error.unsupported') } }
      }
      const selected = await select({
        provider: selection.provider,
        model: selection.model,
        reasoningEffort: effort,
      })
      if (selected === undefined) return undefined
      if (!selected.ok) return selected
      const answer = await rpc.rpc.call(CLAUDE_ULTRA_API_CHANNEL, CLAUDE_ULTRA_ARM_ENDPOINT, {
        sessionId,
        provider: selection.provider,
        model: selection.model,
        effort,
      })
      return answer.ok ? { ok: true, value: undefined } : answer
    },
  }

  ctx.effect(() => tiers.register(tier), 'dsh-claude-ultra: tier')
}

/**
 * Mount the Ultra tier.
 *
 * dsh-codex-effort-switcher is an optional peer, so its service is read with
 * `ctx.get` rather than `ctx.inject`. A pending inject is reported by the
 * client boot audit as a failed plugin load and blanks the whole surface;
 * reading it here leaves a composition without the switcher activated and
 * simply contributing no tier. The switcher's bundle row precedes this one, so
 * the service is already published when this runs; the service event covers a
 * composition that publishes it later.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-claude-ultra: dictionaries')
  const t = ctx.locale.bind(NS)

  let mounted = false
  const mount = (): void => {
    if (mounted) return
    const registry = ctx.get('codexModelTiers')
    const sessions = ctx.get('sessions')
    const connection = ctx.get('connection')
    if (registry === undefined || sessions === undefined || connection === undefined) return
    mounted = true
    registerUltraTier(ctx, t, registry as SeatTierRegistry, sessions as ClientSessions, connection as ClientConnection)
  }

  mount()
  ctx.on('internal/service', (name: string) => {
    if (name === 'codexModelTiers') mount()
  })
}
