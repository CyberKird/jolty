import { Paperclip } from 'lucide-react'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AskQuestion, ChatItem, PermissionDecision, PermissionRequest } from '@shared/types'
import { splitQuote } from '@shared/quote'
import { diffText, newContent } from '@shared/copy-values'
import { CopyButton } from './CopyField'
import { MsgBar } from './MsgBar'
import { DiffView, imageMenu, Markdown, messageMenu, plainDashes } from './Rich'
import { tr } from '@shared/i18n'
import { Collapse } from './Collapse'
import { exitMs, usePresence } from '../usePresence'

const MAX_ZOOM = 16

/** The big preview: the wheel zooms toward the pointer, a drag moves a zoomed image, a double click toggles 3x, + - 0 from the keyboard. */
function ZoomImage({ src, name }: { src: string; name: string }) {
  const [view, setView] = useState({ s: 1, x: 0, y: 0 })
  const box = useRef<HTMLDivElement>(null)
  const grab = useRef<{ px: number; py: number; x: number; y: number } | undefined>(undefined)
  // cx, cy: the point to keep still, from the middle of the window
  const zoom = (next: (s: number) => number, cx = 0, cy = 0): void =>
    setView((v) => {
      const s = Math.min(MAX_ZOOM, Math.max(1, next(v.s)))
      if (s === 1) return { s: 1, x: 0, y: 0 }
      const k = s / v.s
      const reach = (window.innerWidth * s) / 2
      return { s, x: Math.max(-reach, Math.min(reach, cx - (cx - v.x) * k)), y: Math.max(-reach, Math.min(reach, cy - (cy - v.y) * k)) }
    })
  const from = (e: { clientX: number; clientY: number }): [number, number] => [e.clientX - window.innerWidth / 2, e.clientY - window.innerHeight / 2]
  useEffect(() => {
    // a native listener: React's wheel handler cannot stop the page from scrolling
    const back = box.current?.closest('.lightbox')
    const onWheel = (e: Event): void => {
      e.preventDefault()
      const w = e as WheelEvent
      zoom((s) => s * Math.exp(-w.deltaY * 0.001), ...from(w))
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === '+' || e.key === '=') zoom((s) => s * 1.5)
      else if (e.key === '-') zoom((s) => s / 1.5)
      else if (e.key === '0') zoom(() => 1)
    }
    back?.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('keydown', onKey)
    return () => {
      back?.removeEventListener('wheel', onWheel)
      window.removeEventListener('keydown', onKey)
    }
  }, [])
  return (
    <div ref={box} className="lightbox-zoom" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})` }}>
      <img
        src={src}
        alt={name}
        draggable={false}
        data-zoomed={view.s > 1 || undefined}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => zoom((s) => (s > 1 ? 1 : 3), ...from(e))}
        onContextMenu={(e) => imageMenu(e, src, name)}
        onPointerDown={(e) => {
          if (e.button !== 0 || view.s === 1) return
          e.currentTarget.setPointerCapture(e.pointerId)
          grab.current = { px: e.clientX, py: e.clientY, x: view.x, y: view.y }
        }}
        onPointerMove={(e) => {
          const g = grab.current
          if (g) setView((v) => ({ ...v, x: g.x + e.clientX - g.px, y: g.y + e.clientY - g.py }))
        }}
        onPointerUp={() => (grab.current = undefined)}
        onPointerCancel={() => (grab.current = undefined)}
      />
    </div>
  )
}

/** A chat image: click opens a large preview, right-click offers copy, save and open. */
export function ChatImage({ src, name, className = 'chat-image' }: { src: string; name: string; className?: string }) {
  const [big, setBig] = useState(false)
  const { shown, state } = usePresence(big)
  useEffect(() => {
    if (!big) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setBig(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [big])
  return (
    <>
      <img className={className || undefined} src={src} alt={name} title={name} onClick={() => setBig(true)} onContextMenu={(e) => imageMenu(e, src, name)} />
      {shown &&
        createPortal(
          <div className="lightbox" data-state={state} role="dialog" aria-label={tr("Previzualizare imagine")} onClick={() => setBig(false)} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation() }}>
            <ZoomImage src={src} name={name} />
          </div>,
          document.body
        )}
    </>
  )
}

type Tool = Extract<ChatItem, { kind: 'tool' }>

export type ToolKind = 'run' | 'read' | 'edit' | 'write' | 'search' | 'web' | 'agent' | 'plan' | 'other'

export function toolKind(name: string): ToolKind {
  if (name === 'Bash' || name === 'Shell' || name === 'BashOutput') return 'run'
  if (name === 'Read' || name === 'NotebookRead') return 'read'
  if (name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit') return 'edit'
  if (name === 'Write') return 'write'
  if (name === 'Glob' || name === 'Grep' || name === 'LS') return 'search'
  if (name === 'WebFetch' || name === 'WebSearch') return 'web'
  if (name === 'Task' || name === 'Agent') return 'agent'
  if (name === 'TodoWrite' || name === 'ExitPlanMode') return 'plan'
  return 'other'
}

const VERB: Record<ToolKind, string> = {
  run: tr("Rulează"),
  read: tr("Citește"),
  edit: tr("Editează"),
  write: tr("Creează"),
  search: tr("Caută"),
  web: 'Web',
  agent: 'Subagent',
  plan: 'Plan',
  other: tr("Unealtă")
}

export function toolVerb(name: string): string {
  return VERB[toolKind(name)]
}

/** The object of the action, without the verb the title starts with. */
export function toolTarget(name: string, title: string, input?: unknown): string {
  const i = (input || {}) as Record<string, unknown>
  const s = (v: unknown): string => (typeof v === 'string' ? v : '')
  const direct = s(i.command) || s(i.file_path) || s(i.notebook_path) || s(i.pattern) || s(i.url) || s(i.query) || s(i.description)
  if (direct) return direct
  const t = title.replace(/^\$ /, '')
  // the verb the engine put before the object, in the interface language
  const verbs = [tr("Citește {str}", { str: '@@' }), tr("Editează {str}", { str: '@@' }), tr("Scrie {str}", { str: '@@' }), tr("Caută fișiere {str}", { str: '@@' }), tr("Caută pe web: {str}", { str: '@@' }), tr("Deschide {str}", { str: '@@' }), tr("Caută \"{str}\"", { str: '@@' }), 'Subagent: ']
  for (const v of verbs) {
    const head = v.split('@@')[0]
    if (head && t.startsWith(head)) return t.slice(head.length).trimStart()
  }
  return t
}

/** The file a tool works on, when it is a full path (the right-click menu can then open it or show it in Explorer). */
function toolFile(t: Tool): string | undefined {
  const i = (t.input || {}) as Record<string, unknown>
  const p = i.file_path || i.notebook_path
  return typeof p === 'string' && /^([a-z]:[\/]|\/)/i.test(p) ? p : undefined
}

const FOLD_OUTPUT = 14

/** Long output shows its first lines with a fade; the button opens the rest. Copy always takes all of it. */
function Output({ text }: { text: string }) {
  const [all, setAll] = useState(false)
  const lines = useMemo(() => text.split('\n'), [text])
  if (lines.length <= FOLD_OUTPUT + 4) return <pre className="pre">{text}</pre>
  return (
    <div className={`fold ${all ? 'open' : ''}`}>
      <pre className="pre">{all ? text : lines.slice(0, FOLD_OUTPUT).join('\n')}</pre>
      <button type="button" className="fold-btn" aria-expanded={all} onClick={() => setAll(!all)}>
        {all ? tr("Restrânge") : tr("Arată tot ({n} linii)", { n: lines.length })}
      </button>
    </div>
  )
}

const ToolRow = memo(function ToolRow({ item }: { item: Tool }) {
  const [open, setOpen] = useState(false)
  const hasBody = Boolean(item.output || item.diffs?.length || item.images?.length)
  const state = item.status === 'running' ? tr("rulează") : item.status === 'error' ? tr("eroare") : tr("gata")
  const kind = toolKind(item.name)
  const file = toolFile(item)
  const target = toolTarget(item.name, item.title, item.input)
  const input = (item.input || {}) as Record<string, unknown>
  const command = kind === 'run' ? (typeof input.command === 'string' && input.command) || target : ''
  const fresh = item.diffs?.length || kind === 'write' || kind === 'edit' ? newContent(item.input, item.diffs) : ''
  const err = item.status === 'error'
  return (
    <div className={`tool ${item.status}`} data-path={file} data-item={item.id}>
      <div className="tool-top">
        <button className="tool-head" onClick={() => hasBody && setOpen(!open)} aria-expanded={open}>
          <span className="tool-verb">{toolVerb(item.name)}</span>
          <span className="tool-target">{target}</span>
          <span className="tool-state" style={{ color: item.status === 'running' ? 'var(--volt)' : err ? 'var(--critical)' : 'var(--grey-2)' }}>
            {state}
          </span>
          <span className="tool-state faint">{hasBody ? (open ? '−' : '+') : ''}</span>
        </button>
        <span className="tool-acts">
          {command ? <CopyButton label={tr("Copiază comanda")} said={tr("Comandă copiată")} get={() => command} /> : file ? <CopyButton label={tr("Copiază calea")} said={tr("Cale copiată")} get={() => file} /> : null}
          {item.output ? <CopyButton icon="file" label={err ? tr("Copiază eroarea") : tr("Copiază rezultatul")} said={err ? tr("Eroare copiată") : tr("Rezultat copiat")} get={() => item.output || ''} /> : null}
        </span>
      </div>
      <Collapse open={open && hasBody}>
        <div className="tool-body">
          {err && item.output ? (
            <div className="tool-bar">
              <CopyButton text={tr("Copiază eroarea")} done={tr("Copiat")} label={tr("Copiază eroarea")} said={tr("Eroare copiată")} get={() => item.output || ''} />
            </div>
          ) : null}
          {item.diffs?.length || fresh ? (
            <div className="tool-bar">
              {item.diffs?.length ? <CopyButton text={tr("Copiază diff-ul")} done={tr("Copiat")} label={tr("Copiază diff-ul")} said={tr("Diff copiat")} get={() => diffText(item.diffs || [])} /> : null}
              {fresh ? <CopyButton text={tr("Copiază conținutul nou")} done={tr("Copiat")} label={tr("Copiază conținutul nou al fișierului")} said={tr("Conținut copiat")} get={() => fresh} /> : null}
            </div>
          ) : null}
          {item.images?.length ? (
            <div className="images tool-images">
              {item.images.map((src, i) => (
                <ChatImage key={i} src={src} name={target.split(/[\\/]/).pop() || `imagine-${i + 1}`} />
              ))}
            </div>
          ) : null}
          {item.diffs?.length ? <DiffView diffs={item.diffs} /> : null}
          {item.output ? <Output text={item.output} /> : null}
        </div>
      </Collapse>
    </div>
  )
})

/** The thinking while it arrives: whole, readable, following its newest line unless the user scrolled up to read. */
function LiveThought({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  useEffect(() => {
    const el = ref.current
    if (el && follow.current) el.scrollTop = el.scrollHeight
  }, [text])
  return (
    <div className="reasoning reasoning-live" aria-live="polite">
      <div className="reasoning-head">{tr("Se gândește…")}</div>
      {text.trim() && (
        <div
          className="body"
          ref={ref}
          onScroll={(e) => {
            const el = e.currentTarget
            follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
          }}
        >
          {plainDashes(text)}
        </div>
      )}
    </div>
  )
}

function Reasoning({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false)
  if (!text.trim() && !live) return null
  // while it thinks, the thinking is on screen as it arrives (its latest part); afterwards it folds away
  if (live) return <LiveThought text={text} />

  return (
    <details className="reasoning" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary style={{ color: live ? 'var(--volt)' : undefined }}>{live ? tr("Se gândește…{v0}", { v0: text.trim() ? ` ${open ? '−' : '+'}` : '' }) : tr("Raționament {v0}", { v0: open ? '−' : '+' })}</summary>
      {text && <div className="body">{plainDashes(text)}</div>}
    </details>
  )
}

export const MessageItem = memo(function MessageItem({ item, live, streaming = false }: { item: ChatItem; live: boolean; streaming?: boolean }) {
  switch (item.kind) {
    case 'user': {
      const { quote, body } = splitQuote(item.text)
      return (
        <div className="msg-row" data-item={item.id} onContextMenu={(e) => messageMenu(e)}>
          <MsgBar text={body} />
          <div className="msg-user">
          {quote && <div className="msg-quote">{quote}</div>}
          {body && <div className="message-text">{body}</div>}
          {(item.images?.length || item.files?.length) ? (
            <div className="message-attachments">
              {item.images?.length ? (
                <div className="images">
                  {item.images.map((img, i) => (
                    <ChatImage key={i} src={img.dataUrl} name={img.name} />
                  ))}
                </div>
              ) : null}
              {item.files?.length ? <div className="message-files">{item.files.map((file, i) => <span key={`${file.name}-${i}`} title={file.mime}><Paperclip size={11} />{file.name}</span>)}</div> : null}
            </div>
          ) : null}
          </div>
        </div>
      )
    }
    case 'assistant':
      return item.text.trim() ? (
        <div className="msg-assistant" data-item={item.id} onContextMenu={(e) => messageMenu(e, item.text)}>
          <Markdown text={item.text} streaming={streaming} />
          {!streaming && <MsgBar text={item.text} markdown={item.text} />}
        </div>
      ) : null
    case 'reasoning':
      return <Reasoning text={item.text} live={live} />
    case 'tool':
      return <ToolRow item={item} />
    case 'notice':
      return <div className={`msg-notice ${item.level}`}>{plainDashes(item.text)}</div>
  }
})

export function PermissionCard({ req, onDecide: decideNow }: { req: PermissionRequest; onDecide: (d: PermissionDecision) => void }) {
  const isPlan = Boolean(req.plan)
  // the card plays its exit, then the answer goes out (a double click answers once)
  const [leaving, setLeaving] = useState(false)
  const onDecide = (d: PermissionDecision): void => {
    if (leaving) return
    setLeaving(true)
    window.setTimeout(() => decideNow(d), exitMs() + 20)
  }
  return (
    <div className="permission" data-state={leaving ? 'closed' : 'open'} role="alertdialog" aria-label={tr("Cerere de aprobare")}>
      <div className="row" style={{ alignItems: 'baseline', marginBottom: 6 }}>
        <div className="permission-title">{isPlan ? 'Aprobi planul?' : tr("Permiți?")}</div>
        <span className="tag volt">{toolVerb(req.toolName)}</span>
      </div>
      <div className="target">{req.title.replace(/^\$ /, '$ ')}</div>
      {(req.plan || req.diffs?.length || req.detail) && (
        <div className="body">
          {req.plan ? (
            <div style={{ padding: '14px 16px' }}>
              <Markdown text={req.plan} />
            </div>
          ) : req.diffs?.length ? (
            <DiffView diffs={req.diffs} />
          ) : (
            <pre className="pre">{req.detail}</pre>
          )}
        </div>
      )}
      <div className="row">
        <button className="btn primary" onClick={() => onDecide('allow')}>
          {isPlan ? tr("Aprobă planul") : 'Permite'}
        </button>
        {req.canAllowForSession && (
          <button className="btn" onClick={() => onDecide('allowSession')}>
            {req.sessionLabel || tr("Mereu în sesiune")}
          </button>
        )}
        <div className="spacer" />
        <button className="btn ghost danger" onClick={() => onDecide('deny')}>
         {tr("Refuză")}
        </button>
      </div>
    </div>
  )
}

/** A question with choices from the agent (AskUserQuestion, ask_user): options, a typed answer, dismiss or send. */
export function QuestionCard({ req, onAnswer }: { req: PermissionRequest; onAnswer: (answers: Record<string, string> | undefined) => void }) {
  const questions = req.questions || []
  const [picked, setPicked] = useState<string[][]>(() => questions.map(() => []))
  const [typed, setTyped] = useState<string[]>(() => questions.map(() => ''))
  const [leaving, setLeaving] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const answerOf = (i: number): string => {
    const text = typed[i].trim()
    return [...picked[i], ...(text ? [text] : [])].join(', ')
  }
  const complete = questions.every((_, i) => answerOf(i))
  const finish = (answers: Record<string, string> | undefined): void => {
    if (leaving) return
    setLeaving(true)
    window.setTimeout(() => onAnswer(answers), exitMs() + 20)
  }
  const send = (): void => {
    if (complete) finish(Object.fromEntries(questions.map((q, i) => [q.question, answerOf(i)])))
  }
  const choose = (i: number, label: string): void => {
    const q = questions[i]
    setPicked((all) => all.map((p, k) => (k !== i ? p : q.multiSelect ? (p.includes(label) ? p.filter((x) => x !== label) : [...p, label]) : p[0] === label ? [] : [label])))
    // one choice or a typed answer: picking an option replaces what was typed
    if (!q.multiSelect) setTyped((all) => all.map((t, k) => (k === i ? '' : t)))
  }
  const type = (i: number, text: string): void => {
    setTyped((all) => all.map((t, k) => (k === i ? text : t)))
    if (!questions[i].multiSelect && text) setPicked((all) => all.map((p, k) => (k === i ? [] : p)))
  }
  // number keys pick an option of the first question still open, Enter sends; never while typing elsewhere
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (leaving || e.ctrlKey || e.metaKey || e.altKey) return
      const el = document.activeElement as HTMLElement | null
      const inCard = Boolean(el && rootRef.current?.contains(el))
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !(inCard && e.key === 'Enter')) return
      if (el?.isContentEditable) return
      if (e.key === 'Enter' && (inCard || !el || el === document.body)) {
        if (!complete) return
        e.preventDefault()
        send()
        return
      }
      const n = Number(e.key)
      if (!Number.isInteger(n) || n < 1) return
      const i = Math.max(0, questions.findIndex((_, k) => !answerOf(k)))
      const opt = questions[i]?.options[n - 1]
      if (opt) {
        e.preventDefault()
        choose(i, opt.label)
      } else if (n === (questions[i]?.options.length || 0) + 1) {
        e.preventDefault()
        rootRef.current?.querySelectorAll<HTMLInputElement>('.question-own input')[i]?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  return (
    <div ref={rootRef} className="permission question" data-state={leaving ? 'closed' : 'open'} role="dialog" aria-label={tr("Întrebare")}>
      <div className="question-kicker">{tr("Întrebare")}</div>
      {questions.map((q, i) => (
        <QuestionBlock key={q.question} q={q} picked={picked[i]} typed={typed[i]} onPick={(label) => choose(i, label)} onType={(t) => type(i, t)} />
      ))}
      <div className="row question-actions">
        <button className="btn ghost" onClick={() => finish(undefined)}>
          {tr("Decide tu")}
        </button>
        <div className="spacer" />
        <button className="btn primary" disabled={!complete} onClick={send}>
          {tr("Trimite")}
        </button>
      </div>
    </div>
  )
}

function QuestionBlock({ q, picked, typed, onPick, onType }: { q: AskQuestion; picked: string[]; typed: string; onPick: (label: string) => void; onType: (text: string) => void }) {
  return (
    <div className="question-block" role="group" aria-label={q.question}>
      <div className="question-text">
        {q.header && <span className="tag volt">{q.header}</span>}
        <span>{q.question}</span>
      </div>
      <div className="question-hint">{q.multiSelect ? tr("Alege unul sau mai multe răspunsuri") : tr("Alege un răspuns")}</div>
      <div className="question-options" role={q.multiSelect ? 'group' : 'radiogroup'}>
        {q.options.map((o, k) => {
          const on = picked.includes(o.label)
          return (
            <button key={o.label} type="button" className="question-option" role={q.multiSelect ? 'checkbox' : 'radio'} aria-checked={on} data-on={on || undefined} data-multi={q.multiSelect || undefined} onClick={() => onPick(o.label)}>
              <span className="question-mark" aria-hidden />
              <span className="question-body">
                <span className="question-label">{o.label}</span>
                {o.description && <span className="question-desc">{o.description}</span>}
              </span>
              <kbd>{k + 1}</kbd>
            </button>
          )
        })}
        <label className="question-option question-own" data-on={typed.trim() ? true : undefined} data-multi={q.multiSelect || undefined}>
          <span className="question-mark" aria-hidden />
          <input value={typed} maxLength={2000} placeholder={tr("Scrie alt răspuns...")} onChange={(e) => onType(e.target.value)} />
          <kbd>{q.options.length + 1}</kbd>
        </label>
      </div>
    </div>
  )
}
