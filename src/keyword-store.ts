/** In-memory per-Session record of the newest typed prompt's keyword opt-in. */

/** Per-Session keyword store. */
export interface UltraKeywordStore {
  /** Record whether one Session's newest typed prompt carries the keyword. */
  set(sessionId: string, keyword: boolean): void
  /** Whether that prompt carries the keyword. */
  get(sessionId: string): boolean
  /** Forget one Session. */
  clear(sessionId: string): void
}

/**
 * Create an empty keyword store.
 * @returns a store holding one boolean per Session.
 */
export function createClaudeUltraKeywordStore(): UltraKeywordStore {
  const entries = new Map<string, boolean>()
  return {
    set(sessionId: string, keyword: boolean): void {
      entries.set(sessionId, keyword)
    },
    get(sessionId: string): boolean {
      return entries.get(sessionId) === true
    },
    clear(sessionId: string): void {
      entries.delete(sessionId)
    },
  }
}
