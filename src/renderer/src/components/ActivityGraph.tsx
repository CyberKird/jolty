import { AppWindow, Bot, Brain, Cpu, FolderTree, Globe, MessageCircle, Puzzle, SquareTerminal, type LucideIcon } from 'lucide-react'
import { useMemo } from 'react'
import type { ChatItem } from '@shared/types'
import { tr } from '@shared/i18n'
import { toolKind } from './Messages'
import type { Phase } from './LivePanel'

// What the model is doing, as a map: the model in the middle, the places it reaches around it. A place lights up and a small packet runs
// along its line while a tool there is running; the count under it is how many times the conversation went there, a red dot says how many
// of those failed. Only transforms and opacity move, so it costs next to nothing; with low-power mode or reduced motion it holds still
// and shows the same state.

type Node = 'you' | 'model' | 'files' | 'shell' | 'network' | 'browser' | 'agents' | 'skills' | 'memory'

const NODES: { id: Node; label: () => string; icon: LucideIcon }[] = [
  { id: 'you', label: () => tr("Tu"), icon: MessageCircle },
  { id: 'model', label: () => tr("Model"), icon: Cpu },
  { id: 'files', label: () => tr("Fișiere"), icon: FolderTree },
  { id: 'shell', label: () => tr("Shell"), icon: SquareTerminal },
  { id: 'network', label: () => tr("Rețea"), icon: Globe },
  { id: 'browser', label: () => tr("Browser"), icon: AppWindow },
  { id: 'agents', label: () => tr("Subagenți"), icon: Bot },
  { id: 'skills', label: () => tr("Skilluri"), icon: Puzzle },
  { id: 'memory', label: () => tr("Memorie"), icon: Brain }
]

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

const W = 300
const H = 250
const CX = W / 2
const CY = H / 2 - 4
const RX = 112
const RY = 88

const at = (i: number): { x: number; y: number } => {
  const a = -Math.PI / 2 + (i / NODES.length) * Math.PI * 2
  return { x: CX + Math.cos(a) * RX, y: CY + Math.sin(a) * RY }
}

export function ActivityGraph({ items, phase, engine, model, context }: { items: ChatItem[]; phase: Phase; engine: string; model?: string; context?: number }) {
  const stats = useMemo(() => statsOf(items, { key: phase.key }), [items, phase.key])
  const waiting = phase.key === 'approval'
  const pct = context === undefined ? undefined : Math.round(context)
  return (
    <svg className={`actgraph ${phase.on ? 'live-on' : ''}`} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={phase.name}>
      <circle className="ag-orbit" cx={CX} cy={CY} r={RX - 10} />
      {NODES.map((n, i) => {
        const p = at(i)
        const on = stats.active.has(n.id)
        return (
          <g key={n.id} className={`ag-link ${on ? 'on' : ''} ${stats.count[n.id] ? 'used' : ''}`}>
            <line x1={CX} y1={CY} x2={p.x} y2={p.y} />
            {on && <circle className="ag-packet" r="2.6" cx={CX} cy={CY} style={{ ['--dx' as string]: `${p.x - CX}px`, ['--dy' as string]: `${p.y - CY}px` }} />}
          </g>
        )
      })}
      {NODES.map((n, i) => {
        const p = at(i)
        const on = stats.active.has(n.id)
        const Icon = n.icon
        return (
          <g key={n.id} className={`ag-node ${on ? 'on' : ''} ${stats.count[n.id] ? 'used' : ''}`} transform={`translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`}>
            {on && <circle className="ag-halo" r="17" />}
            <circle className="ag-disc" r="14.5" />
            <Icon x={-7} y={-7} width={14} height={14} strokeWidth={1.7} />
            <text className="ag-label" y="27" textAnchor="middle">
              {n.label()}
            </text>
            {stats.count[n.id] > 0 && (
              <text className="ag-count" y="37" textAnchor="middle">
                {stats.count[n.id]}
              </text>
            )}
            {stats.failed[n.id] > 0 && (
              <g className="ag-fail" transform="translate(11 -11)">
                <circle r="6.5" />
                <text y="2.6" textAnchor="middle">
                  {stats.failed[n.id]}
                </text>
              </g>
            )}
          </g>
        )
      })}
      <g className={`ag-core ${waiting ? 'wait' : ''} ${phase.on ? 'on' : ''}`} transform={`translate(${CX} ${CY})`}>
        <circle className="ag-core-bg" r="31" />
        {pct !== undefined && <circle className="ag-core-ring" r="35" pathLength="100" strokeDasharray={`${pct} 100`} transform="rotate(-90)" />}
        <circle className="ag-core-pulse" r="31" />
        {pct !== undefined && (
          <text className="ag-core-pct" y="-12" textAnchor="middle">
            {pct}%
          </text>
        )}
        <text className="ag-core-name" y="3" textAnchor="middle">
          {engine.toUpperCase()}
        </text>
        {model && (
          <text className="ag-core-model" y="16" textAnchor="middle">
            {model.length > 14 ? `${model.slice(0, 13)}…` : model}
          </text>
        )}
      </g>
    </svg>
  )
}
