import type { CSSProperties } from 'react'
import './liquid.css'
import { orb, useOrbTheme } from './activity-orbs'

/**
 * A sphere with liquid in it (shaded like the activity board's orbs, activity-orbs.ts): the level is the percentage, the surface
 * ripples slowly. Used where a number says how full
 * something is (the context of a conversation). Everything that moves is a transform on a layer of its own, so it runs on the GPU
 * and costs the main thread nothing; weak PCs (low-power mode) and reduced motion get the same sphere holding still.
 */
/** `calm`: the surface holds still (nothing is working), so the sphere costs nothing at all. */
export function Liquid({ pct, size = 20, high = false, calm = false }: { pct: number; size?: number; high?: boolean; calm?: boolean }) {
  const p = Math.max(0, Math.min(100, pct))
  // the same sphere as the activity board's orbs: its body behind the liquid, its highlights over it
  useOrbTheme()
  const o = orb('liquid', Math.max(32, size * 2))
  return (
    <span className={`liquid ${high ? 'high' : ''} ${calm ? 'calm' : ''}`} data-empty={p < 1 ? '' : undefined} style={{ '--lvl': p, '--ls': `${size}px`, '--orb-back': `url(${o.back})`, '--orb-front': `url(${o.front})` } as CSSProperties} aria-hidden>
      <span className="liquid-fill">
        <i className="liquid-wave b" />
        <i className="liquid-wave a" />
        <i className="liquid-body" />
      </span>
      <span className="liquid-shine" />
    </span>
  )
}
