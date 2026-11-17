import { useRef, type CSSProperties } from 'react'

// The core of the activity board: the model. A lit body in the theme's material (a machined puck in Volt, a glass sphere in Glass, white
// enamel in Frost; activity-materials.css), a ring around it filled as far as the context is used, ticks like a dial. While the model works
// its light breathes and a highlight turns round it; every call sends a ripple out of it. Each of those is its own layer moved by transform
// or opacity only.
const R = 25
const C = 2 * Math.PI * R
const TICKS = Array.from({ length: 48 }, (_, i) => (i * 360) / 48)

export function ActivityCore({ style, pct, total }: { style: CSSProperties; pct?: number; total: number }) {
  // a ripple only for calls made while the board is open
  const first = useRef(total)
  const p = pct === undefined ? 0 : Math.max(0, Math.min(100, pct))
  return (
    <div className={`ag-core ${pct !== undefined && pct >= 80 ? 'high' : ''}`} style={style} aria-hidden>
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
      <i className="ag-core-body" />
      <i className="ag-core-spec" />
      {total !== first.current && <i key={total} className="ag-core-ripple" />}
      {pct !== undefined && (
        <span className="ag-core-val">
          {pct}
          <small>%</small>
        </span>
      )}
    </div>
  )
}
