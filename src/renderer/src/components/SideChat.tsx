// The side chat (like Claude Desktop's "New Side Chat"): a quick question in a panel beside the conversation,
// in its own throwaway read-only session, so the main chat's context and running turn stay untouched.
// Closing the panel keeps it for the session; it can be promoted to a normal chat or its answer quoted into the main composer.
import { ArrowUp, ArrowUpRight, Loader2, MessagesSquare, Quote as QuoteIcon, Square, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { create } from 'zustand'
import type { ChatItem, SessionMeta } from '@shared/types'
import { isAcp } from '@shared/types'
import { clipQuote } from '@shared/quote'
import { tr } from '@shared/i18n'
import { api, errMsg, useStore } from '../store'
import { usePresence } from '../usePresence'
import { MessageItem } from './Messages'
import { ModelPicker, useAllModels } from './ModelPicker'
import './side-chat.css'

interface Side {
  id: string
  profileId: string
  model?: string
  effort?: string
  brief: string
  tokens: number
}

/** per main chat: whether the panel is open and the side chat it holds (memory only, like the chat itself) */
const useSide = create<{ open: Record<string, boolean>; chats: Record<string, Side | undefined> }>(() => ({ open: {}, chats: {} }))
const setOpen = (mainId: string, on: boolean): void => useSide.setState((s) => ({ open: { ...s.open, [mainId]: on } }))
const setChat = (mainId: string, c: Side | undefined): void => useSide.setState((s) => ({ chats: { ...s.chats, [mainId]: c } }))

const EMPTY: ChatItem[] = []

const lastAnswer = (items: ChatItem[]): string | undefined => {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (it.kind === 'assistant' && it.text.trim()) return it.text.trim()
  }
  return undefined
}

/** The header button; Ctrl+Shift+S does the same. */
export function SideChatButton({ session }: { session: SessionMeta }) {
  const open = useSide((s) => Boolean(s.open[session.id]))
  return (
    <button
      className={`btn ghost small icon ${open ? 'side-on' : ''}`}
      aria-pressed={open}
      onClick={() => setOpen(session.id, !open)}
      title={open ? tr("Închide conversația laterală (Ctrl+Shift+S)") : tr("Conversație laterală: o întrebare rapidă, fără să încarce conversația (Ctrl+Shift+S)")}
    >
      <MessagesSquare size={15} />
    </button>
  )
}

export function SideChat({ session }: { session: SessionMeta }) {
  const mainId = session.id
  const open = useSide((s) => Boolean(s.open[mainId]))
  const side = useSide((s) => s.chats[mainId])
  const { shown, state } = usePresence(open)
  const profiles = useStore((s) => s.profiles)
  const toast = useStore((s) => s.toast)
  const items = useStore((s) => (side ? s.transcripts[side.id] : undefined)) || EMPTY
  const running = useStore((s) => (side ? s.status[side.id] === 'running' : false))
  const able = useMemo(() => profiles.filter((p) => !isAcp(p.engine)), [profiles])
  const groups = useAllModels(able)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const panel = useRef<HTMLElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && e.shiftKey && !e.altKey && e.code === 'KeyS') {
        e.preventDefault()
        setOpen(mainId, !useSide.getState().open[mainId])
      } else if (e.key === 'Escape' && panel.current?.contains(document.activeElement)) setOpen(mainId, false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mainId])

  const start = async (pick: { profileId?: string; model?: string; effort?: string } = {}): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      const r = await api.sessions.side(mainId, pick.profileId, pick.model, pick.effort)
      setChat(mainId, { id: r.meta.id, profileId: r.meta.profileId, model: r.meta.model, effort: r.meta.effort, brief: r.brief, tokens: r.tokens })
    } catch (err) {
      setError(errMsg(err))
    } finally {
      setBusy(false)
    }
  }

  // the side chat is made when the panel first opens, so a closed panel costs nothing
  useEffect(() => {
    if (open && !side && !busy && !error) void start()
    if (open) requestAnimationFrame(() => input.current?.focus())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, side])

  useEffect(() => {
    const el = list.current
    if (el) el.scrollTop = el.scrollHeight
  }, [items, shown])

  const send = async (): Promise<void> => {
    const q = text.trim()
    if (!q || !side || running) return
    setText('')
    useStore.getState().onEvent({ type: 'status', sessionId: side.id, status: 'running' })
    try {
      await api.sessions.send(side.id, q)
    } catch (err) {
      useStore.getState().onEvent({ type: 'status', sessionId: side.id, status: 'error', error: errMsg(err) })
      toast(errMsg(err), true)
    }
  }

  const pick = (profileId: string, model: string, effort?: string): void => {
    if (!side) return
    // the same account switches in place; another one (or a change before anything was asked) starts the side chat over
    if (profileId === side.profileId && items.length) {
      void api.sessions.setModel(side.id, model).then(() => (effort !== undefined ? api.sessions.setEffort(side.id, effort) : undefined))
        .then(() => setChat(mainId, { ...side, model, effort: effort ?? side.effort }))
        .catch((err) => toast(errMsg(err), true))
      return
    }
    void api.sessions.remove(side.id).catch(() => undefined)
    setChat(mainId, undefined)
    void start({ profileId, model, effort })
  }

  const promote = async (): Promise<void> => {
    if (!side) return
    try {
      const meta = await api.sessions.promoteSide(side.id)
      setChat(mainId, undefined)
      setOpen(mainId, false)
      await useStore.getState().loadSessions()
      await useStore.getState().openSession(meta.id)
      toast(tr("Conversația laterală e acum o conversație obișnuită."))
    } catch (err) {
      toast(errMsg(err), true)
    }
  }

  const insert = (): void => {
    const a = lastAnswer(items)
    if (!a) return
    useStore.getState().setQuote(mainId, clipQuote(a))
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus())
  }

  const fresh = (): void => {
    if (side) void api.sessions.remove(side.id).catch(() => undefined)
    setChat(mainId, undefined)
    setError(undefined)
  }

  if (!shown) return null
  const answer = !running && lastAnswer(items)
  return (
    <aside className="side-chat" data-state={state} ref={panel} aria-label={tr("Conversație laterală")}>
      <div className="side-head">
        <MessagesSquare size={14} aria-hidden />
        <span className="side-title">{tr("Conversație laterală")}</span>
        <span className="side-tag" title={tr("Nu scrie în conversația principală și nu modifică fișiere.")}>{tr("doar citire")}</span>
        <div className="spacer" />
        <button className="btn ghost small icon" onClick={() => void promote()} disabled={!side || !items.length || running} title={tr("Fă din ea o conversație obișnuită")}>
          <ArrowUpRight size={15} />
        </button>
        <button className="btn ghost small icon" onClick={() => setOpen(mainId, false)} title={tr("Închide (rămâne până închizi Jolty)")}>
          <X size={15} />
        </button>
      </div>
      {side && (
        <details className="side-brief">
          <summary>{tr("Context din conversație: ~{n} tokeni", { n: side.tokens })}</summary>
          <pre>{side.brief}</pre>
        </details>
      )}
      <div className="side-list" ref={list}>
        {busy && <div className="side-empty"><Loader2 size={14} className="spin" /> {tr("Pregătesc conversația laterală…")}</div>}
        {error && (
          <div className="side-empty error">
            {error}
            <button className="btn small" onClick={() => void start()}>{tr("Încearcă din nou")}</button>
          </div>
        )}
        {side && !items.length && <div className="side-empty">{tr("Întreabă ceva despre conversație. Răspunsul nu ajunge în ea și nu costă contextul ei.")}</div>}
        {items.map((it) => (
          <MessageItem key={it.id} item={it} live={running} streaming={running && it === items[items.length - 1]} />
        ))}
        {running && <div className="side-empty"><Loader2 size={14} className="spin" /></div>}
        {answer && (
          <div className="side-actions">
            <button className="btn small" onClick={insert} title={tr("Pune ultimul răspuns ca citat în mesajul conversației principale")}>
              <QuoteIcon size={12} /> {tr("Inserează răspunsul")}
            </button>
            <button className="btn ghost small" onClick={fresh}>{tr("Începe din nou")}</button>
          </div>
        )}
      </div>
      <div className="side-composer">
        <textarea
          ref={input}
          value={text}
          rows={2}
          placeholder={tr("Întrebare rapidă…")}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void send()
            }
          }}
        />
        <div className="side-bar">
          <ModelPicker groups={groups} profileId={side?.profileId} model={side?.model} effort={side?.effort} onPick={(p, m) => pick(p, m)} onEffort={(e) => side && pick(side.profileId, side.model || '', e)} />
          <div className="spacer" />
          {running ? (
            <button className="btn send-btn" onClick={() => side && void api.sessions.interrupt(side.id)} title={tr("Oprește")}>
              <Square size={12} fill="currentColor" />
            </button>
          ) : (
            <button className="btn primary send-btn" onClick={() => void send()} disabled={!text.trim() || !side} title={tr("Trimite (Enter)")}>
              <ArrowUp size={17} />
            </button>
          )}
        </div>
      </div>
    </aside>
  )
}
