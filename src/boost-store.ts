/** In-memory per-Session record of the newest typed prompt's ultrathink boost. */

/** Per-Session boost store. */
export interface UltraBoostStore {
  /** Record whether one Session's newest typed prompt asked for deeper reasoning, and unbind it. */
  set(sessionId: string, boosted: boolean): void
  /** Whether that prompt asked for deeper reasoning. */
  get(sessionId: string): boolean
  /** The turn that claimed the prompt, once one has. */
  turnOf(sessionId: string): number | undefined
  /** Bind the boost to the turn that claimed the prompt. */
  bind(sessionId: string, turn: number): void
  /** Forget one Session's boost if that turn is the one it was bound to. */
  release(sessionId: string, turn: number): void
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
  const entries = new Map<string, { boosted: boolean; turn?: number }>()
  return {
    set(sessionId: string, boosted: boolean): void {
      entries.set(sessionId, { boosted })
    },
    get(sessionId: string): boolean {
      return entries.get(sessionId)?.boosted === true
    },
    turnOf(sessionId: string): number | undefined {
      return entries.get(sessionId)?.turn
    },
    bind(sessionId: string, turn: number): void {
      const entry = entries.get(sessionId)
      if (entry !== undefined) entries.set(sessionId, { ...entry, turn })
    },
    release(sessionId: string, turn: number): void {
      if (entries.get(sessionId)?.turn === turn) entries.delete(sessionId)
    },
    clear(sessionId: string): void {
      entries.delete(sessionId)
    },
  }
}
