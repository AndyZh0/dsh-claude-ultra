/** In-memory Ultra arm intent set between the browser request and the next model step. */

/** One armed model route. */
export interface UltraArmRecord {
  readonly provider: string
  readonly model: string
  readonly effort: string
}

/** Per-Session arm store. */
export interface UltraArmStore {
  /** Arm one Session for the next assembled request. */
  set(sessionId: string, record: UltraArmRecord): void
  /** Read the current arm. */
  get(sessionId: string): UltraArmRecord | undefined
  /** Clear one Session's arm. */
  clear(sessionId: string): void
}

/**
 * Create an empty arm store.
 * @returns a store that copies records on write so callers cannot mutate stored state.
 */
export function createClaudeUltraArmStore(): UltraArmStore {
  const arms = new Map<string, UltraArmRecord>()
  return {
    set(sessionId: string, record: UltraArmRecord): void {
      arms.set(sessionId, { provider: record.provider, model: record.model, effort: record.effort })
    },
    get(sessionId: string): UltraArmRecord | undefined {
      const record = arms.get(sessionId)
      return record === undefined
        ? undefined
        : { provider: record.provider, model: record.model, effort: record.effort }
    },
    clear(sessionId: string): void {
      arms.delete(sessionId)
    },
  }
}
