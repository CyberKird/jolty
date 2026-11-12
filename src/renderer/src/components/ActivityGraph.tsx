import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { ChatItem } from '@shared/types'
import { tr } from '@shared/i18n'
import { toolKind } from './Messages'
import { dragShield } from '../dragShield'
import type { Phase } from './LivePanel'
import { useCables } from './activity-cables'
import { BOTTOM_Y, CORE, H, LANES, NODES, TOP_Y, W, type Node } from './activity-geometry'

// What the model is doing, drawn like the data board of the reference video: the model as a burst of light, a bundle
// of four glitter cables leaving it, rising and falling in an S, then peeling off to dark tiles, one for each place it reaches. Where the
// model is working right now, a warm rope of three strands runs straight from the light to that tile, and moving somewhere else plays the
// transfer of the video (activity-canvas.ts). A red dot counts the commands that failed. The cables are painted on canvases and twinkle by
// opacity, so it all runs on the graphics chip; with low-power mode or reduced motion it holds still and shows the same state. The board
// scales with its width, which the user drags (the grip, bottom right).

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
  /** where the live rope goes: the place of the newest running tool, else the model while it thinks */
  target: Node | null
}

export function statsOf(items: ChatItem[], phase: { key: string }): Stats {
  const count = Object.fromEntries(NODES.map((n) => [n.id, 0])) as Record<Node, number>
  const failed = { ...count }
  const active = new Set<Node>()
  let target: Node | null = null
  for (const it of items) {
    if (it.kind === 'user') count.you++
    else if (it.kind === 'assistant' || it.kind === 'reasoning') count.model++
    else if (it.kind === 'tool') {
      const n = nodeOf(it.name)
      count[n]++
      if (it.status === 'error') failed[n]++
      if (it.status === 'running') {
        active.add(n)
        target = n
      }
    }
  }
  if (phase.key === 'think' || phase.key === 'answer' || phase.key === 'plan') active.add('model')
  const last = items[items.length - 1]
  if (last?.kind === 'user' && phase.key !== 'idle') active.add('you')
  if (!target && active.has('model')) target = 'model'
  return { count, failed, active, target }
}

// ---- the burst: dots and rays placed once, the same every time ----
const rnd = (() => {
  let s = 7
  return (): number => ((s = (s * 16807) % 2147483647) - 1) / 2147483646
})()
const DOT_COLORS = ['#ffffff', '#d6e6ff', '#ffbfd6', '#ffdca4', '#bcb0ff']
const DOTS = Array.from({ length: 150 }, (_, i) => {
  const a = rnd() * Math.PI * 2
  const r = 5 + Math.pow(rnd(), 0.75) * 34
  // no outline round the cloud: the sparks thin out and dim towards the edge, like light
  const o = 1 - Math.pow(r / 40, 2) * 0.85
  return { x: CORE.x + Math.cos(a) * r, y: CORE.y + Math.sin(a) * r, r: 0.45 + rnd() * 1.05, c: DOT_COLORS[Math.floor(rnd() * DOT_COLORS.length)], g: i % 4, o }
})
const RAYS = Array.from({ length: 84 }, () => {
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

// ---- the bar above the Live tabs: dragged down it makes the board bigger (the tabs get the rest), up smaller; a double click fits it ----
const SIZE_EVENT = 'jolty:activity-size'
const MIN_W = 200

function saveWidth(w: number | undefined): void {
  try {
    if (w) localStorage.setItem(GRID_KEY, String(Math.round(w)))
    else localStorage.removeItem(GRID_KEY)
  } catch {
    // a convenience only
  }
  window.dispatchEvent(new CustomEvent(SIZE_EVENT, { detail: w }))
}

let lastDown = 0

export function ActivitySizer() {
  const start = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    // the drag shield covers the bar between the two clicks, so the browser never sees a double click: timed here
    const now = performance.now()
    if (now - lastDown < 400) {
      lastDown = 0
      e.preventDefault()
      return saveWidth(undefined)
    }
    lastDown = now
    const el = document.querySelector<HTMLElement>('.live .ag-wrap')
    if (!el) return
    e.preventDefault()
    const w0 = el.getBoundingClientRect().width
    const max = (el.parentElement?.clientWidth ?? 480) - 2
    const y0 = e.clientY
    let w = w0
    const root = document.documentElement
    root.classList.add('resizing')
    const unshield = dragShield('row-resize')
    const move = (ev: PointerEvent): void => {
      // the board keeps its proportions: a pixel of height is W / H pixels of width
      w = Math.round(Math.min(max, Math.max(MIN_W, w0 + ((ev.clientY - y0) * W) / H)))
      el.style.setProperty('--agw', `${w}px`)
    }
    const up = (): void => {
      root.classList.remove('resizing')
      unshield()
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      saveWidth(w)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }
  return (
    <div
      className="ag-sizer"
      role="separator"
      aria-orientation="horizontal"
      aria-label={tr("Mărimea hărții")}
      title={tr("Trage ca să schimbi mărimea; dublu clic revine la mărimea inițială")}
      onPointerDown={start}
    />
  )
}

// The burst grows with the model: more stars and rays and a bigger light for a smarter model (intelligence 0..65 of the
// leaderboard), and a higher thinking level turns it faster and makes it twinkle quicker. Stars come and go by opacity only.
const IQ_TOP = 65
const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
function galaxy(iq: number | undefined, effort: string | undefined): { stars: number; rays: number; vars: CSSProperties } {
  const q = Math.min(1, Math.max(0, (iq ?? 40) / IQ_TOP))
  const e = EFFORTS.indexOf((effort || 'high').toLowerCase())
  const lvl = (e < 0 ? 3 : e) / 5
  return {
    stars: Math.round(26 + q * (DOTS.length - 26)),
    rays: Math.round(12 + q * (RAYS.length - 12)),
    vars: { '--ag-g': (0.68 + q * 0.5).toFixed(3), '--ag-spin': `${Math.round(170 - lvl * 120)}s`, '--ag-tw': (1.5 - lvl * 0.75).toFixed(3), '--ag-ray': (0.5 + lvl * 0.5).toFixed(3) } as CSSProperties
  }
}

export function ActivityGraph({ items, phase, engine, model, context, iq, effort }: { items: ChatItem[]; phase: Phase; engine: string; model?: string; context?: number; iq?: number; effort?: string }) {
  const stats = useMemo(() => statsOf(items, { key: phase.key }), [items, phase.key])
  const waiting = phase.key === 'approval'
  const pct = context === undefined ? undefined : Math.round(context)
  const [width, setWidth] = useState<number | undefined>(savedWidth)
  const wrap = useRef<HTMLDivElement>(null)
  const cables = useCables(stats.target)
  const gx = useMemo(() => galaxy(iq, effort), [iq, effort])
  // the bar above the tabs sets the size too
  useEffect(() => {
    const on = (e: Event): void => setWidth((e as CustomEvent<number | undefined>).detail)
    window.addEventListener(SIZE_EVENT, on)
    return () => window.removeEventListener(SIZE_EVENT, on)
  }, [])

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
  return (
    <div ref={wrap} className="ag-wrap" style={width ? ({ '--agw': `${width}px` } as CSSProperties) : undefined}>
      <div ref={cables.box} className={`actgraph ${phase.on ? 'live-on' : ''} ${waiting ? 'wait' : ''}`} style={gx.vars} role="img" aria-label={phase.name}>
        {/* the burst: rays and dots twinkling in four groups, fading out towards the edge */}
        <svg className="ag-layer ag-rays" viewBox={`0 0 ${W} ${H}`} aria-hidden>
          {RAYS.map((r, i) => (
            <line key={i} x1={CORE.x} y1={CORE.y} x2={r.x} y2={r.y} strokeOpacity={r.o} style={{ opacity: i < gx.rays ? 1 : 0 }} />
          ))}
        </svg>
        {[0, 1, 2, 3].map((g) => (
          <svg key={g} className={`ag-layer ag-dots g${g}`} viewBox={`0 0 ${W} ${H}`} aria-hidden>
            {DOTS.map((d, i) => ({ d, i }))
              .filter(({ d }) => d.g === g)
              .map(({ d, i }) => (
              <circle key={i} cx={d.x} cy={d.y} r={d.r} fill={d.c} fillOpacity={d.o} style={{ opacity: i < gx.stars ? 1 : 0 }} />
            ))}
          </svg>
        ))}

        {/* the glitter cables (activity-gl.ts) */}
        <canvas ref={cables.cv} className="ag-cv" aria-hidden />

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
            <div key={n.id} className={`ag-node ${on ? 'on' : ''} ${used ? 'used' : ''} ${cables.arriving === n.id ? 'arrive' : ''}`} style={{ ...at(n.x, n.row === 'top' ? TOP_Y : BOTTOM_Y), '--c': LANES[n.lane].color } as CSSProperties}>
              <span className="ag-tile">
                <Icon className="ag-icon" size={15} strokeWidth={1.7} />
                {used && <span className="ag-count">{stats.count[n.id]}</span>}
                {stats.failed[n.id] > 0 && <span className="ag-fail">{stats.failed[n.id]}</span>}
              </span>
              <span className={`ag-label ${n.row}`}>{n.label()}</span>
            </div>
          )
        })}
        {/* the sparks a place gathers from when the work moves there */}
        <canvas ref={cables.fx} className="ag-cv" aria-hidden />
      </div>
      <button className="ag-grip" onPointerDown={drag} onDoubleClick={reset} aria-label={tr("Mărime")} title={tr("Trage ca să schimbi mărimea. Dublu clic: mărimea potrivită.")}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M9 1 1 9M9 5 5 9" />
        </svg>
      </button>
    </div>
  )
}
