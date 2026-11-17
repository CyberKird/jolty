import { useRef, type CSSProperties } from 'react'

// The core of the activity board: the model. A shaded sphere in the theme's material (activity-orbs.ts: obsidian in Volt, clear glass in
// Glass, frosted pearl in Frost) with the context used written inside it, a ring around it filled as far as the context goes, ticks like a
// dial. While the model works it glows from inside and its light breathes; every call sends a ripple out of it. Each of those is its own
// layer moved by transform or opacity only.
const R = 25
const C = 2 * Math.PI * R
const TICKS = Array.from({ length: 48 }, (_, i) => (i * 360) / 48)

export function ActivityCore({ style, pct, total, sprite }: { style: CSSProperties; pct?: number; total: number; sprite: CSSProperties }) {
  // a ripple only for calls made while the board is open
  const first = useRef(total)
  const p = pct === undefined ? 0 : Math.max(0, Math.min(100, pct))
  return (
    <div className={`ag-core ${pct !== undefined && pct >= 80 ? 'high' : ''}`} style={{ ...style, ...sprite }} aria-hidden>
      <i className="ag-core-halo" />
      <svg className="ag-core-ring" viewBox="-32 -32 64 64">
        <g className="ag-core-ticks">
          {TICKS.map((a) => (
            <line key={a} x1="0" y1={-R - 3.2} x2="0" y2={-R - (a % 90 === 0 ? 5.6 : 4.4)} transform={`rotate(${a})`} />
          ))}
        </g>
        <circle className="ag-core-track" r={R} />
        {pct !== undefined && <circle className="ag-core-arc" r={R} strokeDasharray={`${(C * p) / 100} ${C}`} transform="rotate(-90)" />}
      </svg>
      <i className="ag-orb-back" />
      <i className="ag-orb-glow" />
      {total !== first.current && <i key={total} className="ag-core-ripple" />}
      {pct !== undefined && (
        <span className="ag-core-val">
          {pct}
          <small>%</small>
        </span>
      )}
      <i className="ag-orb-front" />
    </div>
  )
}
