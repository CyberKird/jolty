import { Paperclip } from 'lucide-react'
import { memo, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ChatItem, PermissionDecision, PermissionRequest } from '@shared/types'
import { DiffView, imageMenu, Markdown, messageMenu, plainDashes } from './Rich'

/** A chat image: click opens a large preview, right-click offers copy, save and open. */
function ChatImage({ src, name }: { src: string; name: string }) {
  const [big, setBig] = useState(false)
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
      {big &&
        createPortal(
          <div className="lightbox" role="dialog" aria-label="Previzualizare imagine" onClick={() => setBig(false)} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation() }}>
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
  run: 'Rulează',
  read: 'Citește',
  edit: 'Editează',
  write: 'Creează',
  search: 'Caută',
  web: 'Web',
  agent: 'Subagent',
  plan: 'Plan',
  other: 'Unealtă'
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
  return title.replace(/^\$ /, '').replace(/^(Citește|Editează|Scrie|Caută fișiere|Caută pe web:|Caută|Deschide|Subagent:)\s*/, '')
}

const ToolRow = memo(function ToolRow({ item }: { item: Tool }) {
  const [open, setOpen] = useState(false)
  const hasBody = Boolean(item.output || item.diffs?.length || item.images?.length)
  const state = item.status === 'running' ? 'acum' : item.status === 'error' ? 'eroare' : 'gata'
  return (
    <div className={`tool ${item.status}`}>
      <button className="tool-head" onClick={() => hasBody && setOpen(!open)} aria-expanded={open}>
        <span className="tool-verb">{toolVerb(item.name)}</span>
        <span className="tool-target">{toolTarget(item.name, item.title, item.input)}</span>
        <span className="tool-state" style={{ color: item.status === 'running' ? 'var(--volt)' : item.status === 'error' ? 'var(--critical)' : 'var(--grey-2)' }}>
          {state}
        </span>
        <span className="tool-state faint">{hasBody ? (open ? '−' : '+') : ''}</span>
      </button>
      {open && hasBody && (
        <div className="tool-body">
          {item.images?.length ? (
            <div className="images tool-images">
              {item.images.map((src, i) => (
                <ChatImage key={i} src={src} name={toolTarget(item.name, item.title, item.input).split(/[\\/]/).pop() || `imagine-${i + 1}`} />
              ))}
            </div>
          ) : null}
          {item.diffs?.length ? <DiffView diffs={item.diffs} /> : null}
          {item.output ? <pre className="pre">{item.output}</pre> : null}
        </div>
      )}
    </div>
  )
})

function Reasoning({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false)
  if (!text.trim() && !live) return null
  return (
    <details className="reasoning" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary style={{ color: live ? 'var(--volt)' : undefined }}>{live ? `Se gândește…${text.trim() ? ` ${open ? '−' : '+'}` : ''}` : `Raționament ${open ? '−' : '+'}`}</summary>
      {text && <div className="body">{plainDashes(text)}</div>}
    </details>
  )
}

export const MessageItem = memo(function MessageItem({ item, live }: { item: ChatItem; live: boolean }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="msg-user" onContextMenu={(e) => messageMenu(e)}>
          {item.text && <div className="message-text">{item.text}</div>}
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
      )
    case 'assistant':
      return item.text.trim() ? (
        <div className="msg-assistant" onContextMenu={(e) => messageMenu(e, item.text)}>
          <Markdown text={item.text} />
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

export function PermissionCard({ req, onDecide }: { req: PermissionRequest; onDecide: (d: PermissionDecision) => void }) {
  const isPlan = Boolean(req.plan)
  return (
    <div className="permission" role="alertdialog" aria-label="Cerere de aprobare">
      <div className="row" style={{ alignItems: 'baseline', marginBottom: 6 }}>
        <div className="permission-title">{isPlan ? 'Aprobi planul?' : 'Permiți?'}</div>
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
          {isPlan ? 'Aprobă planul' : 'Permite'}
        </button>
        {req.canAllowForSession && (
          <button className="btn" onClick={() => onDecide('allowSession')}>
            Mereu în sesiune
          </button>
        )}
        <div className="spacer" />
        <button className="btn ghost danger" onClick={() => onDecide('deny')}>
          Refuză
        </button>
      </div>
    </div>
  )
}
