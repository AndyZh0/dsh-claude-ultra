/**
 * Structural views of the public DSH Host services this plugin consumes.
 *
 * The plugin depends on no DSH package at build time. The published
 * \`@deepseek-ai/dsh-*\` versions on npm (0.0.1-rc.1) do not match the running
 * runtime (0.2.0-rc.2 checkout, 0.2.1-rc.5 desktop), so installing them is not
 * possible; every declaration here mirrors the surface this plugin reads across
 * the plugin boundary instead. The Host entry bundles with \`@deepseek-ai/*\` left
 * external, so the running DSH process supplies the real implementations.
 */

/** One Session event, narrowed to the members this plugin folds. */
export interface UltraSessionEvent {
  readonly type: string
  readonly data?: {
    readonly message?: { readonly content?: readonly UltraContentBlock[] }
  }
}

/** One user message, as the inbox and the Session log carry it. */
export interface UltraUserMessage {
  readonly content?: readonly UltraContentBlock[]
  /** Where the message came from; \`user\` marks a prompt the human typed. */
  readonly source?: { readonly kind?: string }
}

/** One block of a logged message. */
export interface UltraContentBlock {
  readonly type: string
  readonly text?: string
}

/** Identity of one Session. Branded in DSH; a plain string here. */
export type UltraSessionId = string

/** One Session header member this plugin reads. */
export interface UltraSessionHeader {
  /** Why the Session exists; \`subagent\` marks a delegated child. */
  readonly origin?: string
  /** Session that spawned this one, when it is a child. */
  readonly parentSession?: UltraSessionId
}

/** One Session as this plugin reads it. */
export interface UltraSession {
  readonly id: UltraSessionId
  readonly header: UltraSessionHeader
  /** Header of the last request this Session logged, when any. */
  requestHeader(): UltraRequestHeader | undefined
}

/** The persisted request header of one Session. */
export interface UltraRequestHeader {
  readonly config?: UltraCallConfig
}

/** The provider/model/effort triple one request will use. */
export interface UltraCallConfig {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: unknown
}

/** One Agent as this plugin reads it. */
export interface UltraAgent {
  readonly session: UltraSession
}

/** One adapter-owned reasoning level. */
export interface UltraReasoningEffort {
  readonly id: string
}

/** Reasoning metadata advertised for one exact model route. */
export interface UltraModelInfo {
  readonly reasoning?: { readonly efforts?: readonly UltraReasoningEffort[] }
}

/** One model selection. */
export interface UltraModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** Persisted selection projection of one Session. */
export interface UltraModelSelectionProjection {
  readonly pending?: UltraModelSelection
  readonly lastUsed?: UltraModelSelection
}

/** One contributed system-prompt section. */
export interface UltraPromptSection {
  readonly name: string
  readonly order?: number
  readonly text: string
}

/** The assembly a waterfall listener receives and returns. */
export interface UltraPromptAssembly {
  readonly sections: readonly UltraPromptSection[]
}

/** Merge-extensible assembly context; DSH's agent runtime adds \`agent\`. */
export interface UltraAssembleContext {
  readonly agent?: UltraAgent
}

/** One registered Session projection definition. */
export interface UltraProjectionDefinition<S> {
  readonly key: string
  readonly stateVersion: number
  readonly stateSchema: unknown
  readonly init: () => S
  readonly apply: (state: S, event: UltraSessionEvent) => S
  readonly wire: { readonly viewSchema: unknown; readonly view: (state: S) => unknown }
}

/**
 * The Session projection registry.
 *
 * \`stateOf\` is generic the way DSH types it: the caller's key selects the
 * registered state type, so reading this plugin's own key needs no runtime check.
 */
export interface UltraSessionProjections {
  register<S>(definition: UltraProjectionDefinition<S>): () => void
  stateOf<S>(session: UltraSession, key: string): S | undefined
}

/** The Session registry. */
export interface UltraSessions {
  get(id: UltraSessionId): UltraSession | undefined
}

/** The Agent registry. */
export interface UltraAgents {
  get(id: UltraSessionId): UltraAgent | undefined
}

/** The model/route resolution service. */
export interface UltraLlm {
  resolveModelInfo(provider: string, model: string): Promise<UltraModelInfo>
  resolveCallConfig(request: { provider: string; model: string; reasoningEffort: string }): Promise<UltraCallConfig>
}

/** One exact Fetch route registration. */
export interface UltraFetchRoute {
  readonly path: string
  readonly methods: readonly string[]
  readonly requestBody: 'buffered'
  fetch(request: Request): Promise<Response>
}

/** The client-connection service. */
export interface UltraConnection {
  readonly fetch: { register(route: UltraFetchRoute): () => void }
}

/** The Host context this plugin's apply requires. */
export interface ClaudeUltraContext {
  /** Register a contribution; the callback returns its disposer. */
  effect(callback: () => () => void, label?: string): void
  on(
    event: 'system-prompt/assemble',
    listener: (assembly: UltraPromptAssembly, context: UltraAssembleContext, next: () => Promise<UltraPromptAssembly>) => Promise<UltraPromptAssembly>,
  ): () => void
  on(event: 'session/event', listener: (session: UltraSession, event: UltraSessionEvent) => void): () => void
  on(
    event: 'agent/inbox/inserted',
    listener: (payload: { readonly agent: UltraAgent; readonly message: UltraUserMessage }) => void,
  ): () => void
  on(
    event: 'agent/pre-step',
    listener: (
      payload: { readonly agent: UltraAgent; readonly messages: readonly UltraUserMessage[] },
      next: () => Promise<unknown>,
    ) => Promise<unknown>,
  ): () => void
  on(
    event: 'agent/request',
    listener: (payload: { readonly agent: UltraAgent }, next: () => Promise<UltraCallConfig>) => Promise<UltraCallConfig>,
  ): () => void
  on(event: 'agent/disposed', listener: (payload: { readonly agent: UltraAgent }) => void): () => void
  readonly logger: { warn(message: string): void }
  readonly sessionProjections: UltraSessionProjections
  readonly sessions: UltraSessions
  readonly llm: UltraLlm
  readonly agents: UltraAgents
  readonly connection: UltraConnection
}
