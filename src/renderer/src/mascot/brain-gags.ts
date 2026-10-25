import type { Eyes, Pose } from './places'
import type { Sound } from './sfx'

export interface Gag {
  name: string
  pose: Pose
  eyes: Eyes
  ms: number
  bubble?: string
  sound?: Sound
  /** seconds before he may do it again */
  cool: number
  weight: number
  /** only where this fits (a wall to push) */
  needs?: 'wall'
}

/** what he does with nothing to do, each with its own cooldown so nothing repeats like a loop */
export const GAGS: Gag[] = [
  { name: 'dance', pose: 'dance', eyes: 'happy', ms: 4200, sound: 'beat', cool: 90, weight: 2 },
  { name: 'fight', pose: 'fight', eyes: 'focus', ms: 3600, cool: 120, weight: 2 },
  { name: 'push', pose: 'push', eyes: 'focus', ms: 3000, cool: 150, weight: 1, needs: 'wall' },
  { name: 'scratch', pose: 'scratch', eyes: 'open', ms: 2400, cool: 60, weight: 2 },
  { name: 'stretch', pose: 'stretch', eyes: 'sleepy', ms: 2100, cool: 80, weight: 1 },
  { name: 'shrug', pose: 'shrug', eyes: 'open', ms: 1300, cool: 60, weight: 1 }
]

/** one gag that is off cooldown and fits, weighted at random; the caller starts it and calls `done` */
export function pickGag(cool: Map<string, number>, now: number, wall: boolean): Gag | null {
  const ready = GAGS.filter((g) => (cool.get(g.name) ?? 0) <= now && (g.needs !== 'wall' || wall))
  const total = ready.reduce((n, g) => n + g.weight, 0)
  if (!total) return null
  let roll = Math.random() * total
  for (const g of ready) if ((roll -= g.weight) < 0) return g
  return ready[0]
}
