import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChatItem, PermissionRequest, PlanStep, SessionMeta } from '@shared/types'
import { basename, useStore, type Draft } from '../store'
import { toolKind } from './Messages'
import { highlight, langOf } from './Rich'

type Tool = Extract<ChatItem, { kind: 'tool' }>

const EMPTY: ChatItem[] = []

// ---------------------------------------------------------------------------
// State: what the agent is doing, drawn as a live electrical signal
// ---------------------------------------------------------------------------
type Wave = 'flat' | 'sine' | 'square' | 'spike' | 'saw' | 'pulse'

interface Phase {
  key: string
  name: string
  detail?: string
  code?: boolean
  wave: Wave
  amp: number
  period: number
  speed: number
  color: string
  on: boolean
}

const PHASES: Record<string, Omit<Phase, 'key' | 'detail' | 'code'>> = {
  idle: { name: 'În așteptare', wave: 'flat', amp: 0, period: 60, speed: 6, color: 'rgba(255,255,255,.22)', on: false },
  think: { name: 'Se gândește', wave: 'sine', amp: 9, period: 110, speed: 3.2, color: 'var(--volt)', on: true },
  answer: { name: 'Scrie răspunsul', wave: 'sine', amp: 14, period: 62, speed: 1.6, color: 'var(--volt)', on: true },
  run: { name: 'Rulează', wave: 'spike', amp: 24, period: 96, speed: 1.1, color: 'var(--volt)', on: true },
  read: { name: 'Citește', wave: 'pulse', amp: 12, period: 44, speed: 1.4, color: 'var(--volt)', on: true },
  edit: { name: 'Editează', wave: 'square', amp: 13, period: 52, speed: 1.3, color: 'var(--volt)', on: true },
  write: { name: 'Creează', wave: 'square', amp: 16, period: 40, speed: 1.1, color: 'var(--volt)', on: true },
  search: { name: 'Caută', wave: 'saw', amp: 13, period: 48, speed: 1.2, color: 'var(--volt)', on: true },
  web: { name: 'Pe internet', wave: 'saw', amp: 10, period: 70, speed: 2, color: 'var(--volt)', on: true },
  agent: { name: 'Subagenți', wave: 'pulse', amp: 18, period: 36, speed: 0.9, color: 'var(--volt)', on: true },
  plan: { name: 'Planifică', wave: 'sine', amp: 7, period: 140, speed: 3.6, color: 'var(--volt)', on: true },
  approval: { name: 'Așteaptă acordul', wave: 'pulse', amp: 16, period: 150, speed: 2.4, color: 'var(--warning)', on: true },
  error: { name: 'S-a oprit', wave: 'flat', amp: 0, period: 60, speed: 6, color: 'var(--critical)', on: false }
}

function phaseOf(items: ChatItem[], status: string | undefined, perms: PermissionRequest[], drafts: Draft[]): Phase {
  const make = (key: string, detail?: string, code = false): Phase => ({ key, detail, code, ...PHASES[key] })
  if (perms.length) return make('approval', perms[0].title, true)
  if (status === 'error') return make('error', 'Vezi mesajul din conversație.')
  if (status !== 'running') return make('idle', 'Trimite un mesaj și urmărești aici fiecare pas.')
  const writing = drafts[drafts.length - 1]
  if (writing && !writing.done && Date.now() - writing.at < 5000) return make(writing.name === 'Write' ? 'write' : 'edit', writing.path, true)
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (it.kind === 'tool' && it.status === 'running') {
      const k = toolKind(it.name)
      return make(k === 'other' ? 'think' : k, it.title.replace(/^\$ /, ''), true)
    }
    if (it.kind === 'assistant' && it.text) return make('answer')
    if (it.kind === 'reasoning') return make('think', it.text.split('\n').filter(Boolean).pop()?.slice(0, 140))
    if (it.kind === 'user') break
  }
  return make('think')
}

/** One period of the signal repeated across the strip; the strip scrolls by exactly one period. */
function wavePath(wave: Wave, amp: number, period: number, width: number, mid: number): string {
  const pts: string[] = []
  const total = width + period * 2
  for (let x = 0; x <= total; x += 1) {
    const t = (x % period) / period
    let y = 0
    if (wave === 'sine') y = Math.sin(t * Math.PI * 2) * amp
    else if (wave === 'square') y = t < 0.5 ? -amp : amp
    else if (wave === 'saw') y = (t * 2 - 1) * amp
    else if (wave === 'pulse') y = t < 0.16 ? -Math.sin((t / 0.16) * Math.PI) * amp : 0
    else if (wave === 'spike') y = t > 0.4 && t < 0.44 ? -amp : t >= 0.44 && t < 0.5 ? amp * 0.55 : t >= 0.5 && t < 0.54 ? -amp * 0.2 : 0
    pts.push(`${x},${(mid + y).toFixed(1)}`)
  }
  return 'M' + pts.join(' L')
}

function Signal({ phase }: { phase: Phase }) {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(330)
  useEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)))
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])
  const H = 64
  const d = useMemo(() => wavePath(phase.wave, phase.amp, phase.period, w, H / 2), [phase.wave, phase.amp, phase.period, w])
  return (
    <div ref={ref}>
      <svg className="state-line" viewBox={`0 0 ${w} ${H}`} preserveAspectRatio="none" aria-hidden>
        <line x1={0} x2={w} y1={H / 2} y2={H / 2} stroke="rgba(255,255,255,.06)" />
        <g
          key={phase.key}
          style={{
            animation: phase.on ? `signal-${phase.key} ${phase.speed}s linear infinite` : undefined,
            filter: phase.on ? 'drop-shadow(0 0 4px rgba(212,255,0,.45))' : undefined
          }}
        >
          <path d={d} stroke={phase.color} />
        </g>
        <style>{`@keyframes signal-${phase.key} { to { transform: translateX(-${phase.period}px) } }`}</style>
      </svg>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Files: one square per file, rows per folder
// ---------------------------------------------------------------------------
interface FileCell {
  path: string
  dir: string
  edited: boolean
  created: boolean
  hot: boolean
  last: number
}

function relPath(p: string, cwd: string): string {
  const norm = (s: string): string => s.replace(/\\/g, '/').replace(/\/+$/, '')
  const a = norm(p)
  const b = norm(cwd)
  return a.toLowerCase().startsWith(b.toLowerCase() + '/') ? a.slice(b.length + 1) : a.replace(/^\/+/, '')
}

function toolPaths(t: Tool): string[] {
  const input = (t.input || {}) as Record<string, unknown>
  const p = (input.file_path || input.notebook_path) as string | undefined
  if (p) return [p]
  return (t.diffs || []).map((d) => d.path)
}

function fileCells(items: ChatItem[], cwd: string, drafts: Draft[]): FileCell[] {
  const files = new Map<string, FileCell>()
  const tools = items.filter((i): i is Tool => i.kind === 'tool')
  const touch = (raw: string, idx: number, kind: string, running: boolean): void => {
    const path = relPath(raw, cwd)
    const parts = path.split('/')
    const f = files.get(path) || { path, dir: parts.length > 1 ? parts.slice(0, -1).join('/') : '/', edited: false, created: false, hot: false, last: 0 }
    if (kind === 'edit') f.edited = true
    if (kind === 'write') f.created = true
    f.hot = f.hot || running
    f.last = idx
    files.set(path, f)
  }
  tools.forEach((t, idx) => {
    const k = toolKind(t.name)
    if (k === 'run') return
    const kind = t.diffs?.some((d) => d.kind === 'add') ? 'write' : t.diffs?.length ? 'edit' : k
    for (const p of toolPaths(t)) touch(p, idx, kind, t.status === 'running')
  })
  for (const d of drafts) if (!d.done && d.path) touch(d.path, tools.length, d.name === 'Write' ? 'write' : 'edit', true)
  return [...files.values()]
}

function FileMap({ items, cwd, drafts }: { items: ChatItem[]; cwd: string; drafts: Draft[] }) {
  const cells = useMemo(() => fileCells(items, cwd, drafts), [items, cwd, drafts])
  const rows = useMemo(() => {
    const m = new Map<string, FileCell[]>()
    for (const c of cells) m.set(c.dir, [...(m.get(c.dir) || []), c])
    return [...m.entries()].sort((a, b) => Math.max(...b[1].map((c) => c.last)) - Math.max(...a[1].map((c) => c.last))).slice(0, 9)
  }, [cells])
  const hot = cells.find((c) => c.hot)
  if (!cells.length) return <div className="faint small">Fișierele pe care le citește sau le modifică apar aici, grupate pe foldere.</div>
  return (
    <>
      {rows.map(([dir, list]) => (
        <div className="filemap-row" key={dir}>
          <div className="filemap-dir" title={dir}>
            {dir === '/' ? basename(cwd) : dir}
          </div>
          <div className="filemap-cells">
            {list.map((c) => (
              <span key={c.path} className={`cell ${c.hot ? 'hot' : c.created ? 'created' : c.edited ? 'edited' : ''}`} title={c.path} />
            ))}
          </div>
        </div>
      ))}
      <div className="filemap-legend">
        <span>
          <i className="cell" /> citit
        </span>
        <span>
          <i className="cell edited" /> modificat
        </span>
        <span>
          <i className="cell created" /> creat
        </span>
      </div>
      {hot && <div className="filemap-now">→ {hot.path}</div>}
    </>
  )
}

// ---------------------------------------------------------------------------
// Live code
// ---------------------------------------------------------------------------
function looksLikeDiff(s: string): boolean {
  return /^(@@|---|\+\+\+|diff )/m.test(s)
}

function LiveCode({ drafts }: { drafts: Draft[] }) {
  const [pinned, setPinned] = useState<string>()
  const preRef = useRef<HTMLPreElement>(null)
  const current = drafts.find((d) => d.toolId === pinned) || drafts[drafts.length - 1]
  const html = useMemo(() => {
    if (!current) return ''
    if (looksLikeDiff(current.content)) {
      return current.content
        .split('\n')
        .map((l) => {
          const esc = l.replace(/&/g, '&amp;').replace(/</g, '&lt;')
          const cls = l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('@@') ? 'hunk' : ''
          return `<span class="diff-line ${cls}" style="display:block;padding:0">${esc || ' '}</span>`
        })
        .join('')
    }
    return highlight(current.content, langOf(current.path))
  }, [current])
  useEffect(() => {
    if (preRef.current && current && !current.done) preRef.current.scrollTop = preRef.current.scrollHeight
  }, [html, current])
  if (!current) return <div className="faint small">Codul apare aici caracter cu caracter, cât timp modelul îl scrie.</div>
  const files = drafts.slice(-5)
  return (
    <>
      {files.length > 1 && (
        <div className="file-tabs">
          {files.map((d) => (
            <button key={d.toolId} className={`file-tab ${d.toolId === current.toolId ? 'on' : ''}`} onClick={() => setPinned(d.toolId)}>
              {basename(d.path || d.name)}
            </button>
          ))}
        </div>
      )}
      <div className="code-live">
        <div className="code-live-head">
          <span className="ellipsis" style={{ flex: 1 }}>
            {current.path || current.name}
          </span>
          <span className={`tag ${current.done ? '' : 'volt'}`}>{current.done ? 'scris' : current.name === 'Write' ? 'scrie' : 'editează'}</span>
        </div>
        <pre ref={preRef}>
          <code dangerouslySetInnerHTML={{ __html: html }} />
          {!current.done && <span className="caret" />}
        </pre>
      </div>
    </>
  )
}

function PlanView({ steps }: { steps: PlanStep[] }) {
  const done = steps.filter((s) => s.status === 'done').length
  return (
    <>
      <div className="plan-progress">
        <div style={{ width: `${(done / Math.max(steps.length, 1)) * 100}%` }} />
      </div>
      {steps.map((s, i) => (
        <div key={i} className={`plan-step ${s.status}`}>
          <span className="box" />
          <span>{s.text}</span>
        </div>
      ))}
    </>
  )
}

function TerminalView({ items }: { items: ChatItem[] }) {
  const runs = items.filter((i): i is Tool => i.kind === 'tool' && toolKind(i.name) === 'run').slice(-3)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  })
  if (!runs.length) return <div className="faint small">Comenzile și tot ce afișează ele apar aici.</div>
  return (
    <div className="terminal" ref={ref}>
      {runs.map((r) => (
        <div key={r.id} style={{ marginBottom: 10 }}>
          <div className="cmd">{r.command || r.title.replace(/^\$ /, '')}</div>
          {r.output ? r.output.slice(-3000) : r.status === 'running' ? '…' : ''}
        </div>
      ))}
    </div>
  )
}

export function LivePanel({ session }: { session?: SessionMeta }) {
  const id = session?.id || ''
  const items = useStore((s) => s.transcripts[id]) || EMPTY
  const status = useStore((s) => s.status[id])
  const perms = useStore((s) => s.permissions[id]) || []
  const plan = useStore((s) => s.plans[id])
  const draftMap = useStore((s) => s.drafts[id])
  const open = useStore((s) => s.liveOpen)
  const drafts = useMemo(() => Object.values(draftMap || {}).sort((a, b) => a.at - b.at), [draftMap])
  const phase = phaseOf(items, status, perms, drafts)
  const tools = items.filter((i): i is Tool => i.kind === 'tool')
  const reads = new Set(tools.filter((t) => toolKind(t.name) === 'read').flatMap(toolPaths)).size
  const edits = new Set(tools.filter((t) => ['edit', 'write'].includes(toolKind(t.name)) || t.diffs?.length).flatMap(toolPaths)).size
  const runs = tools.filter((t) => toolKind(t.name) === 'run').length
  const planDone = plan ? plan.filter((s) => s.status === 'done').length : 0

  return (
    <aside className={`live ${open ? '' : 'closed'}`} aria-label="Ce face modelul acum">
      <div className="live-section">
        <div className="live-label">
          <span>Live</span>
          {phase.on && <span className="volt">● activ</span>}
        </div>
        <Signal phase={phase} />
        <div className={`state-name ${phase.on && phase.key !== 'approval' ? 'on' : ''}`} style={phase.key === 'approval' ? { color: 'var(--warning)' } : undefined}>
          {phase.name}
        </div>
        {phase.detail && <div className={`state-detail ${phase.code ? 'code' : ''}`}>{phase.detail}</div>}
        <div className="counters">
          <div className="counter">
            <div className="v">{reads}</div>
            <div className="k">citite</div>
          </div>
          <div className="counter">
            <div className="v">{edits}</div>
            <div className="k">modificate</div>
          </div>
          <div className="counter">
            <div className="v">{runs}</div>
            <div className="k">comenzi</div>
          </div>
        </div>
      </div>
      {plan && plan.length > 0 && (
        <div className="live-section">
          <div className="live-label">
            <span>Plan</span>
            <span>
              {planDone}/{plan.length}
            </span>
          </div>
          <PlanView steps={plan} />
        </div>
      )}
      <div className="live-section">
        <div className="live-label">
          <span>Fișiere</span>
        </div>
        <FileMap items={items} cwd={session?.cwd || ''} drafts={drafts} />
      </div>
      <div className="live-section">
        <div className="live-label">
          <span>Cod live</span>
        </div>
        <LiveCode drafts={drafts} />
      </div>
      <div className="live-section" style={{ borderBottom: 0 }}>
        <div className="live-label">
          <span>Terminal</span>
        </div>
        <TerminalView items={items} />
      </div>
    </aside>
  )
}
