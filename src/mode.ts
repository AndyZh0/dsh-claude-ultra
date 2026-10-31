/** Pure Ultra effort mapping shared by the Host and the browser half. */

/** One advertised reasoning level; only its stable id matters here. */
export interface UltraEffortCandidate {
  readonly id: string
}

/**
 * Resolve the adapter effort Ultra selects for one model.
 *
 * Claude's ultracode sits at the top of its effort scale (xhigh there). DSH
 * models advertise their own levels, so this prefers max and otherwise takes the
 * highest advertised level. An effort the adapter does not advertise would be
 * rejected, so this returns undefined instead of inventing one.
 * @param efforts - advertised levels in display order.
 * @returns the effort id to select, or undefined when Ultra is unavailable.
 */
export function mappedUltraEffort(efforts: readonly UltraEffortCandidate[] | undefined): string | undefined {
  if (efforts === undefined) return undefined
  for (const effort of efforts) {
    if (effort.id === 'max') return 'max'
  }
  for (let index = efforts.length - 1; index >= 0; index -= 1) {
    const id = efforts[index]?.id
    if (id !== undefined && id !== 'off' && id !== 'ultra') return id
  }
  return undefined
}
