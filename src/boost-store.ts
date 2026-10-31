/** In-memory per-Session record of the newest typed prompt's ultrathink boost. */

/** Per-Session boost store. */
export interface UltraBoostStore {
  /** Record whether one Session's newest typed prompt asked for deeper reasoning. */
  set(sessionId: string, boosted: boolean): void
  /** Whether that prompt asked for deeper reasoning. */
  get(sessionId: string): boolean
  /** Forget one Session. */
  clear(sessionId: string): void
}

/**
 * Create an empty boost store.
 *
 * Claude's ultrathink raises the turn's effort rather than switching a mode, so
 * this is consumed by `agent/request` and cleared when the turn ends — not by
 * the first assembly, which would drop the boost for the turn's later steps.
 * @returns a store holding one boolean per Session.
 */
export function createClaudeUltraBoostStore(): UltraBoostStore {
  const entries = new Map<string, boolean>()
  return {
    set(sessionId: string, boosted: boolean): void {
      entries.set(sessionId, boosted)
    },
    get(sessionId: string): boolean {
      return entries.get(sessionId) === true
    },
    clear(sessionId: string): void {
      entries.delete(sessionId)
    },
  }
}
