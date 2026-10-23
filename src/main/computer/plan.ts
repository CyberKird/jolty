// Timed input events for the native helper, built from the human models in human.ts. An event is
// [kind, ms from the start, ...]: the helper plays the whole list on a high resolution clock, so the
// rhythm is not at the mercy of the pipe between Jolty and the helper.
import { between, clamp, clickOffset, clickTimes, fittsMs, mousePath, scrollGaps, typeSteps, type Humanness, type PathPoint, type Pt, type Rng } from './human'

export type Button = 'left' | 'right' | 'middle'
export type Ev =
  | ['m', number, number, number]
  | ['b', number, 'l' | 'r' | 'm', 0 | 1]
  | ['w', number, number, 0 | 1]
  | ['k', number, number, 0 | 1, 0 | 1]
  | ['c', number, number, number]

const BTN = { left: 'l', right: 'r', middle: 'm' } as const

const shift = (evs: Ev[], dt: number): Ev[] => evs.map((e) => [e[0], e[1] + dt, ...e.slice(2)] as Ev)
export const planEnd = (evs: Ev[]): number => evs.reduce((m, e) => Math.max(m, e[1] + (e[0] === 'c' ? e[3] : 0)), 0)
const asMoves = (pts: PathPoint[]): Ev[] => pts.map((p) => ['m', p.t, p.x, p.y])

/** The pointer travels from `from` to `to`. */
export function movePlan(from: Pt, to: Pt, mode: Humanness, rng: Rng, width?: number): Ev[] {
  return asMoves(mousePath(from, to, { mode, rng, width }))
}

/** Where a click aimed at `at` really lands. */
export function clickPoint(at: Pt, mode: Humanness, rng: Rng, w?: number, h?: number): Pt {
  const o = clickOffset(rng, mode, w, h)
  return { x: at.x + o.x, y: at.y + o.y }
}

/** The presses of a click or double click with the pointer already on the spot (the first press follows a short dwell). */
export function clickPlan(button: Button, count: number, mode: Humanness, rng: Rng): Ev[] {
  const out: Ev[] = []
  let t = 0
  for (let i = 0; i < count; i++) {
    const c = clickTimes(mode, rng)
    t += i === 0 ? c.dwell : c.gap
    out.push(['b', t, BTN[button], 1])
    t += c.hold
    out.push(['b', t, BTN[button], 0])
  }
  return out
}

/** Press, carry across, let go: a drag the way a hand does it (a beat after grabbing, a beat before letting go). */
export function dragPlan(from: Pt, to: Pt, button: Button, mode: Humanness, rng: Rng): Ev[] {
  const grab = mode === 'fast' ? 20 : between(rng, 90, 190)
  const out: Ev[] = [['b', 0, BTN[button], 1]]
  const path = mousePath(from, to, { mode, rng, width: 30 })
  // a drag starts slowly: stretch the first moments
  const moves = asMoves(path).map((e) => ['m', e[1] * (mode === 'fast' ? 1 : 1.25) + grab, e[2], e[3]] as Ev)
  out.push(...moves)
  const end = planEnd(moves)
  out.push(['b', end + (mode === 'fast' ? 20 : between(rng, 50, 130)), BTN[button], 0])
  return out
}

/** A little wandering around a spot, as a hand rests on a mouse. */
export function driftPlan(at: Pt, ms: number, rng: Rng): Ev[] {
  const out: Ev[] = []
  let t = between(rng, 60, 160)
  let cur = at
  while (t < ms - 80) {
    const next = { x: Math.round(at.x + between(rng, -3, 3)), y: Math.round(at.y + between(rng, -3, 3)) }
    const steps = Math.max(2, Math.round(between(rng, 3, 6)))
    for (let s = 1; s <= steps; s++) out.push(['m', t + s * between(rng, 7, 12), Math.round(cur.x + ((next.x - cur.x) * s) / steps), Math.round(cur.y + ((next.y - cur.y) * s) / steps)])
    cur = next
    t += between(rng, 160, 420)
  }
  if (out.length) out.push(['m', Math.max(ms - 10, planEnd(out) + 8), at.x, at.y])
  return out
}

/** Wheel notches (positive = down / right) with the gaps of a flick. */
export function scrollPlan(notches: number, horizontal: boolean, mode: Humanness, rng: Rng): Ev[] {
  const n = Math.abs(Math.round(notches))
  const sign = notches < 0 ? 1 : -1
  let t = 0
  return scrollGaps(n, mode, rng).map((g) => {
    t += g
    return ['w', t, sign * 120, horizontal ? 1 : 0] as Ev
  })
}

// ------------------------------------------------------------------ keys
const NAMED: Record<string, number> = {
  backspace: 0x08, tab: 0x09, enter: 0x0d, return: 0x0d, shift: 0x10, ctrl: 0x11, control: 0x11, alt: 0x12, pause: 0x13, capslock: 0x14,
  esc: 0x1b, escape: 0x1b, space: 0x20, pageup: 0x21, pgup: 0x21, pagedown: 0x22, pgdn: 0x22, end: 0x23, home: 0x24,
  left: 0x25, up: 0x26, right: 0x27, down: 0x28, printscreen: 0x2c, prtsc: 0x2c, insert: 0x2d, ins: 0x2d, delete: 0x2e, del: 0x2e,
  win: 0x5b, windows: 0x5b, meta: 0x5b, super: 0x5b, cmd: 0x5b, menu: 0x5d, apps: 0x5d,
  numlock: 0x90, scrolllock: 0x91,
  semicolon: 0xba, equal: 0xbb, plus: 0xbb, comma: 0xbc, minus: 0xbd, period: 0xbe, dot: 0xbe, slash: 0xbf, backquote: 0xc0, grave: 0xc0,
  bracketleft: 0xdb, backslash: 0xdc, bracketright: 0xdd, quote: 0xde
}
const EXTENDED = new Set([0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2c, 0x2d, 0x2e, 0x5b, 0x5d, 0x90])
export const MODIFIER_VKS = new Set([0x10, 0x11, 0x12, 0x5b])

/** A key name ("ctrl", "F5", "a", "enter") as a virtual-key code, or undefined. */
export function vkOf(name: string): number | undefined {
  const k = name.trim().toLowerCase()
  if (NAMED[k] !== undefined) return NAMED[k]
  if (/^[a-z]$/.test(k)) return k.toUpperCase().charCodeAt(0)
  if (/^[0-9]$/.test(k)) return k.charCodeAt(0)
  const f = /^f(\d{1,2})$/.exec(k)
  if (f && Number(f[1]) >= 1 && Number(f[1]) <= 24) return 0x6f + Number(f[1])
  const pad = /^(?:num|numpad)([0-9])$/.exec(k)
  if (pad) return 0x60 + Number(pad[1])
  return undefined
}

/** "ctrl+shift+t" as key codes, modifiers first. Throws with a clear message for a key it does not know. */
export function parseCombo(combo: string): number[] {
  const parts = combo.split('+').map((p) => p.trim()).filter(Boolean)
  // a lone "+" is the plus key
  if (!parts.length && combo.trim() === '+') return [0xbb]
  if (!parts.length) throw new Error('"keys" is empty')
  const vks = parts.map((p) => {
    const v = vkOf(p)
    if (v === undefined) throw new Error(`Unknown key "${p}". Use names like ctrl, shift, alt, win, enter, tab, esc, up, f5, a, 7.`)
    return v
  })
  const mods = vks.filter((v) => MODIFIER_VKS.has(v))
  const rest = vks.filter((v) => !MODIFIER_VKS.has(v))
  return [...mods, ...rest]
}

/** Modifiers down in order, the key tapped, modifiers released in reverse: one chord, repeated `repeat` times. */
export function chordPlan(vks: number[], repeat: number, mode: Humanness, rng: Rng): Ev[] {
  const mods = vks.filter((v) => MODIFIER_VKS.has(v))
  const keys = vks.filter((v) => !MODIFIER_VKS.has(v))
  const fast = mode === 'fast'
  const out: Ev[] = []
  let t = 0
  for (const m of mods) {
    out.push(['k', t, m, 1, EXTENDED.has(m) ? 1 : 0])
    t += fast ? 8 : between(rng, 30, 90)
  }
  const sets = keys.length ? keys : []
  for (let i = 0; i < Math.max(1, repeat); i++) {
    for (const k of sets) {
      out.push(['k', t, k, 1, EXTENDED.has(k) ? 1 : 0])
      t += fast ? 10 : clamp(between(rng, 40, 110), 40, 110)
      out.push(['k', t, k, 0, EXTENDED.has(k) ? 1 : 0])
      t += fast ? 10 : between(rng, 25, 70)
    }
    if (i < repeat - 1) t += fast ? 30 : between(rng, 60, 150)
  }
  for (const m of [...mods].reverse()) {
    out.push(['k', t, m, 0, EXTENDED.has(m) ? 1 : 0])
    t += fast ? 8 : between(rng, 20, 70)
  }
  return out
}

/** Text as keystrokes: characters through the helper's layout lookup (or as unicode), Enter and Tab as keys. */
export function typePlan(text: string, mode: Humanness, rng: Rng, typos: boolean, speedUp = 1): Ev[] {
  const out: Ev[] = []
  let t = 0
  for (const s of typeSteps(text, { mode, rng, typos })) {
    t += s.delay / speedUp
    const hold = Math.max(4, s.hold / speedUp)
    if (s.ch === '\b') out.push(['k', t, 0x08, 1, 0], ['k', t + hold, 0x08, 0, 0])
    else if (s.ch === '\n') out.push(['k', t, 0x0d, 1, 0], ['k', t + hold, 0x0d, 0, 0])
    else if (s.ch === '\t') out.push(['k', t, 0x09, 1, 0], ['k', t + hold, 0x09, 0, 0])
    else out.push(['c', t, s.ch.codePointAt(0) as number, hold])
    t += hold
  }
  return out
}

/** How long a typing plan takes. */
export const typeDuration = planEnd

/** Applies a typing plan to a buffer: what the field holds afterwards (Backspace removes, Enter and Tab add their characters). */
export function simulateTyping(evs: Ev[]): string {
  const buf: string[] = []
  for (const e of evs) {
    if (e[0] === 'c') buf.push(String.fromCodePoint(e[2]))
    else if (e[0] === 'k' && e[3] === 1) {
      if (e[2] === 0x08) buf.pop()
      else if (e[2] === 0x0d) buf.push('\n')
      else if (e[2] === 0x09) buf.push('\t')
    }
  }
  return buf.join('')
}

/** The same plan starting `dt` ms later. */
export const later = shift

/** Whole movement time for a pointer trip, for budgeting. */
export const tripMs = (distance: number, mode: Humanness, rng: Rng, width = 24): number => fittsMs(distance, width, mode, rng)
