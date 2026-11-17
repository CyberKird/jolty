import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { ChatItem } from '@shared/types'
import { tr } from '@shared/i18n'
import { toolKind } from './Messages'
import { dragShield } from '../dragShield'
import type { Phase } from './LivePanel'
import { usePulses, travelMs } from './activity-pulses'
import { CORE, H, LIGHT, NODES, ROUTES, TOP_Y, BOTTOM_Y, W, WIRES, tileY, type Node } from './activity-geometry'
import { ActivityCore } from './ActivityCore'
import { useTilt } from './activity-tilt'
import { lightAt, orb, useOrbTheme, type Light, type OrbState } from './activity-orbs'
import { useLabelFit } from './activity-fit'

// every orb's light, from where it sits relative to the board's one light (and a small variation of its own)
const LIGHTS = Object.fromEntries(NODES.map((n, i) => [n.id, lightAt(n.x, tileY(n), LIGHT, i + 1)])) as Record<Node, Light>
const CORE_LIGHT = lightAt(CORE.x, CORE.y, LIGHT, 0)

// What the model is doing, as a small control surface: the model is the core on the left (its ring is the context used), fibres fan out
// of it into one flat bus and turn off to a tile for every place it reaches. Every call sends one packet of light down the fibre to the
// place it used, and that tile's count ticks as it lands; where the model works right now, light runs steadily down that route, faster
// when it works faster. A red badge counts the commands that failed. The look comes from the theme (activity-materials.css): keys on a
// hardware panel in Volt, glass pucks in Glass, white enamel in Frost. Idle, nothing moves and nothing is drawn; with low-power mode or
// reduced motion it holds still and shows the same state. The board scales with its width, which the user drags (the grip, bottom right).

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
  /** where the light runs: the place of the newest running tool, else the model while it thinks */
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

// how busy the model is: calls in the last 12 seconds make the light run faster (1 to 2.2 times)
function useThroughput(total: number): number {
  const times = useRef<number[]>([])
  const last = useRef(total)
  const [speed, setSpeed] = useState(1)
  useEffect(() => {
    const now = performance.now()
    const more = total - last.current
    last.current = total
    for (let i = 0; i < Math.min(8, more); i++) times.current.push(now)
    times.current = times.current.filter((t) => now - t < 12000)
    setSpeed(1 + Math.min(1.2, times.current.length / 6))
  }, [total])
  return speed
}

const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const IQ_TOP = 65

export function ActivityGraph({ items, phase, engine, model, context, iq, effort }: { items: ChatItem[]; phase: Phase; engine: string; model?: string; context?: number; iq?: number; effort?: string }) {
  const stats = useMemo(() => statsOf(items, { key: phase.key }), [items, phase.key])
  const waiting = phase.key === 'approval'
  const pct = context === undefined ? undefined : Math.round(context)
  const [width, setWidth] = useState<number | undefined>(savedWidth)
  const wrap = useRef<HTMLDivElement>(null)
  const total = useMemo(() => NODES.reduce((a, n) => a + stats.count[n.id], 0), [stats.count])
  const speed = useThroughput(total)
  // the light runs to where the model works, but not while it waits for the user
  const target = waiting ? null : stats.target
  const pulses = usePulses({ target, counts: stats.count, speed })
  const tilt = useTilt()
  useLabelFit(pulses.box, [])
  useOrbTheme()
  const sprite = (st: OrbState, light: Light, size = 64): CSSProperties => {
    const o = orb(st, size, light)
    return { '--orb-back': `url(${o.back})`, '--orb-front': `url(${o.front})` } as CSSProperties
  }
  // no ticks and no shakes for what was already there when the board opened
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setReady(true), 400)
    return () => clearTimeout(t)
  }, [])
  // the place the work just moved to lifts its tile once
  const [arriving, setArriving] = useState<Node | null>(null)
  useEffect(() => {
    if (!target) return
    setArriving(target)
    const t = setTimeout(() => setArriving(null), 700)
    return () => clearTimeout(t)
  }, [target])
  useEffect(() => {
    const on = (e: Event): void => setWidth((e as CustomEvent<number | undefined>).detail)
    window.addEventListener(SIZE_EVENT, on)
    return () => window.removeEventListener(SIZE_EVENT, on)
  }, [])
  // a smarter model makes a brighter core; a higher thinking level turns its light faster
  const q = Math.min(1, Math.max(0, (iq ?? 40) / IQ_TOP))
  const lvl = Math.max(0, EFFORTS.indexOf((effort || 'high').toLowerCase())) / 5
  const vars = { '--ag-g': (0.55 + q * 0.45).toFixed(3), '--ag-spin': `${Math.round(14 - lvl * 9)}s` } as CSSProperties

  // the grip: the board scales with its width; a double click goes back to the size that fits the panel
  const drag = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    const el = wrap.current
    if (!el) return
    e.preventDefault()
    const grip = e.currentTarget
    grip.setPointerCapture(e.pointerId)
    const start = { x: e.clientX, y: e.clientY, w: el.getBoundingClientRect().width }
    const max = (el.parentElement?.clientWidth ?? 480) - 2
    const move = (ev: PointerEvent): void => setWidth(Math.round(Math.min(max, Math.max(MIN_W, start.w + (ev.clientX - start.x + ((ev.clientY - start.y) * W) / H) / 2))))
    const up = (): void => {
      grip.removeEventListener('pointermove', move)
      grip.removeEventListener('pointerup', up)
      grip.removeEventListener('pointercancel', up)
      try {
        localStorage.setItem(GRID_KEY, String(Math.round(el.getBoundingClientRect().width)))
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
  const engineName = engine ? engine[0].toUpperCase() + engine.slice(1) : ''
  return (
    <div ref={wrap} className="ag-wrap" style={width ? ({ '--agw': `${width}px` } as CSSProperties) : undefined}>
      <div
        ref={pulses.box}
        className={`actgraph ${phase.on ? 'live-on' : ''} ${waiting ? 'wait' : ''} ${ready ? 'ready' : ''}`}
        style={vars}
        role="img"
        aria-label={phase.name}
        onPointerMove={tilt.move}
        onPointerLeave={tilt.leave}
      >
        <div ref={tilt.stage} className="ag-stage">
          <svg className="ag-wires" viewBox={`0 0 ${W} ${H}`} aria-hidden>
            {WIRES.map((w) => (
              <path key={`s${w.id}`} className="ag-sheath" d={w.d} />
            ))}
            {WIRES.map((w) => (
              <path key={w.id} className={`ag-fibre ${w.nodes.some((n) => stats.count[n] > 0) ? 'used' : ''}`} d={w.d} />
            ))}
            {/* the route to where the model works, lit from the core to that key only */}
            {target && <path key={target} className="ag-fibre lit" d={ROUTES[target]} />}
          </svg>
          <canvas ref={pulses.cv} className="ag-cv" aria-hidden />

          <ActivityCore style={at(CORE.x, CORE.y)} pct={pct} total={total} sprite={sprite(waiting ? 'core-wait' : phase.on ? 'core-on' : 'core', CORE_LIGHT, 96)} />
          <span className="ag-engine" style={at(CORE.x, CORE.y + 36)}>
            {engineName}
            {pct === undefined && model ? <em>{model.length > 10 ? `${model.slice(0, 9)}…` : model}</em> : null}
          </span>

          {caption(tr("Context"), 161, TOP_Y)}
          {caption(tr("Unelte"), 110, BOTTOM_Y)}

          {NODES.map((n) => {
            const on = stats.active.has(n.id)
            const count = stats.count[n.id]
            const failed = stats.failed[n.id]
            const Icon = n.icon
            // every second name in a row, for when the row has to stagger its names (activity-fit.ts)
            const alt = NODES.filter((m) => m.row === n.row).indexOf(n) % 2 === 1
            return (
              <div key={n.id} className={`ag-node ${n.row} ${alt ? 'alt' : ''} ${on ? 'on' : ''} ${count > 0 ? 'used' : ''} ${arriving === n.id ? 'arrive' : ''}`} style={at(n.x, tileY(n))}>
                <span key={failed} className={`ag-key ${failed > 0 ? 'shake' : ''}`} title={`${n.label()}: ${count}`}>
                  <span className="ag-tile" style={sprite(on ? (waiting ? 'wait' : 'on') : count > 0 ? 'used' : 'idle', LIGHTS[n.id])}>
                    <i className="ag-orb-back" />
                    <i className="ag-orb-glow" />
                    <i className="ag-orb-front" />
                    <Icon className="ag-icon" size={15} strokeWidth={1.75} />
                  </span>
                  {/* one badge, on the side away from the name: how many times, and in red how many failed */}
                  {count > 0 && (
                    <span key={count} className="ag-count" style={{ animationDelay: `${Math.round(travelMs(n.id, speed))}ms` }}>
                      {count}
                      {failed > 0 && <b className="ag-fail">{failed}</b>}
                    </span>
                  )}
                </span>
                <span className="ag-label">{n.label()}</span>
              </div>
            )
          })}
        </div>
      </div>
      <button className="ag-grip" onPointerDown={drag} onDoubleClick={reset} aria-label={tr("Mărime")} title={tr("Trage ca să schimbi mărimea. Dublu clic: mărimea potrivită.")}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M9 1 1 9M9 5 5 9" />
        </svg>
      </button>
    </div>
  )
}
