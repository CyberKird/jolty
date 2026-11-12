import { AppWindow, Bot, Brain, Cpu, FolderTree, Globe, MessageCircle, Puzzle, SquareTerminal, type LucideIcon } from 'lucide-react'
import { useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { ChatItem } from '@shared/types'
import { tr } from '@shared/i18n'
import { toolKind } from './Messages'
import type { Phase } from './LivePanel'

// What the model is doing, drawn like the data board of a control room: the model as a burst of light inside a dashed circle, a bundle of four
// glittering cables leaving it, rising and falling in an S, then peeling off to dark tiles, one for each place it reaches. A cable lights and
// a bright spark runs along its route while a tool is running there; a red dot counts the commands that failed. The glitter is a slow
// cross-fade between layers and the dots twinkle in groups, so it all moves on the graphics chip; with low-power mode or reduced motion it
// holds still and shows the same state. The board scales with its width, which the user drags (the grip, bottom right).

type Node = 'you' | 'model' | 'files' | 'shell' | 'network' | 'browser' | 'agents' | 'skills' | 'memory'
type Lane = 0 | 1 | 2 | 3

interface Def {
  id: Node
  label: () => string
  icon: LucideIcon
  row: 'top' | 'bottom'
  x: number
  lane: Lane
}

// the grid: 360 x 192. Lanes from the top of the bundle: orange, gold, silver, lavender. A lane serves the tiles it passes and ends at the last.
const W = 360
const H = 192
const TOP_Y = 32
const BOTTOM_Y = 160
const NODES: Def[] = [
  { id: 'you', label: () => tr("Tu"), icon: MessageCircle, row: 'top', x: 214, lane: 0 },
  { id: 'model', label: () => tr("Model"), icon: Cpu, row: 'top', x: 256, lane: 1 },
  { id: 'skills', label: () => tr("Skilluri"), icon: Puzzle, row: 'top', x: 298, lane: 2 },
  { id: 'memory', label: () => tr("Memorie"), icon: Brain, row: 'top', x: 340, lane: 2 },
  { id: 'files', label: () => tr("Fișiere"), icon: FolderTree, row: 'bottom', x: 172, lane: 3 },
  { id: 'shell', label: () => tr("Shell"), icon: SquareTerminal, row: 'bottom', x: 214, lane: 3 },
  { id: 'network', label: () => tr("Rețea"), icon: Globe, row: 'bottom', x: 256, lane: 3 },
  { id: 'browser', label: () => tr("Browser"), icon: AppWindow, row: 'bottom', x: 298, lane: 2 },
  { id: 'agents', label: () => tr("Subagenți"), icon: Bot, row: 'bottom', x: 340, lane: 2 }
]

const LANES = [
  { color: '#e4693c', light: '#ffb48f' },
  { color: '#d8a640', light: '#ffe494' },
  { color: '#dcd8ec', light: '#ffffff' },
  { color: '#8f86e8', light: '#d4ceff' }
]
const OFFSET = [-10.5, -3.5, 3.5, 10.5]
const ROPE = 6.4

/** Which place a tool belongs to. */
export function nodeOf(name: string): Node {
  if (/browser|playwright/i.test(name)) return 'browser'
  if (/memory/i.test(name)) return 'memory'
  if (name === 'Skill') return 'skills'
  const k = toolKind(name)
  if (k === 'run') return 'shell'
  if (k === 'read' || k === 'edit' || k === 'write' || k === 'search') return 'files'
  if (k === 'web') return 'network'
  if (k === 'agent') return 'agents'
  return 'model'
}

interface Stats {
  count: Record<Node, number>
  failed: Record<Node, number>
  active: Set<Node>
}

export function statsOf(items: ChatItem[], phase: { key: string }): Stats {
  const count = Object.fromEntries(NODES.map((n) => [n.id, 0])) as Record<Node, number>
  const failed = { ...count }
  const active = new Set<Node>()
  for (const it of items) {
    if (it.kind === 'user') count.you++
    else if (it.kind === 'assistant' || it.kind === 'reasoning') count.model++
    else if (it.kind === 'tool') {
      const n = nodeOf(it.name)
      count[n]++
      if (it.status === 'error') failed[n]++
      if (it.status === 'running') active.add(n)
    }
  }
  if (phase.key === 'think' || phase.key === 'answer' || phase.key === 'plan') active.add('model')
  const last = items[items.length - 1]
  if (last?.kind === 'user' && phase.key !== 'idle') active.add('you')
  return { count, failed, active }
}

// ---- geometry: the bundle is one centre line (a polyline with rounded corners); each cable is the same line shifted sideways ----
type P = { x: number; y: number }
const CORE: P = { x: 46, y: 100 }
const CENTER: P[] = [
  { x: 54, y: 95 },
  { x: 124, y: 38 },
  { x: 142, y: 118 }
]
const BASE_R = [20, 20]
const RUN_Y = 120

const unit = (a: P, b: P): P => {
  const l = Math.hypot(b.x - a.x, b.y - a.y) || 1
  return { x: (b.x - a.x) / l, y: (b.y - a.y) / l }
}
const f = (n: number): string => n.toFixed(2)

/** A polyline with rounded corners as an SVG path; `radii[i]` is the radius at the vertex i + 1. */
function rounded(pts: P[], radii: number[]): string {
  let d = `M ${f(pts[0].x)} ${f(pts[0].y)}`
  for (let i = 1; i < pts.length - 1; i++) {
    const u1 = unit(pts[i - 1], pts[i])
    const u2 = unit(pts[i], pts[i + 1])
    const cross = u1.x * u2.y - u1.y * u2.x
    const dot = Math.max(-1, Math.min(1, u1.x * u2.x + u1.y * u2.y))
    const theta = Math.acos(dot)
    const r = radii[i - 1]
    const t = r * Math.tan(theta / 2)
    d += ` L ${f(pts[i].x - u1.x * t)} ${f(pts[i].y - u1.y * t)} A ${f(r)} ${f(r)} 0 0 ${cross > 0 ? 1 : 0} ${f(pts[i].x + u2.x * t)} ${f(pts[i].y + u2.y * t)}`
  }
  const last = pts[pts.length - 1]
  return `${d} L ${f(last.x)} ${f(last.y)}`
}

/** The centre line moved sideways by `d` (positive = to the right of the way it runs), its corners kept concentric. */
function lane(d: number, endX: number, tail?: { x: number; edge: number; r: number }): string {
  const run: P = { x: endX, y: RUN_Y }
  const line = [...CENTER, run]
  const dirs = [unit(line[0], line[1]), unit(line[1], line[2]), unit(line[2], line[3])]
  const shifted = dirs.map((u, i) => ({ p: { x: line[i].x + -u.y * d, y: line[i].y + u.x * d }, u }))
  const pts: P[] = [shifted[0].p]
  const radii: number[] = []
  for (let i = 1; i < 3; i++) {
    const a = shifted[i - 1]
    const b = shifted[i]
    // where the two shifted lines meet
    const den = a.u.x * b.u.y - a.u.y * b.u.x
    const t = ((b.p.x - a.p.x) * b.u.y - (b.p.y - a.p.y) * b.u.x) / den
    pts.push({ x: a.p.x + a.u.x * t, y: a.p.y + a.u.y * t })
    const cross = a.u.x * b.u.y - a.u.y * b.u.x
    radii.push(BASE_R[i - 1] - d * Math.sign(cross))
  }
  const y = RUN_Y + d
  if (tail) {
    pts.push({ x: tail.x, y }, { x: tail.x, y: tail.edge })
    radii.push(tail.r)
  } else pts.push({ x: endX, y })
  return rounded(pts, radii)
}

/** Where a lane stops: the last tile it serves. */
const laneEnd = (l: Lane): number => Math.max(...NODES.filter((n) => n.lane === l).map((n) => n.x))

const LANE_PATHS = ([0, 1, 2, 3] as Lane[]).map((l) => lane(OFFSET[l], laneEnd(l) + 0.01))
const STUB = 5
const ROUTES = Object.fromEntries(
  NODES.map((n) => {
    const edge = n.row === 'top' ? TOP_Y + 14 : BOTTOM_Y - 14
    return [n.id, { stub: lane(OFFSET[n.lane], n.x, { x: n.x, edge, r: 7 }), route: lane(OFFSET[n.lane], n.x, { x: n.x, edge, r: 7 }) }]
  })
) as Record<Node, { stub: string; route: string }>

// ---- the burst: dots and rays placed once, the same every time ----
const rnd = (() => {
  let s = 7
  return (): number => ((s = (s * 16807) % 2147483647) - 1) / 2147483646
})()
const DOT_COLORS = ['#ffffff', '#d6e6ff', '#ffbfd6', '#ffdca4', '#bcb0ff']
const DOTS = Array.from({ length: 84 }, (_, i) => {
  const a = rnd() * Math.PI * 2
  const r = 5 + Math.pow(rnd(), 0.75) * 34
  return { x: CORE.x + Math.cos(a) * r, y: CORE.y + Math.sin(a) * r, r: 0.45 + rnd() * 1.05, c: DOT_COLORS[Math.floor(rnd() * DOT_COLORS.length)], g: i % 4 }
})
const RAYS = Array.from({ length: 56 }, () => {
  const a = rnd() * Math.PI * 2
  const l = 16 + rnd() * 24
  return { x: CORE.x + Math.cos(a) * l, y: CORE.y + Math.sin(a) * l, o: 0.22 + rnd() * 0.4 }
})

const GRID_KEY = 'jolty.activityWidth'
const savedWidth = (): number | undefined => {
  try {
    const n = Number(localStorage.getItem(GRID_KEY))
    return n >= 200 ? n : undefined
  } catch {
    return undefined
  }
}

export function ActivityGraph({ items, phase, engine, model, context }: { items: ChatItem[]; phase: Phase; engine: string; model?: string; context?: number }) {
  const stats = useMemo(() => statsOf(items, { key: phase.key }), [items, phase.key])
  const waiting = phase.key === 'approval'
  const pct = context === undefined ? undefined : Math.round(context)
  const [width, setWidth] = useState<number | undefined>(savedWidth)
  const wrap = useRef<HTMLDivElement>(null)

  // the grip: the board scales with its width; a double click goes back to the size that fits the panel
  const drag = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    const el = wrap.current
    if (!el) return
    e.preventDefault()
    const grip = e.currentTarget
    grip.setPointerCapture(e.pointerId)
    const start = { x: e.clientX, y: e.clientY, w: el.getBoundingClientRect().width }
    const max = (el.parentElement?.clientWidth ?? 480) - 2
    const move = (ev: PointerEvent): void => setWidth(Math.round(Math.min(max, Math.max(200, start.w + (ev.clientX - start.x + ((ev.clientY - start.y) * W) / H) / 2))))
    const up = (): void => {
      grip.removeEventListener('pointermove', move)
      grip.removeEventListener('pointerup', up)
      grip.removeEventListener('pointercancel', up)
      try {
        const w = el.getBoundingClientRect().width
        localStorage.setItem(GRID_KEY, String(Math.round(w)))
      } catch {
        // a convenience only
      }
    }
    grip.addEventListener('pointermove', move)
    grip.addEventListener('pointerup', up)
    grip.addEventListener('pointercancel', up)
  }
  const reset = (): void => {
    setWidth(undefined)
    try {
      localStorage.removeItem(GRID_KEY)
    } catch {
      // a convenience only
    }
  }

  const at = (x: number, y: number): CSSProperties => ({ left: `${(x / W) * 100}%`, top: `${(y / H) * 100}%` })
  const caption = (text: string, x: number, y: number): ReactNode => (
    <span className="ag-caption" style={{ right: `${((W - x) / W) * 100}%`, top: `${(y / H) * 100}%` }}>
      {text}
    </span>
  )
  const lit = NODES.filter((n) => stats.active.has(n.id))

  return (
    <div ref={wrap} className="ag-wrap" style={width ? ({ '--agw': `${width}px` } as CSSProperties) : undefined}>
      <div className={`actgraph ${phase.on ? 'live-on' : ''} ${waiting ? 'wait' : ''}`} role="img" aria-label={phase.name}>
        {/* the burst: rays and dots twinkling in four groups, inside a dashed circle */}
        <svg className="ag-layer ag-rays" viewBox={`0 0 ${W} ${H}`} aria-hidden>
          {RAYS.map((r, i) => (
            <line key={i} x1={CORE.x} y1={CORE.y} x2={r.x} y2={r.y} strokeOpacity={r.o} />
          ))}
        </svg>
        {[0, 1, 2, 3].map((g) => (
          <svg key={g} className={`ag-layer ag-dots g${g}`} viewBox={`0 0 ${W} ${H}`} aria-hidden>
            {DOTS.filter((d) => d.g === g).map((d, i) => (
              <circle key={i} cx={d.x} cy={d.y} r={d.r} fill={d.c} />
            ))}
          </svg>
        ))}
        <svg className="ag-layer" viewBox={`0 0 ${W} ${H}`} aria-hidden>
          <circle className="ag-dash" cx={CORE.x} cy={CORE.y} r="40" />
          {pct !== undefined && <circle className="ag-ring" cx={CORE.x} cy={CORE.y} r="40" pathLength="100" strokeDasharray={`${pct} 100`} transform={`rotate(-90 ${CORE.x} ${CORE.y})`} />}
        </svg>

        {/* the cables: a dark edge and the body, then two layers of glitter that cross-fade into each other */}
        <svg className="ag-layer" viewBox={`0 0 ${W} ${H}`} aria-hidden>
          {LANE_PATHS.map((d, i) => (
            <g key={i}>
              <path d={d} className="ag-edge" strokeWidth={ROPE + 1.6} />
              <path d={d} stroke={LANES[i].color} strokeWidth={ROPE} />
            </g>
          ))}
          {NODES.map((n) => {
            const { stub } = ROUTES[n.id]
            return (
              <g key={n.id}>
                <path d={stub} className="ag-edge" strokeWidth={STUB + 1.6} />
                <path d={stub} stroke={LANES[n.lane].color} strokeWidth={STUB} />
              </g>
            )
          })}
        </svg>
        {(['a', 'b'] as const).map((k) => (
          <svg key={k} className={`ag-layer ag-glit ${k}`} viewBox={`0 0 ${W} ${H}`} aria-hidden>
            {LANE_PATHS.map((d, i) => (
              <g key={i}>
                <path d={d} stroke={LANES[i].light} strokeWidth={ROPE - 0.8} strokeDasharray={k === 'a' ? '0.5 2.1' : '0.45 3'} strokeDashoffset={k === 'a' ? 0 : 1.1} />
                <path d={d} className="ag-speck" strokeWidth={ROPE - 0.8} strokeDasharray={k === 'a' ? '0.5 2.9' : '0.5 2.4'} strokeDashoffset={k === 'a' ? 1.4 : 0} />
              </g>
            ))}
            {NODES.map((n) => (
              <g key={n.id}>
                <path d={ROUTES[n.id].stub} stroke={LANES[n.lane].light} strokeWidth={STUB - 0.8} strokeDasharray={k === 'a' ? '0.5 2.1' : '0.45 3'} />
                <path d={ROUTES[n.id].stub} className="ag-speck" strokeWidth={STUB - 0.8} strokeDasharray={k === 'a' ? '0.5 2.9' : '0.5 2.4'} strokeDashoffset={1.4} />
              </g>
            ))}
          </svg>
        ))}
        {/* a spark running along the route of every place that is working */}
        {lit.length > 0 && (
          <svg className="ag-layer" viewBox={`0 0 ${W} ${H}`} aria-hidden>
            {lit.map((n) => (
              <g key={n.id}>
                <path d={ROUTES[n.id].route} pathLength="100" className="ag-spark wide" stroke={LANES[n.lane].color} />
                <path d={ROUTES[n.id].route} pathLength="100" className="ag-spark" />
              </g>
            ))}
          </svg>
        )}

        {/* the light at the heart of the burst, and what it is */}
        <i className="ag-glow" style={at(CORE.x, CORE.y)} />
        <span className="ag-pill" style={at(CORE.x, CORE.y)}>
          <b>{engine.toUpperCase()}</b>
          {pct !== undefined ? <em>{pct}%</em> : model ? <em>{model.length > 9 ? `${model.slice(0, 8)}…` : model}</em> : null}
        </span>

        {caption(tr("Context"), 198, TOP_Y)}
        {caption(tr("Unelte"), 154, BOTTOM_Y)}

        {NODES.map((n) => {
          const on = stats.active.has(n.id)
          const used = stats.count[n.id] > 0
          const Icon = n.icon
          return (
            <div key={n.id} className={`ag-node ${on ? 'on' : ''} ${used ? 'used' : ''}`} style={{ ...at(n.x, n.row === 'top' ? TOP_Y : BOTTOM_Y), '--c': LANES[n.lane].color } as CSSProperties}>
              <span className="ag-tile">
                <Icon className="ag-icon" size={15} strokeWidth={1.7} />
                {used && <span className="ag-count">{stats.count[n.id]}</span>}
                {stats.failed[n.id] > 0 && <span className="ag-fail">{stats.failed[n.id]}</span>}
              </span>
              <span className={`ag-label ${n.row}`}>{n.label()}</span>
            </div>
          )
        })}
      </div>
      <button className="ag-grip" onPointerDown={drag} onDoubleClick={reset} aria-label={tr("Mărime")} title={tr("Trage ca să schimbi mărimea. Dublu clic: mărimea potrivită.")}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M9 1 1 9M9 5 5 9" />
        </svg>
      </button>
    </div>
  )
}
