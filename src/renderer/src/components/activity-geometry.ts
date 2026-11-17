// Where everything sits on the activity board (ActivityGraph.tsx): the 360 x 192 grid, the core, the tiles, and the route of every fibre
// from the core to its tile. The fibres leave the core's rim fanned out, close into one flat bus along the middle, and each lane turns off
// to its tiles with a rounded corner, like a ribbon cable on a circuit board. Lanes never cross: the top two serve the top row, the bottom
// two the bottom row, and a lane always ends before the next one turns off past it.
import { AppWindow, Bot, Brain, Cpu, FolderTree, Globe, MessageCircle, Puzzle, SquareTerminal, type LucideIcon } from 'lucide-react'
import { tr } from '@shared/i18n'

export type Node = 'you' | 'model' | 'files' | 'shell' | 'network' | 'browser' | 'agents' | 'skills' | 'memory'
export type Lane = 0 | 1 | 2 | 3
export type P = { x: number; y: number }

export interface Def {
  id: Node
  label: () => string
  icon: LucideIcon
  row: 'top' | 'bottom'
  x: number
  lane: Lane
}

export const W = 360
export const H = 192
export const TOP_Y = 32
export const BOTTOM_Y = 160
export const SPINE_Y = 96
/** half the side of a tile */
export const TILE = 14
export const NODES: Def[] = [
  { id: 'you', label: () => tr("Tu"), icon: MessageCircle, row: 'top', x: 205, lane: 0 },
  { id: 'model', label: () => tr("Model"), icon: Cpu, row: 'top', x: 250, lane: 0 },
  { id: 'skills', label: () => tr("Skilluri"), icon: Puzzle, row: 'top', x: 295, lane: 1 },
  { id: 'memory', label: () => tr("Memorie"), icon: Brain, row: 'top', x: 340, lane: 1 },
  { id: 'files', label: () => tr("Fișiere"), icon: FolderTree, row: 'bottom', x: 160, lane: 3 },
  { id: 'shell', label: () => tr("Shell"), icon: SquareTerminal, row: 'bottom', x: 205, lane: 3 },
  { id: 'network', label: () => tr("Rețea"), icon: Globe, row: 'bottom', x: 250, lane: 3 },
  { id: 'browser', label: () => tr("Browser"), icon: AppWindow, row: 'bottom', x: 295, lane: 2 },
  { id: 'agents', label: () => tr("Subagenți"), icon: Bot, row: 'bottom', x: 340, lane: 2 }
]

export const CORE: P = { x: 48, y: SPINE_Y }
/** the core's radius, and the rim the fibres leave from */
export const CORE_R = 25
/** lanes from the top of the bus down */
export const LANE_Y = [-4.8, -1.6, 1.6, 4.8].map((d) => SPINE_Y + d)
const LANE_ANGLE = [-27, -9, 9, 27].map((a) => (a * Math.PI) / 180)
const BUS_X = 116
const CORNER = 7

const f = (n: number): string => n.toFixed(2)

/** Where a lane stops: the last tile it serves. */
export const laneEnd = (l: Lane): number => Math.max(...NODES.filter((n) => n.lane === l).map((n) => n.x))
export const tileY = (n: Def): number => (n.row === 'top' ? TOP_Y : BOTTOM_Y)
/** where a fibre meets its tile: the tile's edge facing the bus */
export const edgeY = (n: Def): number => (n.row === 'top' ? TOP_Y + TILE : BOTTOM_Y - TILE)

/** The fan out of the core into the bus, for one lane: from the rim to where the bus starts. */
function fan(l: Lane): string {
  const a = LANE_ANGLE[l]
  const r = CORE_R - 1
  const sx = CORE.x + Math.cos(a) * r
  const sy = CORE.y + Math.sin(a) * r
  const y = LANE_Y[l]
  return `M ${f(sx)} ${f(sy)} C ${f(sx + Math.cos(a) * 26)} ${f(sy + Math.sin(a) * 26)} ${f(BUS_X - 34)} ${f(y)} ${f(BUS_X)} ${f(y)}`
}

/** The turn off a lane up or down to a tile, starting on the lane `CORNER` before the tile's x. */
function turn(n: Def): string {
  const y = LANE_Y[n.lane]
  const up = n.row === 'top'
  const sweep = up ? 0 : 1
  return `L ${f(n.x - CORNER)} ${f(y)} A ${CORNER} ${CORNER} 0 0 ${sweep} ${f(n.x)} ${f(up ? y - CORNER : y + CORNER)} L ${f(n.x)} ${f(edgeY(n))}`
}

/** The whole route from the core to a tile: what a packet of light follows. */
export const ROUTES = Object.fromEntries(NODES.map((n) => [n.id, `${fan(n.lane)} ${turn(n)}`])) as Record<Node, string>

/** The drawn wires: one full route per lane (to its last tile) and a short branch for every other tile, so nothing is drawn twice. */
export const WIRES: { id: string; d: string; nodes: Node[] }[] = [
  ...([0, 1, 2, 3] as Lane[]).map((l) => {
    const last = NODES.find((n) => n.lane === l && n.x === laneEnd(l))!
    return { id: `lane${l}`, d: ROUTES[last.id], nodes: NODES.filter((n) => n.lane === l).map((n) => n.id) }
  }),
  ...NODES.filter((n) => n.x !== laneEnd(n.lane)).map((n) => {
    const y = LANE_Y[n.lane]
    return { id: `branch-${n.id}`, d: `M ${f(n.x - CORNER - 0.5)} ${f(y)} ${turn(n)}`, nodes: [n.id] }
  })
]

/** The points of an SVG path every `step` units, measured by the browser (arcs come out exact), and the length. */
let probe: SVGPathElement | null = null
export function sample(d: string, step = 1): { pts: P[]; len: number } {
  if (!probe) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('width', '0')
    svg.setAttribute('height', '0')
    svg.style.position = 'absolute'
    svg.style.visibility = 'hidden'
    probe = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    svg.appendChild(probe)
    document.body.appendChild(svg)
  }
  probe.setAttribute('d', d)
  const len = probe.getTotalLength()
  const n = Math.max(2, Math.ceil(len / step) + 1)
  const pts = Array.from({ length: n }, (_, i) => {
    const q = probe!.getPointAtLength((len * i) / (n - 1))
    return { x: q.x, y: q.y }
  })
  return { pts, len }
}
