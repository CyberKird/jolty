// The agent's own task list above the composer, like the Claude app: one quiet line with the
// progress and the current step, opening into the full checklist.
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useState } from 'react'
import type { PlanStep } from '@shared/types'
import { useStore } from '../store'

const NONE: PlanStep[] = []

export function TaskStrip({ sessionId }: { sessionId: string }) {
  const steps = useStore((s) => s.plans[sessionId]) || NONE
  const running = useStore((s) => s.status[sessionId] === 'running')
  const [open, setOpen] = useState(false)
  if (!steps.length) return null
  const done = steps.filter((s) => s.status === 'done').length
  const all = done === steps.length
  const current = steps.find((s) => s.status === 'active') || steps.find((s) => s.status === 'pending')
  return (
    <div className={`tasks ${open ? 'open' : ''}`}>
      {open && (
        <ol className="tasks-list" aria-label="Sarcinile modelului">
          {steps.map((s, i) => (
            <li key={i} className={`plan-step ${s.status}`}>
              <span className="box" aria-hidden />
              <span>{s.text}</span>
              <span className="sr-only">{s.status === 'done' ? ' (gata)' : s.status === 'active' ? ' (în lucru)' : ''}</span>
            </li>
          ))}
        </ol>
      )}
      <button className="tasks-bar" aria-expanded={open} onClick={() => setOpen(!open)} title={open ? 'Ascunde sarcinile' : 'Arată toate sarcinile'}>
        <span className="tasks-count">
          Sarcini {done}/{steps.length}
        </span>
        <span className="tasks-track" aria-hidden>
          <span style={{ transform: `scaleX(${done / steps.length})` }} />
        </span>
        <span className={`tasks-now ${running && !all ? 'live' : ''}`}>{all ? 'Toate gata' : current?.text}</span>
        {open ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
      </button>
    </div>
  )
}
