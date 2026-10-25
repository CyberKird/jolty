import { Paperclip } from 'lucide-react'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ChatItem, PermissionDecision, PermissionRequest } from '@shared/types'
import { splitQuote } from '@shared/quote'
import { diffText, newContent } from '@shared/copy-values'
import { CopyButton } from './CopyField'
import { MsgBar } from './MsgBar'
import { DiffView, imageMenu, Markdown, messageMenu, plainDashes } from './Rich'
import { tr } from '@shared/i18n'
import { Collapse } from './Collapse'
import { exitMs, usePresence } from '../usePresence'

/** A chat image: click opens a large preview, right-click offers copy, save and open. */
function ChatImage({ src, name }: { src: string; name: string }) {
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
      <img className="chat-image" src={src} alt={name} title={name} onClick={() => setBig(true)} onContextMenu={(e) => imageMenu(e, src, name)} />
      {shown &&
        createPortal(
          <div className="lightbox" data-state={state} role="dialog" aria-label={tr("Previzualizare imagine")} onClick={() => setBig(false)} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation() }}>
            <img src={src} alt={name} onClick={(e) => e.stopPropagation()} onContextMenu={(e) => imageMenu(e, src, name)} />
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
    <div className={`tool ${item.status}`} data-path={file}>
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
        <div className="msg-row" onContextMenu={(e) => messageMenu(e)}>
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
        <div className="msg-assistant" onContextMenu={(e) => messageMenu(e, item.text)}>
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
