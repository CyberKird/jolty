// Dev gallery for the activity board: the real ActivityGraph and Liquid with fixed data, in the theme and width given in the URL
// (?theme=volt|glass|frost&w=372&lp=1&rm=1). Used by test/activity-shots.mjs for screenshots and frame timing; not part of the app.
import { createRoot } from 'react-dom/client'
import '../../src/renderer/src/styles.css'
import '../../src/renderer/src/transitions.css'
import '../../src/renderer/src/themes.css'
import '../../src/renderer/src/theme-glass.css'
import '../../src/renderer/src/lowpower.css'
import '../../src/renderer/src/components/activity-graph.css'
import type { ChatItem } from '@shared/types'

const q = new URLSearchParams(location.search)
document.documentElement.dataset.theme = q.get('theme') || 'volt'
if (q.get('lp')) document.documentElement.classList.add('low-power')
if (q.get('rm')) document.documentElement.classList.add('reduce-motion')
const w = Number(q.get('w') || 372)

const { ActivityGraph } = await import('../../src/renderer/src/components/ActivityGraph')
const { Liquid } = await import('../../src/renderer/src/components/Liquid')

let n = 0
const tool = (name: string, status: 'done' | 'error' | 'running' = 'done'): ChatItem => ({ kind: 'tool', id: `t${n++}`, name, title: name, status, input: {} }) as unknown as ChatItem
const base: ChatItem[] = [
  { kind: 'user', id: 'u1', text: 'hi' } as ChatItem,
  { kind: 'assistant', id: 'a1', text: 'ok' } as ChatItem,
  tool('Read'),
  tool('Read'),
  tool('Edit'),
  tool('Bash'),
  tool('Bash', 'error'),
  tool('WebFetch'),
  tool('Skill')
]
const busy: ChatItem[] = [...base, tool('Grep'), tool('mcp__jolty-browser__browser_navigate'), tool('Task'), tool('Bash', 'running')]
const phases = {
  idle: { key: 'idle', on: false, name: 'Gata' },
  run: { key: 'run', on: true, name: 'Rulează o comandă' },
  approval: { key: 'approval', on: true, name: 'Așteaptă aprobarea ta' }
}
const mode = q.get('state')
const scenes: { label: string; items: ChatItem[]; phase: (typeof phases)['idle'] }[] = mode
  ? [{ label: mode, items: mode === 'idle' ? base : busy, phase: phases[mode as keyof typeof phases] }]
  : [
      { label: 'idle', items: base, phase: phases.idle },
      { label: 'busy', items: busy, phase: phases.run },
      { label: 'empty', items: [], phase: phases.idle }
    ]

function Gallery() {
  return (
    <div style={{ display: 'flex', gap: 0, minHeight: '100vh' }}>
      <aside className="live" style={{ width: w, maxWidth: 'none' }}>
        {scenes.map((s) => (
          <div key={s.label} className="live-section live-status" data-scene={s.label}>
            <ActivityGraph items={s.items} phase={s.phase as never} engine="claude" model="opus" context={s.label === 'empty' ? undefined : 41} iq={58} effort="high" />
            <div className="state-name">{s.phase.name}</div>
          </div>
        ))}
        <div className="live-section" data-scene="liquid" style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
          {[0, 12, 41, 78, 92].map((p) => (
            <Liquid key={p} pct={p} size={21} high={p >= 80} />
          ))}
          {[41, 92].map((p) => (
            <Liquid key={`b${p}`} pct={p} size={64} high={p >= 80} />
          ))}
        </div>
      </aside>
    </div>
  )
}
createRoot(document.getElementById('root')!).render(<Gallery />)
