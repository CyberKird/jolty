import type { CSSProperties } from 'react'
import './liquid.css'

/**
 * A glass sphere with liquid in it: the level is the percentage, the surface ripples slowly. Used where a number says how full
 * something is (the context of a conversation). Everything that moves is a transform on a layer of its own, so it runs on the GPU
 * and costs the main thread nothing; weak PCs (low-power mode) and reduced motion get the same sphere holding still.
 */
export function Liquid({ pct, size = 20, high = false }: { pct: number; size?: number; high?: boolean }) {
  const p = Math.max(0, Math.min(100, pct))
  return (
    <span className={`liquid ${high ? 'high' : ''}`} data-empty={p < 1 ? '' : undefined} style={{ '--lvl': p, '--ls': `${size}px` } as CSSProperties} aria-hidden>
      <span className="liquid-fill">
        <i className="liquid-wave b" />
        <i className="liquid-wave a" />
        <i className="liquid-body" />
      </span>
      <span className="liquid-shine" />
    </span>
  )
}
