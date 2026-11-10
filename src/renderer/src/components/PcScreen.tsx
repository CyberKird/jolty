import { Command, Hand, Keyboard, Maximize2, Monitor, MousePointer2, MousePointerClick, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { tr } from '@shared/i18n'
import { screenBus, useScreenUi } from '../remote/screen-bus'
import './pcscreen.css'

// The PC's screen on the phone, TeamViewer style, with touches made for a finger: one finger moves the pointer like a touchpad
// (or points straight at the spot), a tap clicks, two fingers scroll or pinch, press and hold drags. The pictures come from
// main/remote-screen.ts; this page only draws them and sends what the fingers do, as fractions of the display.

interface Info {
  display: number
  width: number
  height: number
  displays: Array<{ index: number; w: number; h: number; primary: boolean; name: string }>
}

type Phase = 'connecting' | 'live' | 'off' | 'ended'
type Mode = 'touchpad' | 'direct'

const MODS = ['ctrl', 'alt', 'shift', 'win'] as const
const KEYS: Array<[string, string]> = [
  ['Esc', 'esc'], ['Tab', 'tab'], ['Del', 'delete'], ['Ins', 'insert'], ['Home', 'home'], ['End', 'end'], ['PgUp', 'pageup'], ['PgDn', 'pagedown'],
  ['←', 'left'], ['↑', 'up'], ['↓', 'down'], ['→', 'right']
]
const FKEYS = Array.from({ length: 12 }, (_, i): [string, string] => [`F${i + 1}`, `f${i + 1}`])
const COMBOS: Array<[string, string]> = [['Ctrl+C', 'ctrl+c'], ['Ctrl+V', 'ctrl+v'], ['Ctrl+X', 'ctrl+x'], ['Ctrl+Z', 'ctrl+z'], ['Ctrl+A', 'ctrl+a'], ['Ctrl+S', 'ctrl+s'], ['Alt+Tab', 'alt+tab'], ['Win+D', 'win+d'], ['Win+L', 'win+l'], ['Alt+F4', 'alt+f4']]

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

export function PcScreen() {
  const open = useScreenUi((s) => s.open)
  if (!open) return null
  return <Screen />
}

function Screen() {
  const setOpen = useScreenUi((s) => s.setOpen)
  const [phase, setPhase] = useState<Phase>('connecting')
  const phaseRef = useRef<Phase>('connecting')
  phaseRef.current = phase
  const [info, setInfo] = useState<Info>()
  const [mode, setMode] = useState<Mode>(() => (localStorage.getItem('jolty-screen-mode') === 'direct' ? 'direct' : 'touchpad'))
  const [keys, setKeys] = useState(false)
  const [mods, setMods] = useState<string[]>([])
  const [rightNext, setRightNext] = useState(false)
  const [zoomed, setZoomed] = useState(false)
  const [hint, setHint] = useState(() => !localStorage.getItem('jolty-screen-hint'))
  const [closing, setClosing] = useState(false)

  const stage = useRef<HTMLDivElement>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const img = useRef<HTMLImageElement>(null)
  const cursor = useRef<HTMLDivElement>(null)
  const typer = useRef<HTMLTextAreaElement>(null)
  const infoRef = useRef<Info | undefined>(undefined)
  const view = useRef({ z: 1, tx: 0, ty: 0, w: 0, h: 0, sw: 0, sh: 0 })
  const cur = useRef({ x: 0.5, y: 0.5, touched: 0 })
  const modeRef = useRef(mode)
  const modsRef = useRef<string[]>([])
  const rightRef = useRef(false)
  modeRef.current = mode
  modsRef.current = mods
  rightRef.current = rightNext

  // ------------------------------------------------------------------ drawing
  const paint = useCallback((): void => {
    const v = view.current
    if (wrap.current) {
      wrap.current.style.width = `${v.w}px`
      wrap.current.style.height = `${v.h}px`
      wrap.current.style.transform = `translate(${v.tx}px, ${v.ty}px) scale(${v.z})`
    }
    if (cursor.current) {
      cursor.current.style.transform = `translate(${cur.current.x * v.w}px, ${cur.current.y * v.h}px) scale(${1 / v.z})`
      cursor.current.style.opacity = cur.current.x < 0 ? '0' : '1'
    }
  }, [])

  const bounds = useCallback((): void => {
    const v = view.current
    const W = v.w * v.z
    const H = v.h * v.z
    v.tx = W <= v.sw ? (v.sw - W) / 2 : clamp(v.tx, v.sw - W, 0)
    v.ty = H <= v.sh ? (v.sh - H) / 2 : clamp(v.ty, v.sh - H, 0)
  }, [])

  const layout = useCallback((): void => {
    const el = stage.current
    const i = infoRef.current
    if (!el || !i) return
    const v = view.current
    v.sw = el.clientWidth
    v.sh = el.clientHeight
    const fit = Math.min(v.sw / i.width, v.sh / i.height)
    v.w = i.width * fit
    v.h = i.height * fit
    bounds()
    paint()
  }, [bounds, paint])

  const fit = (): void => {
    view.current.z = 1
    bounds()
    paint()
    setZoomed(false)
  }

  /** Brings the pointer back into view when the picture is zoomed in. */
  const follow = (): void => {
    const v = view.current
    if (v.z <= 1) return
    const sx = v.tx + cur.current.x * v.w * v.z
    const sy = v.ty + cur.current.y * v.h * v.z
    const m = 70
    if (sx < m) v.tx += m - sx
    else if (sx > v.sw - m) v.tx -= sx - (v.sw - m)
    if (sy < m) v.ty += m - sy
    else if (sy > v.sh - m) v.ty -= sy - (v.sh - m)
    bounds()
  }

  // ------------------------------------------------------------------ connection
  const start = useCallback((display?: number): void => {
    setPhase((p) => (p === 'live' ? p : 'connecting'))
    screenBus.send({ op: 'start', display: display ?? Number(localStorage.getItem('jolty-screen-display') || NaN) })
  }, [])

  useEffect(() => {
    let last = ''
    const offFrame = screenBus.onFrame((buf) => {
      // a picture that was already on its way when the PC ended the view must not bring the screen back
      if (phaseRef.current === 'ended' || phaseRef.current === 'off') return
      const head = new DataView(buf)
      const cx = head.getUint16(0, true)
      const cy = head.getUint16(2, true)
      if (Date.now() - cur.current.touched > 450) {
        cur.current.x = cx === 65535 ? -1 : cx / 65534
        cur.current.y = cy === 65535 ? -1 : cy / 65534
      }
      const url = URL.createObjectURL(new Blob([buf.slice(4)], { type: 'image/jpeg' }))
      const el = img.current
      if (!el) return URL.revokeObjectURL(url)
      el.onload = () => {
        if (last) URL.revokeObjectURL(last)
        last = url
        paint()
        if (phaseRef.current === 'ended' || phaseRef.current === 'off') return
        setPhase('live')
        screenBus.send({ op: 'ack' })
      }
      el.src = url
    })
    const offMsg = screenBus.onMessage((m) => {
      if (m.op === 'info') {
        const i = m as unknown as Info
        infoRef.current = i
        setInfo(i)
        localStorage.setItem('jolty-screen-display', String(i.display))
        requestAnimationFrame(layout)
      } else if (m.op === 'cursor' && Date.now() - cur.current.touched > 450) {
        cur.current.x = Number(m.x)
        cur.current.y = Number(m.y)
        paint()
      } else if (m.op === 'denied') setPhase('off')
      else if (m.op === 'ended') setPhase(m.reason === 'off' ? 'off' : 'ended')
    })
    start()
    const onVisible = (): void => (document.hidden ? screenBus.send({ op: 'stop' }) : start())
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      offFrame()
      offMsg()
      document.removeEventListener('visibilitychange', onVisible)
      screenBus.send({ op: 'stop' })
      if (last) URL.revokeObjectURL(last)
    }
  }, [layout, paint, start])

  useEffect(() => {
    const el = stage.current
    if (!el) return
    const ro = new ResizeObserver(layout)
    ro.observe(el)
    return () => ro.disconnect()
  }, [layout])

  // ------------------------------------------------------------------ input
  const sent = useRef(0)
  const sendMove = (): void => {
    const now = performance.now()
    if (now - sent.current < 28) return
    sent.current = now
    screenBus.send({ op: 'move', x: clamp(cur.current.x, 0, 1), y: clamp(cur.current.y, 0, 1) })
  }
  const sendMoveEnd = (): void => {
    sent.current = 0
    sendMove()
  }

  const ripple = (x: number, y: number): void => {
    const w = wrap.current
    if (!w) return
    const r = document.createElement('div')
    r.className = 'pcs-ripple'
    r.style.left = `${x * 100}%`
    r.style.top = `${y * 100}%`
    r.style.setProperty('--z', String(1 / view.current.z))
    r.addEventListener('animationend', () => r.remove())
    w.append(r)
  }

  const click = (count = 1, rightButton = false): void => {
    const right = rightButton || rightRef.current
    if (rightRef.current) setRightNext(false)
    screenBus.send({ op: 'click', x: clamp(cur.current.x, 0, 1), y: clamp(cur.current.y, 0, 1), button: right ? 'r' : 'l', count })
    ripple(clamp(cur.current.x, 0, 1), clamp(cur.current.y, 0, 1))
    navigator.vibrate?.(8)
  }

  const g = useRef({
    pts: new Map<number, { x: number; y: number }>(),
    t0: 0,
    sx: 0,
    sy: 0,
    moved: false,
    press: 0 as ReturnType<typeof setTimeout> | 0,
    drag: false,
    two: { d: 0, cx: 0, cy: 0, kind: '' as '' | 'zoom' | 'scroll', ax: 0, ay: 0, moved: false, t0: 0 }
  })

  const toFraction = (px: number, py: number): { x: number; y: number } => {
    const r = stage.current!.getBoundingClientRect()
    const v = view.current
    return { x: clamp((px - r.left - v.tx) / (v.w * v.z), 0, 1), y: clamp((py - r.top - v.ty) / (v.h * v.z), 0, 1) }
  }

  const onDown = (e: React.PointerEvent): void => {
    if (phase !== 'live') return
    const s = g.current
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    s.pts.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (hint) {
      setHint(false)
      localStorage.setItem('jolty-screen-hint', '1')
    }
    if (s.pts.size === 1) {
      s.t0 = Date.now()
      s.sx = e.clientX
      s.sy = e.clientY
      s.moved = false
      s.drag = false
      if (modeRef.current === 'direct') {
        const f = toFraction(e.clientX, e.clientY)
        cur.current.x = f.x
        cur.current.y = f.y
        cur.current.touched = Date.now()
        paint()
      }
      // press and hold: the left button goes down and the finger drags
      s.press = setTimeout(() => {
        if (s.moved || s.pts.size !== 1) return
        s.drag = true
        screenBus.send({ op: 'down', x: cur.current.x, y: cur.current.y, button: 'l' })
        navigator.vibrate?.(14)
        ripple(cur.current.x, cur.current.y)
      }, 420)
    } else if (s.pts.size === 2) {
      clearTimeout(s.press)
      const [a, b] = [...s.pts.values()]
      s.two = { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, kind: '', ax: 0, ay: 0, moved: false, t0: Date.now() }
    }
  }

  const onMove = (e: React.PointerEvent): void => {
    const s = g.current
    const p = s.pts.get(e.pointerId)
    if (!p) return
    const dx = e.clientX - p.x
    const dy = e.clientY - p.y
    p.x = e.clientX
    p.y = e.clientY
    const v = view.current
    if (s.pts.size === 1) {
      // a finger rests a little while it taps: only a real trip is a move
      if (!s.moved && Math.hypot(e.clientX - s.sx, e.clientY - s.sy) < 7) return
      s.moved = true
      clearTimeout(s.press)
      cur.current.touched = Date.now()
      if (modeRef.current === 'direct') {
        const f = toFraction(e.clientX, e.clientY)
        cur.current.x = f.x
        cur.current.y = f.y
      } else {
        // a little faster than the finger: the whole picture is more than a phone's width
        const gain = 1.35
        cur.current.x = clamp(cur.current.x + (dx * gain) / (v.w * v.z), 0, 1)
        cur.current.y = clamp(cur.current.y + (dy * gain) / (v.h * v.z), 0, 1)
      }
      follow()
      paint()
      sendMove()
    } else if (s.pts.size === 2) {
      const [a, b] = [...s.pts.values()]
      const d = Math.hypot(a.x - b.x, a.y - b.y)
      const cx = (a.x + b.x) / 2
      const cy = (a.y + b.y) / 2
      const t = s.two
      if (!t.kind) {
        if (Math.abs(d - t.d) > 14) t.kind = 'zoom'
        else if (Math.hypot(cx - t.cx, cy - t.cy) > 10) t.kind = 'scroll'
        else return
      }
      t.moved = true
      if (t.kind === 'zoom') {
        const z = clamp(v.z * (d / (t.d || d)), 1, 6)
        const r = stage.current!.getBoundingClientRect()
        const ox = cx - r.left
        const oy = cy - r.top
        // the point under the fingers stays under the fingers
        v.tx = ox - ((ox - v.tx) / v.z) * z + (cx - t.cx)
        v.ty = oy - ((oy - v.ty) / v.z) * z + (cy - t.cy)
        v.z = z
        t.d = d
        bounds()
        paint()
        setZoomed(v.z > 1.02)
      } else {
        t.ax += cx - t.cx
        t.ay += cy - t.cy
        const step = 34
        const nx = Math.trunc(t.ax / step)
        const ny = Math.trunc(t.ay / step)
        // fingers going up pull the content up, as on the phone itself
        if (ny) screenBus.send({ op: 'wheel', notches: -ny })
        if (nx) screenBus.send({ op: 'wheel', notches: -nx, horizontal: true })
        t.ax -= nx * step
        t.ay -= ny * step
      }
      t.cx = cx
      t.cy = cy
    }
  }

  const onUp = (e: React.PointerEvent): void => {
    const s = g.current
    if (!s.pts.has(e.pointerId)) return
    const before = s.pts.size
    s.pts.delete(e.pointerId)
    clearTimeout(s.press)
    if (before === 1) {
      if (s.drag) {
        screenBus.send({ op: 'up', x: cur.current.x, y: cur.current.y, button: 'l' })
        s.drag = false
      } else if (!s.moved && Date.now() - s.t0 < 380) {
        if (modeRef.current === 'direct') {
          const f = toFraction(e.clientX, e.clientY)
          cur.current.x = f.x
          cur.current.y = f.y
          paint()
        }
        click()
      } else sendMoveEnd()
    } else if (before === 2 && !s.two.moved && Date.now() - s.two.t0 < 320) {
      // two fingers tapped together: right click
      click(1, true)
    }
    // one finger staying on the glass after a pinch must not start a pointer move
    if (s.pts.size === 1) s.moved = true
  }

  // ------------------------------------------------------------------ keyboard and keys
  const press = (combo: string): void => {
    screenBus.send({ op: 'key', combo: [...modsRef.current, combo].join('+') })
    setMods([])
    navigator.vibrate?.(6)
  }

  const typed = (text: string): void => {
    if (!text) return
    if (modsRef.current.length) {
      for (const ch of text) screenBus.send({ op: 'key', combo: [...modsRef.current, ch].join('+') })
      setMods([])
    } else screenBus.send({ op: 'text', text })
  }

  const toggleMod = (m: string): void => setMods((cur2) => (cur2.includes(m) ? cur2.filter((x) => x !== m) : [...cur2, m]))

  const showKeyboard = (): void => {
    const t = typer.current
    if (!t) return
    t.focus()
  }

  const close = (): void => {
    setClosing(true)
    setTimeout(() => setOpen(false), 220)
  }

  const chooseMode = (m: Mode): void => {
    setMode(m)
    localStorage.setItem('jolty-screen-mode', m)
  }

  const display = info?.displays.find((d) => d.index === info.display)

  return (
    <div className={`pcs ${closing ? 'closing' : ''}`} role="dialog" aria-label={tr("Ecran PC")}>
      <header className="pcs-top">
        <button className="pcs-icon" onClick={close} aria-label={tr("Închide ecranul PC")}>
          <X size={20} />
        </button>
        <div className="pcs-title">
          <Monitor size={14} />
          <span>{tr("Ecran PC")}</span>
          <i className={`pcs-dot ${phase === 'live' ? 'ok' : phase}`} />
        </div>
        <div className="pcs-displays" role="tablist">
          {(info?.displays || []).map((d) => (
            <button
              key={d.index}
              role="tab"
              aria-selected={d.index === info?.display}
              className={`pcs-chip ${d.index === info?.display ? 'on' : ''}`}
              onClick={() => screenBus.send({ op: 'display', index: d.index })}
              title={`${d.w} x ${d.h}${d.primary ? ` · ${tr("principal")}` : ''}`}
            >
              {d.index + 1}
            </button>
          ))}
        </div>
      </header>

      <div className="pcs-stage" ref={stage} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <div className="pcs-wrap" ref={wrap}>
          <img ref={img} className="pcs-img" alt="" draggable={false} />
          <div className="pcs-cursor" ref={cursor}>
            <svg width="18" height="26" viewBox="0 0 12 19" aria-hidden>
              <polygon points="0,0 0,16 4,12.5 7,19 9.4,18 6.6,11.6 11.5,11.6" />
            </svg>
          </div>
        </div>

        {phase === 'connecting' && (
          <div className="pcs-state">
            <div className="pcs-pulse">
              <svg width={(34 * 205) / 740} height={34} viewBox="0 0 205 740" aria-hidden>
                <polygon points="52,0 170,0 118,300 205,284 56,740 84,408 0,426" />
              </svg>
            </div>
            <p>{tr("Se conectează la ecran…")}</p>
          </div>
        )}
        {(phase === 'off' || phase === 'ended') && (
          <div className="pcs-state">
            <Monitor size={34} strokeWidth={1.4} />
            <h2>{phase === 'off' ? tr("Ecranul PC-ului e oprit") : tr("Controlul a fost oprit la PC")}</h2>
            {phase === 'off' && <p>{tr("Pornește-l pe PC: Setări, Telefon, „Permite ecranul PC-ului pe telefon”.")}</p>}
            <button className="btn primary" onClick={() => start()}>
              {tr("Conectează din nou")}
            </button>
          </div>
        )}
        {hint && phase === 'live' && <div className="pcs-hint">{tr("Un deget mișcă cursorul, atingerea face clic, două degete derulează sau fac zoom, apăsarea lungă trage.")}</div>}
      </div>

      {keys && (
        <div className="pcs-keys" onPointerDown={(e) => e.stopPropagation()}>
          <div className="pcs-keys-row">
            {MODS.map((m) => (
              <button key={m} className={`pcs-key mod ${mods.includes(m) ? 'on' : ''}`} onClick={() => toggleMod(m)}>
                {m === 'win' ? 'Win' : m[0].toUpperCase() + m.slice(1)}
              </button>
            ))}
          </div>
          <div className="pcs-keys-grid">
            {KEYS.map(([label, key]) => (
              <button key={key} className="pcs-key" onClick={() => press(key)}>
                {label}
              </button>
            ))}
          </div>
          <div className="pcs-keys-scroll">
            {FKEYS.map(([label, key]) => (
              <button key={key} className="pcs-key" onClick={() => press(key)}>
                {label}
              </button>
            ))}
          </div>
          <div className="pcs-keys-scroll">
            {COMBOS.map(([label, combo]) => (
              <button key={combo} className="pcs-key wide" onClick={() => screenBus.send({ op: 'key', combo })}>
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      <footer className="pcs-bar">
        <button className={`pcs-btn ${keys ? 'on' : ''}`} onClick={() => setKeys(!keys)} aria-pressed={keys}>
          <Command size={19} />
          <span>{tr("Taste")}</span>
        </button>
        <button className="pcs-btn" onClick={showKeyboard}>
          <Keyboard size={19} />
          <span>{tr("Tastatură")}</span>
        </button>
        <button className={`pcs-btn ${rightNext ? 'on' : ''}`} onClick={() => setRightNext(!rightNext)} aria-pressed={rightNext}>
          <MousePointerClick size={19} />
          <span>{tr("Clic dreapta")}</span>
        </button>
        <button className="pcs-btn" onClick={() => chooseMode(mode === 'touchpad' ? 'direct' : 'touchpad')}>
          {mode === 'touchpad' ? <MousePointer2 size={19} /> : <Hand size={19} />}
          <span>{mode === 'touchpad' ? tr("Touchpad") : tr("Direct")}</span>
        </button>
        <button className={`pcs-btn ${zoomed ? 'on' : ''}`} onClick={fit} disabled={!zoomed}>
          <Maximize2 size={19} />
          <span>{tr("Potrivește")}</span>
        </button>
      </footer>

      <textarea
        ref={typer}
        className="pcs-typer"
        aria-label={tr("Tastatură")}
        autoCapitalize="none"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        value=""
        onChange={(e) => typed((e.nativeEvent as InputEvent).data ?? e.target.value)}
        onKeyDown={(e) => {
          const named: Record<string, string> = { Backspace: 'backspace', Enter: 'enter', Tab: 'tab', ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', Escape: 'esc' }
          const k = named[e.key]
          if (k) {
            e.preventDefault()
            press(k)
          }
        }}
      />
      <span className="pcs-sr" aria-live="polite">{display ? `${display.w} x ${display.h}` : ''}</span>
    </div>
  )
}
