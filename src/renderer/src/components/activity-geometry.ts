// Where everything sits on the activity board (ActivityGraph.tsx): the 360 x 192 grid, the tiles, the lanes of the bundle and the route of
// every cable from the light to its tile.
import { AppWindow, Bot, Brain, Cpu, FolderTree, Globe, MessageCircle, Puzzle, SquareTerminal, type LucideIcon } from 'lucide-react'
import { tr } from '@shared/i18n'

export type Node = 'you' | 'model' | 'files' | 'shell' | 'network' | 'browser' | 'agents' | 'skills' | 'memory'
export type Lane = 0 | 1 | 2 | 3

export interface Def {
  id: Node
  label: () => string
  icon: LucideIcon
  row: 'top' | 'bottom'
  x: number
  lane: Lane
}

// the grid: 360 x 192. Lanes from the top of the bundle: orange, gold, silver, lavender. A lane serves the tiles it passes and ends at the last.
export const W = 360
export const H = 192
export const TOP_Y = 32
export const BOTTOM_Y = 160
export const NODES: Def[] = [
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

export const LANES = [
  { color: '#e4693c', light: '#ffb48f' },
  { color: '#d8a640', light: '#ffe494' },
  { color: '#dcd8ec', light: '#ffffff' },
  { color: '#8f86e8', light: '#d4ceff' }
]
export const OFFSET = [-10.5, -3.5, 3.5, 10.5]
export const ROPE = 6.4

/** Which place a tool belongs to. */
// ---- geometry: the bundle is one centre line (a polyline with rounded corners); each cable is the same line shifted sideways ----
export type P = { x: number; y: number }
export const CORE: P = { x: 46, y: 100 }
export const CENTER: P[] = [
  { x: 54, y: 95 },
  { x: 124, y: 38 },
  { x: 142, y: 118 }
]
export const BASE_R = [20, 20]
export const RUN_Y = 120

export const unit = (a: P, b: P): P => {
  const l = Math.hypot(b.x - a.x, b.y - a.y) || 1
  return { x: (b.x - a.x) / l, y: (b.y - a.y) / l }
}
export const f = (n: number): string => n.toFixed(2)

/** A polyline with rounded corners as an SVG path; `radii[i]` is the radius at the vertex i + 1. */
export function rounded(pts: P[], radii: number[]): string {
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
export function lane(d: number, endX: number, tail?: { x: number; edge: number; r: number }): string {
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
export const laneEnd = (l: Lane): number => Math.max(...NODES.filter((n) => n.lane === l).map((n) => n.x))

export const STUB = 5
export const ROUTES = Object.fromEntries(
  NODES.map((n) => {
    const edge = n.row === 'top' ? TOP_Y + 14 : BOTTOM_Y - 14
    return [n.id, { stub: lane(OFFSET[n.lane], n.x, { x: n.x, edge, r: 7 }), end: { x: n.x, y: edge } }]
  })
) as Record<Node, { stub: string; end: P }>
