// How long the agent has worked in the current turn. The end of a turn cannot be known, so nothing here estimates it.

export interface Clock {
  /** the turn started */
  turn?: number
}

/** 75 000 ms -> "1:15" */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const mm = String(Math.floor((s % 3600) / 60))
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${mm.padStart(2, '0')}:${ss}` : `${mm}:${ss}`
}
