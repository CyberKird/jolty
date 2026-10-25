import { dim } from './size'
import { FLOORS, visible } from './places'

/**
 * Where Jolty may stand without being in the way. Everything you can click, type in or read is an obstacle
 * (read from the DOM, never changed); his body at a spot must not overlap any of them. The search starts from
 * the spot the brain wants and moves outward: the window's floor, the tops of surfaces, then smaller, then half
 * out of the window's edge.
 */
export interface Box {
  l: number
  t: number
  r: number
  b: number
}

export interface Spot {
  el: Element | null
  x: number
  y: number
  /** 1: his size; less when the only room left is small (he shrinks) */
  scale: number
}

const INTERACTIVE =
  'button, a[href], input, textarea, select, summary, [role=button], [role=menuitem], [role=tab], [role=option], [role=checkbox], [role=switch], [role=slider], [contenteditable=true], [tabindex]:not([tabindex="-1"])'
/** what must stay readable or usable as a whole: open menus and dialogs, the composer, approval cards, toasts */
const PANELS = '[role=menu], [role=dialog], .modal, .lightbox, .picker-pop, .ctx, .toast, .composer, .permission, .titlebar'
const SCROLLERS = '.session-list, .live-list, .page, .messages, .picker-list, .meter-list, .live-pane, .tasks-list, .queue, .modal, .wn-body'
/** surfaces besides the floors he may stand on when nothing is in the way there */
const SURFACES = `${FLOORS}, .card, .start, h1, h2`
const MARGIN = 5
const SCROLLBAR = 14

let cache: { at: number; boxes: Box[]; modal: boolean } = { at: -1e9, boxes: [], modal: false }

const box = (r: DOMRect): Box => ({ l: r.left, t: r.top, r: r.right, b: r.bottom })

function read(): void {
  const boxes: Box[] = []
  const addRect = (r: DOMRect): void => {
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return
    boxes.push(box(r))
  }
  const add = (el: Element): void => {
    if (!el.closest('.mascot')) addRect(el.getBoundingClientRect())
  }
  document.querySelectorAll(INTERACTIVE).forEach(add)
  document.querySelectorAll(PANELS).forEach(add)
  // the scrollbars
  document.querySelectorAll(SCROLLERS).forEach((el) => {
    const r = el.getBoundingClientRect()
    if (el.scrollHeight > el.clientHeight + 2 && r.width > 0) boxes.push({ l: r.right - SCROLLBAR, t: r.top, r: r.right, b: r.bottom })
  })
  // the last of each kind of message, as far as it is on screen
  for (const kind of ['.msg-assistant', '.msg-user']) {
    const last = [...document.querySelectorAll(`.messages ${kind}`)].at(-1)
    if (last) add(last)
  }
  const sel = getSelection()
  if (sel && !sel.isCollapsed && sel.rangeCount) addRect(sel.getRangeAt(0).getBoundingClientRect())
  cache = { at: performance.now(), boxes, modal: Boolean(document.querySelector('.modal-back, .lightbox, .wn, [role=menu], [role=dialog]')) }
}

function obstacles(): Box[] {
  if (performance.now() - cache.at > 160) read()
  return cache.boxes
}

/** a menu, a dialog or a lightbox is open: he gets out of its way and keeps quiet */
export function modalOpen(): boolean {
  obstacles()
  return cache.modal
}

/** where his body is, for a feet point and a scale: a little wider than the silhouette, which is what a hand reaches */
export function bodyAt(x: number, y: number, scale = 1): Box {
  const k = dim.k * scale
  return { l: x - 26 * k - MARGIN, r: x + 26 * k + MARGIN, t: y - 80 * k - MARGIN, b: y - 1 }
}

const hits = (a: Box, b: Box): boolean => a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t

export function blocked(x: number, y: number, scale = 1): boolean {
  const me = bodyAt(x, y, scale)
  return obstacles().some((o) => hits(me, o))
}

/** his feet moving along a floor from x0 to x1: no obstacle on the way */
export function pathBlocked(x0: number, x1: number, y: number, scale = 1): boolean {
  const a = bodyAt(Math.min(x0, x1), y, scale)
  const b = bodyAt(Math.max(x0, x1), y, scale)
  const sweep = { l: a.l, r: b.r, t: a.t, b: a.b }
  return obstacles().some((o) => hits(sweep, o))
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** the closest spot to the wanted one where he is clear; null when the window has none (the caller peeks from an edge) */
function search(want: Spot, scale: number): Spot | null {
  const half = 28 * dim.k * scale
  const floorY = innerHeight - 7
  const tries: Spot[] = [want]
  for (let x = half; x <= innerWidth - half; x += 16) tries.push({ el: null, x, y: floorY, scale })
  for (const el of document.querySelectorAll(SURFACES)) {
    const r = visible(el)
    if (!r || el.closest('.mascot')) continue
    for (const f of [0.2, 0.5, 0.8]) tries.push({ el, x: clamp(r.left + r.width * f, r.left + half * 0.7, r.right - half * 0.7), y: r.top, scale })
  }
  const cost = (s: Spot): number => Math.abs(s.x - want.x) + Math.abs(s.y - want.y) * 0.8 + (s.el ? 0 : 30)
  const sorted = tries.map((s) => ({ ...s, scale })).sort((a, b) => cost(a) - cost(b))
  return sorted.find((s) => !blocked(s.x, s.y, s.scale)) ?? null
}

/** the wanted spot if he is clear there, else the nearest clear one, smaller if need be, else half out of an edge */
export function freeSpot(want: Spot): Spot {
  if (!blocked(want.x, want.y, want.scale)) return want
  const found = search(want, 1) ?? search(want, 0.62)
  if (found) return found
  const side = want.x < innerWidth / 2 ? -1 : 1
  return { el: null, x: side < 0 ? 4 : innerWidth - 4, y: innerHeight - 7, scale: 0.62 }
}

/** invalidates what was read: the page changed under him */
export function forget(): void {
  cache.at = -1e9
}
