import { ExternalLink, RotateCw, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChatItem, FileDiff, PermissionRequest, PlanStep, SessionMeta } from '@shared/types'
import { clock, etaLabel, timeLeft, type Clock } from '@shared/eta'
import { api, basename, useStore, type Draft } from '../store'
import { toolKind } from './Messages'
import { DiffView, highlight, langOf } from './Rich'
import { useNow } from './Tasks'
import { tr } from '@shared/i18n'

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
  idle: { name: tr("În repaus"), wave: 'flat', amp: 0, period: 60, speed: 6, color: 'rgba(255,255,255,.22)', on: false },
  think: { name: tr("Se gândește"), wave: 'sine', amp: 9, period: 110, speed: 3.2, color: 'var(--volt)', on: true },
  answer: { name: tr("Scrie răspunsul"), wave: 'sine', amp: 14, period: 62, speed: 1.6, color: 'var(--volt)', on: true },
  run: { name: tr("Rulează"), wave: 'spike', amp: 24, period: 96, speed: 1.1, color: 'var(--volt)', on: true },
  read: { name: tr("Citește"), wave: 'pulse', amp: 12, period: 44, speed: 1.4, color: 'var(--volt)', on: true },
  edit: { name: tr("Editează"), wave: 'square', amp: 13, period: 52, speed: 1.3, color: 'var(--volt)', on: true },
  write: { name: tr("Creează"), wave: 'square', amp: 16, period: 40, speed: 1.1, color: 'var(--volt)', on: true },
  search: { name: tr("Caută"), wave: 'saw', amp: 13, period: 48, speed: 1.2, color: 'var(--volt)', on: true },
  web: { name: tr("Pe internet"), wave: 'saw', amp: 10, period: 70, speed: 2, color: 'var(--volt)', on: true },
  agent: { name: tr("Subagenți"), wave: 'pulse', amp: 18, period: 36, speed: 0.9, color: 'var(--volt)', on: true },
  plan: { name: tr("Planifică"), wave: 'sine', amp: 7, period: 140, speed: 3.6, color: 'var(--volt)', on: true },
  approval: { name: tr("Așteaptă acordul"), wave: 'pulse', amp: 16, period: 150, speed: 2.4, color: 'var(--warning)', on: true },
  error: { name: tr("S-a oprit"), wave: 'flat', amp: 0, period: 60, speed: 6, color: 'var(--critical)', on: false }
}

function phaseOf(items: ChatItem[], status: string | undefined, perms: PermissionRequest[], drafts: Draft[]): Phase {
  const make = (key: string, detail?: string, code = false): Phase => ({ key, detail, code, ...PHASES[key] })
  if (perms.length) return make('approval', perms[0].title, true)
  if (status === 'error') return make('error', tr("Vezi mesajul din conversație."))
  if (status !== 'running') return make('idle', tr("Trimite un mesaj și urmărești aici fiecare pas."))
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
// Files touched in this conversation
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

/** A path shown relative to the project, back to the full path the menu actions need. */
function absPath(p: string, cwd: string): string {
  return /^[a-z]:[\\/]/i.test(p) ? p : `${cwd.replace(/[\\/]+$/, '')}/${p}`
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
  const ordered = useMemo(() => [...cells].sort((a, b) => b.last - a.last), [cells])
  if (!cells.length) return <div className="faint small">{tr("Fișierele citite sau modificate apar aici.")}</div>
  return (
    <>
      {ordered.map((c) => (
        <div
          className="filemap-row"
          key={c.path}
          title={c.path}
          data-path={absPath(c.path, cwd)}
        >
          <span className={`cell ${c.hot ? 'hot' : c.created ? 'created' : c.edited ? 'edited' : ''}`} aria-hidden="true" />
          <div className="filemap-info">
            <div className="filemap-name">{basename(c.path)}</div>
            <div className="filemap-dir">{c.dir === '/' ? basename(cwd) : c.dir}</div>
          </div>
        </div>
      ))}
      <div className="filemap-legend">
        <span>
          <i className="cell" /> {tr("citit")}
        </span>
        <span>
          <i className="cell edited" /> {tr("modificat")}
        </span>
        <span>
          <i className="cell created" /> {tr("creat")}
        </span>
      </div>
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
  if (!current) return <div className="faint small">{tr("Codul apare aici caracter cu caracter, cât timp modelul îl scrie.")}</div>
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
          <span className={`tag ${current.done ? '' : 'volt'}`}>{current.done ? 'scris' : current.name === 'Write' ? 'scrie' : tr("editează")}</span>
        </div>
        <pre ref={preRef}>
          <code dangerouslySetInnerHTML={{ __html: html }} />
          {!current.done && <span className="caret" />}
        </pre>
      </div>
    </>
  )
}

function PlanView({ steps, timer, running, now }: { steps: PlanStep[]; timer?: Clock; running: boolean; now: number }) {
  const done = steps.filter((s) => s.status === 'done').length
  return (
    <>
      <div className="plan-eta">
        <span>
          {done}/{steps.length} {tr("gata")}
        </span>
        {running && done < steps.length && <span className="volt">{etaLabel(timeLeft(timer, steps, now))}</span>}
      </div>
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

// ---------------------------------------------------------------------------
// Changes: every file the agent touched, with its diff, like Claude Code's diff pane
// ---------------------------------------------------------------------------
interface Change {
  path: string
  kind: FileDiff['kind']
  add: number
  del: number
  diffs: FileDiff[]
}

function changesOf(items: ChatItem[], cwd: string): Change[] {
  const m = new Map<string, Change>()
  for (const it of items) {
    if (it.kind !== 'tool' || it.status === 'error') continue
    for (const d of it.diffs || []) {
      const path = relPath(d.path, cwd)
      const c = m.get(path) || { path, kind: d.kind, add: 0, del: 0, diffs: [] }
      if (d.kind === 'delete') c.kind = 'delete'
      for (const l of d.diff.split('\n')) {
        if (l.startsWith('+') && !l.startsWith('+++')) c.add++
        else if (l.startsWith('-') && !l.startsWith('---')) c.del++
      }
      c.diffs.push({ ...d, path })
      // most recently touched file first
      m.delete(path)
      m.set(path, c)
    }
  }
  return [...m.values()].reverse()
}

function ChangesView({ changes, cwd }: { changes: Change[]; cwd: string }) {
  const [open, setOpen] = useState<string>()
  if (!changes.length) return <div className="faint small">{tr("Fișierele modificate apar aici, cu diferențele linie cu linie.")}</div>
  const add = changes.reduce((a, c) => a + c.add, 0)
  const del = changes.reduce((a, c) => a + c.del, 0)
  return (
    <>
      <div className="changes-sum">
        {changes.length} {changes.length === 1 ? tr("fișier") : tr("fișiere")} <b className="plus">+{add}</b> <b className="minus">-{del}</b>
      </div>
      {changes.map((c) => {
        const dir = c.path.includes('/') ? c.path.slice(0, c.path.lastIndexOf('/') + 1) : ''
        return (
          <div className="change" key={c.path} data-path={absPath(c.path, cwd)}>
            <button className="change-row" aria-expanded={open === c.path} onClick={() => setOpen(open === c.path ? undefined : c.path)} title={c.path}>
              <span className={`change-kind ${c.kind}`}>{c.kind === 'add' ? 'A' : c.kind === 'delete' ? 'D' : 'M'}</span>
              <span className="ellipsis change-path">
                <span className="faint">{dir}</span>
                {basename(c.path)}
              </span>
              <b className="plus">+{c.add}</b>
              <b className="minus">-{c.del}</b>
            </button>
            {open === c.path && (
              <div className="change-diff">
                <DiffView diffs={c.diffs} />
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}

function TerminalView({ items }: { items: ChatItem[] }) {
  const runs = items.filter((i): i is Tool => i.kind === 'tool' && toolKind(i.name) === 'run').slice(-20)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  })
  if (!runs.length) return <div className="faint small">{tr("Comenzile și tot ce afișează ele apar aici.")}</div>
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

/** Playwright MCP's tools, whatever prefix the engine gives them (mcp__jolty-browser__browser_click). */
const isBrowserTool = (name: string): boolean => /(^|__)browser_/.test(name)

/** One line for what a browser tool call does, from its own input: "Click · Add to cart". */
function browserAction(t: Tool): string {
  const i = (t.input || {}) as Record<string, unknown>
  const s = (k: string): string => (typeof i[k] === 'string' ? (i[k] as string) : '')
  const verb = t.name.replace(/^.*browser_/, '')
  const label: Record<string, [string, string]> = {
    click: [tr("Click"), s('element')],
    hover: [tr("Click"), s('element')],
    type: [tr("Tastează"), s('element')],
    fill_form: [tr("Tastează"), ''],
    press_key: [tr("Tastează"), s('key')],
    navigate: [tr("Navighează"), s('url')],
    navigate_back: [tr("Navighează"), ''],
    take_screenshot: [tr("Screenshot"), ''],
    scroll: [tr("Derulează"), ''],
    snapshot: [tr("Citește pagina"), ''],
    find: [tr("Citește pagina"), s('query')]
  }
  const [name, what] = label[verb] || [verb.replace(/_/g, ' '), '']
  return what ? `${name} · ${what}` : name
}

function BrowserView({ items }: { items: ChatItem[] }) {
  const live = useStore((s) => s.browserLive)
  const actions = items.filter((i): i is Tool => i.kind === 'tool' && isBrowserTool(i.name)).slice(-4).reverse()
  // the stream runs only while this tab is on screen
  useEffect(() => {
    void api.browser.live(true)
    return () => void api.browser.live(false)
  }, [])
  // the actions show even before there is a picture: they say what the model is doing right now
  const list = (
    <div className="browser-actions">
      {actions.map((a, n) => (
        <div key={a.id} className={`browser-action ${n === 0 ? 'now' : ''} ${a.status === 'running' ? 'running' : ''}`}>
          {browserAction(a)}
        </div>
      ))}
    </div>
  )
  if (live.note || !live.frame)
    return (
      <>
        {list}
        <div className="faint small">{live.note || tr("Se conectează la browserul Jolty…")}</div>
      </>
    )
  return (
    <div className="browser-live">
      {list}
      <div className="browser-live-url ellipsis" title={live.url}>
        {live.url}
      </div>
      <img src={`data:image/jpeg;base64,${live.frame}`} alt={live.title ? `Pagina ${live.title}` : tr("Pagina din browserul Jolty")} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Preview: the page or dev server the model is building, rendered and kept current
// ---------------------------------------------------------------------------
const DEV_SERVER = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):\d{2,5}/g
const HTML_FILE = /\.html?$/i
// a dev server the model started in the background says nothing in the tool result, so its command is the hint
const SERVER_CMD = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve)\b|\bnext\s+dev\b|\bvite\b(?!\s+build)|\bastro\s+dev\b|\bnuxt\s+dev\b|http\.server|live-server|\bnpx\s+serve\b/
const DEV_PORTS = [3000, 3001, 3002, 4321, 5173, 5174, 4200, 8000, 8080, 1313]

/** What the preview shows: a dev server the model started (HMR keeps it current), else the latest HTML page it touched. */
function previewSource(items: ChatItem[], cwd: string, drafts: Draft[]): Source {
  const runs = items.filter((i): i is Tool => i.kind === 'tool' && toolKind(i.name) === 'run').slice(-20)
  const dev = runs.flatMap((r) => r.output?.match(DEV_SERVER) || []).pop()?.replace('0.0.0.0', 'localhost')
  const hint = runs.some((r) => SERVER_CMD.test(r.command || r.title))
  const page = fileCells(items, cwd, drafts)
    // inside the project only: the preview server serves nothing else
    .filter((c) => HTML_FILE.test(c.path) && !c.path.includes('node_modules/') && !/^[a-z]:|^\.\./i.test(c.path))
    .sort((a, b) => b.last - a.last)[0]?.path
  return { dev, page, hint }
}

interface Source {
  dev?: string
  page?: string
  hint?: boolean
}

function PreviewView({ source, cwd, drafts }: { source: Source; cwd: string; drafts: Draft[] }) {
  const [base, setBase] = useState('')
  const [nonce, setNonce] = useState(0)
  const sent = useRef(0)
  const [probed, setProbed] = useState('')
  const { page, hint } = source
  const dev = source.dev || probed
  // no address in the output: look for the server on the usual ports until one answers
  useEffect(() => {
    if (source.dev || !hint) return
    let live = true
    const look = (): void => void api.preview.probe(DEV_PORTS).then((up) => live && up.length && setProbed(`http://localhost:${up[0]}`))
    look()
    const t = setInterval(look, 2500)
    return () => {
      live = false
      clearInterval(t)
    }
  }, [source.dev, hint])
  useEffect(() => {
    if (!dev && page && cwd) void api.preview.open(cwd).then(setBase)
  }, [dev, page, cwd])
  // a page still being written is handed to the server (at most every 0.7 s), so it renders while the model types
  const writing = drafts.filter((d) => d.name === 'Write' && d.path && HTML_FILE.test(d.path)).pop()
  useEffect(() => {
    if (!writing?.path || !base) return
    const rel = relPath(writing.path, cwd)
    const wait = writing.done ? 0 : Math.max(0, sent.current + 700 - Date.now())
    const t = setTimeout(() => {
      sent.current = Date.now()
      void api.preview.draft(rel, writing.done ? null : writing.content)
    }, wait)
    return () => clearTimeout(t)
  }, [writing?.content, writing?.done, writing?.path, base, cwd])
  const url = dev || (page && base ? `${base}/${page.split('/').map(encodeURIComponent).join('/')}` : '')
  if (!url) return <div className="faint small">{tr("Când modelul face o pagină HTML sau pornește un server (Next.js, Vite), o vezi aici cum se schimbă, fără refresh.")}</div>
  return (
    <div className="preview-live">
      <div className="preview-live-bar">
        <span className="ellipsis" title={url}>
          {url}
        </span>
        <button onClick={() => setNonce(nonce + 1)} aria-label={tr("Reîncarcă previzualizarea")} title={tr("Reîncarcă previzualizarea")}>
          <RotateCw size={13} />
        </button>
        <button onClick={() => window.open(url)} aria-label={tr("Deschide în browser")} title={tr("Deschide în browser")}>
          <ExternalLink size={13} />
        </button>
      </div>
      <iframe key={`${url}#${nonce}`} src={url} title={tr("Previzualizare")} sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals" />
    </div>
  )
}

type Tab = 'changes' | 'plan' | 'terminal' | 'code' | 'preview' | 'browser' | 'files'

const WIDTH_KEY = 'jolty.liveWidth'
function savedWidth(): number {
  try {
    return Number(localStorage.getItem(WIDTH_KEY)) || 380
  } catch {
    return 380
  }
}

export function LivePanel({ session }: { session?: SessionMeta }) {
  const id = session?.id || ''
  const cwd = session?.cwd || ''
  const items = useStore((s) => s.transcripts[id]) || EMPTY
  const status = useStore((s) => s.status[id])
  const perms = useStore((s) => s.permissions[id]) || []
  const plan = useStore((s) => s.plans[id])
  const draftMap = useStore((s) => s.drafts[id])
  const open = useStore((s) => s.liveOpen)
  const setLiveOpen = useStore((s) => s.setLiveOpen)
  const drafts = useMemo(() => Object.values(draftMap || {}).sort((a, b) => a.at - b.at), [draftMap])
  const phase = phaseOf(items, status, perms, drafts)
  const tools = items.filter((i): i is Tool => i.kind === 'tool')
  const reads = new Set(tools.filter((t) => toolKind(t.name) === 'read').flatMap(toolPaths)).size
  const edits = new Set(tools.filter((t) => ['edit', 'write'].includes(toolKind(t.name)) || t.diffs?.length).flatMap(toolPaths)).size
  const runs = tools.filter((t) => toolKind(t.name) === 'run').length
  const planDone = plan ? plan.filter((s) => s.status === 'done').length : 0
  const changes = useMemo(() => changesOf(items, cwd), [items, cwd])
  const fileCount = useMemo(() => fileCells(items, cwd, drafts).length, [items, cwd, drafts])
  const source = useMemo(() => previewSource(items, cwd, drafts), [items, cwd, drafts])
  const previewable = !!(source.dev || source.page || source.hint)
  const timer = useStore((s) => s.clocks[id])
  const running = status === 'running'
  const now = useNow(running)
  const lastTool = tools[tools.length - 1]
  const browsing = running && lastTool?.status === 'running' && isBrowserTool(lastTool.name)

  // The tab follows what the agent does until the user picks one; each conversation starts following again.
  const [picked, setPicked] = useState<Tab>()
  const auto = useRef<Tab>('changes')
  useEffect(() => {
    setPicked(undefined)
    auto.current = 'changes'
  }, [id])
  if (phase.key === 'write' || phase.key === 'edit') auto.current = previewable ? 'preview' : 'code'
  else if (phase.key === 'run') auto.current = 'terminal'
  else if (browsing) auto.current = 'browser'
  else if (phase.key === 'plan' && plan?.length) auto.current = 'plan'
  else if (phase.key === 'idle' && changes.length) auto.current = 'changes'
  const tab = picked || auto.current
  // seven tabs do not all fit: the one in use (also when the model switches it) is never left off the edge
  useEffect(() => {
    document.querySelector('.live-tab.on')?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  }, [tab, open])

  const [width, setWidth] = useState(savedWidth)
  const [resizing, setResizing] = useState(false)
  const startResize = (e: React.PointerEvent): void => {
    setResizing(true)
    const x0 = e.clientX
    const w0 = width
    let w = w0
    const move = (ev: PointerEvent): void => {
      // the panel sits on the left in right-to-left layouts, so dragging right widens it there
      const pull = document.documentElement.dir === 'rtl' ? ev.clientX - x0 : x0 - ev.clientX
      w = Math.max(300, Math.min(window.innerWidth * 0.55, w0 + pull))
      setWidth(w)
    }
    const up = (): void => {
      setResizing(false)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      try {
        localStorage.setItem(WIDTH_KEY, String(Math.round(w)))
      } catch {
        // remembering the width is a convenience only
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const TABS: { id: Tab; label: string; count?: string }[] = [
    { id: 'changes', label: tr("Modificări"), count: changes.length ? String(changes.length) : undefined },
    { id: 'plan', label: tr("Plan"), count: plan?.length ? `${planDone}/${plan.length}` : undefined },
    { id: 'terminal', label: tr("Terminal"), count: runs ? String(runs) : undefined },
    { id: 'code', label: tr("Cod live"), count: drafts.some((d) => !d.done) ? '●' : undefined },
    { id: 'preview', label: tr("Previzualizare"), count: previewable && drafts.some((d) => !d.done) ? '●' : undefined },
    { id: 'browser', label: tr("Browser"), count: browsing ? '●' : undefined },
    { id: 'files', label: tr("Fișiere"), count: fileCount ? String(fileCount) : undefined }
  ]

  return (
    <aside className={`live ${open ? '' : 'closed'} ${resizing ? 'resizing' : ''}`} style={open ? { width } : undefined} aria-label={tr("Ce face modelul acum")}>
      {open && <div className="live-resize" onPointerDown={startResize} role="separator" aria-orientation="vertical" aria-label={tr("Lățimea panoului")} />}
      <div className="live-section live-status">
        <div className="live-label">
          <span>{tr("Live")}</span>
          {phase.on && <span className="volt">{tr("● activ")}</span>}
          {/* only shown when the panel floats over the chat and covers the header toggle */}
          <button className="live-close" onClick={() => setLiveOpen(false)} aria-label={tr("Închide panoul Live")} title={tr("Închide panoul Live")}>
            <X size={14} />
          </button>
        </div>
        <Signal phase={phase} />
        <div className={`state-name ${phase.on && phase.key !== 'approval' ? 'on' : ''}`} style={phase.key === 'approval' ? { color: 'var(--warning)' } : undefined}>
          {phase.name}
        </div>
        {phase.detail && <div className={`state-detail ${phase.code ? 'code' : ''}`}>{phase.detail}</div>}
        <div className="counters">
          <div className="counter">
            <div className="v">{reads}</div>
            <div className="k">{tr("citite")}</div>
          </div>
          <div className="counter">
            <div className="v">{edits}</div>
            <div className="k">{tr("modificate")}</div>
          </div>
          <div className="counter">
            <div className="v">{runs}</div>
            <div className="k">{tr("comenzi")}</div>
          </div>
          <div className="counter" title={tr("Cât lucrează la mesajul curent")}>
            <div className="v">{running && timer?.turn ? clock(now - timer.turn) : '0:00'}</div>
            <div className="k">{tr("timp")}</div>
          </div>
        </div>
      </div>
      <div className="live-tabs" role="tablist" aria-label={tr("Panouri")}>
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={`live-tab ${tab === t.id ? 'on' : ''}`} onClick={() => setPicked(t.id)}>
            {t.label}
            {t.count && <span className="live-tab-count">{t.count}</span>}
          </button>
        ))}
      </div>
      <div className="live-pane" role="tabpanel">
        {tab === 'changes' && <ChangesView changes={changes} cwd={cwd} />}
        {tab === 'plan' &&
          (plan?.length ? <PlanView steps={plan} timer={timer} running={running} now={now} /> :<div className="faint small">{tr("Pașii pe care și-i propune modelul apar aici și se bifează pe măsură ce îi termină.")}</div>)}
        {tab === 'terminal' && <TerminalView items={items} />}
        {tab === 'code' && <LiveCode drafts={drafts} />}
        {tab === 'preview' && <PreviewView source={source} cwd={cwd} drafts={drafts} />}
        {tab === 'browser' && <BrowserView items={items} />}
        {tab === 'files' && <FileMap items={items} cwd={cwd} drafts={drafts} />}
      </div>
    </aside>
  )
}
