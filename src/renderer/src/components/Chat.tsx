import { ArrowRight, ArrowUp, FolderOpen, Globe, RotateCcw, Paperclip, PanelRightClose, PanelRightOpen, Square, X } from 'lucide-react'
import { Fragment, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { assess, delegatePick, recommend } from '@shared/complexity'
import { usageRisk } from '@shared/usage-risk'
import type { Attachment, ChatItem, ModelOption, PermissionMode, Profile, SessionMeta } from '@shared/types'
import { api, basename, ENGINE_LABEL, errMsg, levelColor, resetIn, useStore } from '../store'
import { MessageItem, PermissionCard } from './Messages'
import { DEFAULT_MODE, MODES, ModelPicker, ModePicker, useAllModels, type ModelGroup } from './ModelPicker'
import { MentionMenu, useMentions } from './Mentions'
import { TaskStrip } from './Tasks'

const EMPTY: ChatItem[] = []

// ---------------------------------------------------------------------------
// Images: pasted, dropped or picked, downscaled so they stay light
// ---------------------------------------------------------------------------
async function toAttachment(file: File): Promise<Attachment> {
  // decode via a data: URL, not blob: + <img>: CSP img-src is 'self' data: only
  const src = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('fișierul nu a putut fi citit'))
    reader.readAsDataURL(file)
  })
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image()
    i.onload = () => resolve(i)
    i.onerror = () => reject(new Error('imagine invalidă'))
    i.src = src
  })
  const max = 1600
  const scale = Math.min(1, max / Math.max(img.width, img.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(img.width * scale)
  canvas.height = Math.round(img.height * scale)
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
  const png = file.type === 'image/png' && file.size < 1.5e6
  const mime = png ? 'image/png' : 'image/jpeg'
  const data = canvas.toDataURL(mime, 0.9).split(',')[1]
  return { id: crypto.randomUUID(), name: file.name || 'imagine.png', mime, data }
}

export function ProfileDot({ profile, size = 7 }: { profile?: Profile; size?: number }) {
  return <span className="dot" style={{ width: size, height: size, background: profile?.color || 'var(--grey-2)' }} />
}

// ---------------------------------------------------------------------------
// Suggestion strip: task complexity -> model and effort
// ---------------------------------------------------------------------------
function Advice({ text, images, groups, profileId, model, effort, onApply }: {
  text: string
  images: number
  groups: ModelGroup[]
  profileId?: string
  model?: string
  effort?: string
  onApply: (profileId: string, model: string, effort: string | undefined) => void
}) {
  const deferred = useDeferredValue(text)
  const limits = useStore((s) => s.limits)
  const a = useMemo(() => assess(deferred, images), [deferred, images])
  const r = useMemo(
    () => (a && profileId ? recommend(a, groups, { profileId, modelId: model, effort }, limits) : undefined),
    [a, groups, profileId, model, effort, limits]
  )
  // silent while the current choice fits: the strip only appears when something is clearly off
  if (!a || !r || r.kind === 'none') return null
  const t = r.target
  const other = t && t.profileId !== profileId
  return (
    <div className={`advice ${r.kind}`} aria-live="polite">
      <span className="advice-why" title={a.reasons.join(' · ')}>
        {r.text}
      </span>
      <span className="spacer" />
      {t && (
        <button
          className="advice-apply"
          title={other ? `Conversația continuă în ${t.profileName}, cu istoricul ei` : undefined}
          onClick={() => onApply(t.profileId, t.model.id, t.effort)}
        >
          {other ? `${t.profileName} · ` : ''}
          {t.model.label}
          {t.effort ? ` · ${t.effort}` : ''}
          <ArrowRight size={12} />
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------
interface ComposerProps {
  running: boolean
  onSend: (text: string, attachments: Attachment[]) => Promise<void> | void
  onStop?: () => void
  profiles: Profile[]
  profileId?: string
  model?: string
  /** a model from any profile; the parent decides what switching profile means */
  onPick: (profileId: string, model: string, effort?: string) => void
  otherProfileHint?: string
  effort?: string
  onEffort: (e: string) => void
  mode: PermissionMode
  onMode: (m: PermissionMode) => void
  browser?: boolean
  onBrowser: (on: boolean) => void
  cwd?: string
  onCwd?: () => void
  seed?: string
}

function Composer(p: ComposerProps) {
  const engine = p.profiles.find((profile) => profile.id === p.profileId)?.engine
  const [text, setText] = useState('')
  const [atts, setAtts] = useState<Attachment[]>([])
  const [dragging, setDragging] = useState(false)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const groups = useAllModels(p.profiles)
  const toast = useStore((s) => s.toast)
  const [caret, setCaret] = useState(0)
  const mentions = useMentions(text, caret, p.cwd)
  const costNote = usageRisk(text, atts.filter((a) => a.mime.startsWith('image/')).length, atts.filter((a) => a.mime.startsWith('video/')).length)
  // messages written while the model works wait here and go out, in order, when the turn ends
  const [queue, setQueue] = useState<{ id: string; text: string; atts: Attachment[] }[]>([])
  const queuedSent = useRef(false)

  useEffect(() => {
    if (p.running) { queuedSent.current = false; return }
    if (!queue.length || queuedSent.current) return
    queuedSent.current = true
    const [next, ...rest] = queue
    setQueue(rest)
    void p.onSend(next.text, next.atts)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.running, queue])

  useEffect(() => {
    if (p.seed) {
      setText(p.seed)
      taRef.current?.focus()
    }
  }, [p.seed])

  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 260) + 'px'
  }, [text])

  const addFiles = useCallback(
    async (files: File[]) => {
      if (!files.length) return
      const room = Math.max(0, 8 - atts.length)
      if (files.length > room) toast('Maximum 8 fișiere per mesaj.', true)
      const converted: Attachment[] = []
      for (const file of files.slice(0, room)) {
        try {
          if (file.type.startsWith('image/')) {
            converted.push(await toAttachment(file))
            continue
          }
          const localPath = api.files.path(file)
          if (localPath) {
            converted.push({ id: crypto.randomUUID(), name: file.name, mime: file.type || 'application/octet-stream', path: localPath, size: file.size })
          } else if (file.size <= 16 * 1024 * 1024) {
            const data = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader()
              reader.onload = () => resolve(String(reader.result).split(',')[1] || '')
              reader.onerror = () => reject(reader.error)
              reader.readAsDataURL(file)
            })
            converted.push({ id: crypto.randomUUID(), name: file.name, mime: file.type || 'application/octet-stream', data, size: file.size })
          } else {
            toast(`${file.name}: lipește un fișier sub 16 MB sau alege-l de pe disc.`, true)
          }
        } catch (err) { toast(`${file.name}: ${errMsg(err)}`, true) }
      }
      setAtts((a) => [...a, ...converted].slice(0, 8))
    },
    [toast, atts.length]
  )

  const submit = async (): Promise<void> => {
    const t = text.trim()
    if (!t && !atts.length) return
    setText('')
    const a = atts
    setAtts([])
    if (p.running) {
      setQueue((q) => [...q, { id: crypto.randomUUID(), text: t, atts: a }])
      return
    }
    await p.onSend(t, a)
  }

  const pickMention = (i: Parameters<typeof mentions.apply>[0]): void => {
    const r = mentions.apply(i)
    setText(r.text)
    setCaret(r.caret)
    requestAnimationFrame(() => {
      taRef.current?.focus()
      taRef.current?.setSelectionRange(r.caret, r.caret)
    })
  }

  return (
    <div className="composer-wrap">
      {queue.length > 0 && (
        <div className="queue" aria-live="polite">
          <div className="queue-title">În așteptare <span>{queue.length}</span></div>
          {queue.map((q, i) => (
            <div className="queued" key={q.id}>
              <span className="queued-order">{i + 1}</span>
              <span className="queued-text" title={q.text || q.atts.map((a) => a.name).join(', ')}>{q.text || q.atts.map((a) => a.name).join(', ')}</span>
              {q.atts.length > 0 && <span className="queued-files"><Paperclip size={11} /> {q.atts.length}</span>}
              <button onClick={() => setQueue((x) => x.filter((item) => item.id !== q.id))} aria-label="Scoate mesajul din așteptare" title="Scoate din așteptare">
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div
        className={`composer ${dragging ? 'dragging' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          void addFiles([...e.dataTransfer.files])
        }}
        onPaste={(e) => {
          const files = [...e.clipboardData.items].filter((item) => item.kind === 'file').map((item) => item.getAsFile()).filter((file): file is File => Boolean(file))
          if (files.length) { e.preventDefault(); void addFiles(files) }
        }}
      >
        {atts.length > 0 && (
          <div className="attachments">
            {atts.map((a) => (
              <div className={`attachment ${a.mime.startsWith('image/') ? 'attachment-image' : 'attachment-file'}`} key={a.id} title={a.name}>
                {a.mime.startsWith('image/') && a.data ? <img src={`data:${a.mime};base64,${a.data}`} alt={a.name} /> : <Paperclip size={15} />}
                {!a.mime.startsWith('image/') && <span className="attachment-name">{a.name}</span>}
                <button onClick={() => setAtts((x) => x.filter((y) => y.id !== a.id))} aria-label={`Scoate ${a.name}`}>
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
        {atts.some((a) => a.mime.startsWith('image/')) && engine === 'claude' && p.profiles.find((profile) => profile.id === p.profileId)?.vision === false && <div className="attachment-note">Modelul ales nu vede imagini. Jolty va folosi încă un profil ca să le descrie, cu consum suplimentar.</div>}
        {mentions.open && <MentionMenu items={mentions.items} index={mentions.index} onPick={pickMention} onHover={(i) => mentions.move(i - mentions.index)} />}
        <textarea
          ref={taRef}
          value={text}
          placeholder={p.running ? 'Scrie următorul mesaj: pleacă imediat ce termină.' : 'Descrie ce vrei să facă. / pentru skill-uri, @ pentru fișiere.'}
          onChange={(e) => {
            setText(e.target.value)
            setCaret(e.target.selectionStart)
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={(e) => {
            if (mentions.open) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                mentions.move(e.key === 'ArrowDown' ? 1 : -1)
                return
              }
              if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
                e.preventDefault()
                pickMention(mentions.items[mentions.index])
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                mentions.close()
                return
              }
            }
            if (e.key === 'Escape' && p.running && p.onStop) {
              e.preventDefault()
              p.onStop()
              return
            }
            // Shift+Tab cycles the permission mode, like Claude Code
            if (e.key === 'Tab' && e.shiftKey) {
              e.preventDefault()
              const modes = engine === 'hermes' ? (['ask', 'autoEdit', 'full'] as const) : MODES.map((m) => m.id)
              const i = modes.findIndex((mode) => mode === p.mode)
              p.onMode(modes[(i + 1) % modes.length])
              return
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void submit()
            }
          }}
          rows={1}
        />
        <Advice
          text={text}
          images={atts.length}
          groups={groups}
          profileId={p.profileId}
          model={p.model}
          effort={p.effort}
          onApply={(pid, m, e) => {
            if (pid !== p.profileId || m !== p.model) p.onPick(pid, m, e)
            else if (e) p.onEffort(e)
          }}
        />
        {costNote && <div className="attachment-note" role="status">{costNote}</div>}
        <div className="composer-bar">
          <button className="btn ghost small icon" title="Atașează imagini, videouri sau fișiere" onClick={() => fileRef.current?.click()}>
            <Paperclip size={15} />
          </button>
          <input ref={fileRef} type="file" multiple hidden onChange={(e) => { void addFiles([...(e.target.files || [])]); e.target.value = '' }} />
          {p.onCwd && (
            <button className="pill-select" style={{ paddingRight: 10, cursor: 'pointer', background: 'transparent' }} onClick={p.onCwd} title={p.cwd}>
              <FolderOpen size={13} /> <span style={{ color: 'var(--white)' }}>{p.cwd ? basename(p.cwd) : 'Alege proiectul'}</span>
            </button>
          )}
          <ModelPicker
            groups={groups}
            profileId={p.profileId}
            model={p.model}
            effort={p.effort}
            onPick={(pid, m) => {
              p.onPick(pid, m)
              // effort levels belong to the model: drop one the new model does not accept
              const next = groups.find((g) => g.profile.id === pid)?.models.find((x) => x.id === m)
              if (pid === p.profileId && p.effort && !next?.efforts?.includes(p.effort)) p.onEffort('')
            }}
            onEffort={p.onEffort}
            otherProfileHint={p.otherProfileHint}
          />
          <ModePicker mode={p.mode} onMode={p.onMode} engine={engine} />
          <button
            className={`chrome-toggle ${p.browser ? 'on' : ''}`}
            disabled={engine === 'hermes'}
            aria-pressed={Boolean(p.browser)}
            onClick={() => p.onBrowser(!p.browser)}
            title={
              engine === 'hermes' ? 'Hermes folosește uneltele proprii de browser. Conectarea la browserul Jolty nu este disponibilă.' : p.browser
                ? 'Jolty în browser e pornit: modelul poate folosi browserul tău (Chrome, Vivaldi, Edge, Brave), cu login-urile tale. Clic ca să-l oprești.'
                : 'Jolty în browser: modelul deschide pagini, dă clic, completează și citește în browserul tău. Merge cu orice model. Cere extensia Playwright (Setări).'
            }
          >
            <Globe size={14} strokeWidth={1.8} /> Browser
          </button>
          <div className="spacer" />
          {p.running && (
            <button className="btn send-btn" onClick={p.onStop} title="Oprește (Esc)">
              <Square size={12} fill="currentColor" />
            </button>
          )}
          {(!p.running || text.trim() || atts.length > 0) && (
            <button
              className="btn primary send-btn"
              onClick={() => void submit()}
              disabled={!text.trim() && !atts.length}
              title={p.running ? 'Pune în așteptare (Enter)' : 'Trimite (Enter)'}
            >
              <ArrowUp size={17} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Header pieces
// ---------------------------------------------------------------------------
/**
 * A user message with "undo from here": the button appears only after a dry run (on hover) finds
 * files Claude Code can actually restore; a second click confirms.
 */
function UserTurn({ sessionId, itemId, disabled, children }: { sessionId: string; itemId: string; disabled: boolean; children: React.ReactNode }) {
  const [armed, setArmed] = useState(false)
  const [preview, setPreview] = useState<number>()
  const toast = useStore((s) => s.toast)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 4000)
    return () => clearTimeout(t)
  }, [armed])
  const probe = (): void => {
    if (disabled || preview !== undefined) return
    setPreview(-1)
    void api.sessions
      .rewind(sessionId, itemId, true)
      .then((r) => setPreview(r.files.length))
      .catch(() => setPreview(0))
  }
  return (
    <div className="user-turn" onMouseEnter={probe}>
      {children}
      {!disabled && preview !== undefined && preview > 0 && (
        <button
          className={`rewind ${armed ? 'armed' : ''}`}
          title="Readuce fișierele proiectului la starea de dinainte de acest mesaj"
          onClick={() => {
            if (!armed) return setArmed(true)
            setArmed(false)
            void api.sessions
              .rewind(sessionId, itemId)
              .then((r) => {
                setPreview(0)
                toast(`Am anulat modificările din ${r.files.length} ${r.files.length === 1 ? 'fișier' : 'fișiere'}`)
              })
              .catch((e) => toast(errMsg(e), true))
          }}
        >
          <RotateCcw size={12} /> {armed ? 'Sigur? Clic din nou' : `Anulează modificările de aici (${preview} ${preview === 1 ? 'fișier' : 'fișiere'})`}
        </button>
      )}
    </div>
  )
}

/** How full the context is, with one click to compact it, like the Claude app's context indicator. */
function ContextMeter({ sessionId, running }: { sessionId: string; running: boolean }) {
  const ctx = useStore((s) => s.contexts[sessionId])
  const toast = useStore((s) => s.toast)
  if (!ctx?.used) return null
  const pct = ctx.window ? Math.min(100, (ctx.used / ctx.window) * 100) : undefined
  const k = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`)
  return (
    <button
      className={`context-meter ${pct !== undefined && pct >= 80 ? 'high' : ''}`}
      disabled={running}
      title={`${k(ctx.used)}${ctx.window ? ` din ${k(ctx.window)}` : ''} tokeni în context. Clic ca să compactezi: modelul rezumă conversația și eliberează loc.`}
      onClick={() => void api.sessions.compact(sessionId).then(() => toast('Compactez conversația…')).catch((e) => toast(errMsg(e), true))}
    >
      <span className="context-ring" style={{ ['--p' as string]: `${pct ?? 0}` }} aria-hidden />
      {pct !== undefined ? `${Math.round(pct)}%` : k(ctx.used)}
    </button>
  )
}

function MiniLimits({ profileId }: { profileId: string }) {
  const snap = useStore((s) => s.limits[profileId])
  if (!snap?.windows.length) return null
  return (
    <div className="mini-limits">
      {snap.windows.slice(0, 2).map((w) => (
        <div className="mini-limit" key={w.label} title={`${w.label}: ${Math.round(w.usedPercent)}% folosit, ${resetIn(w.resetsAt)}`}>
          {w.label} · {Math.round(w.usedPercent)}%
          <div className="track">
            <div className="fill" style={{ width: `${Math.min(100, w.usedPercent)}%`, background: levelColor(w.usedPercent) }} />
          </div>
        </div>
      ))}
    </div>
  )
}

function HandoffMenu({ session, profiles }: { session: SessionMeta; profiles: Profile[] }) {
  const [open, setOpen] = useState(false)
  const { openSession, toast, loadSessions } = useStore()
  const targets = profiles.filter((p) => p.id !== session.profileId)
  if (!targets.length) return null
  return (
    <div style={{ position: 'relative' }}>
      <button className="btn small" onClick={() => setOpen(!open)} title="Continuă conversația cu alt model sau alt cont">
        Continuă în
      </button>
      {open && (
        <div className="panel" style={{ position: 'absolute', right: 0, top: 36, zIndex: 20, width: 290, padding: 6 }} onMouseLeave={() => setOpen(false)}>
          {targets.map((t) => (
            <button
              key={t.id}
              className="nav-item"
              style={{ width: '100%' }}
              onClick={async () => {
                setOpen(false)
                try {
                  const meta = await api.sessions.handoff(session.id, t.id)
                  await loadSessions()
                  await openSession(meta.id)
                  toast(`Conversația continuă în ${t.name}`)
                } catch (err) {
                  toast(errMsg(err), true)
                }
              }}
            >
              <ProfileDot profile={t} />
              <span className="ellipsis">{t.name}</span>
              <span className="count">{ENGINE_LABEL[t.engine]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------
function useStickToBottom(dep: unknown): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    let lastInput = 0
    const markInput = (): void => { lastInput = Date.now() }
    const onScroll = (): void => {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120
      if (nearBottom || Date.now() - lastInput < 500) stick.current = nearBottom
    }
    const onKey = (event: KeyboardEvent): void => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) markInput()
    }
    const follow = (): void => { if (stick.current) el.scrollTop = el.scrollHeight }
    el.addEventListener('wheel', markInput, { passive: true })
    el.addEventListener('touchmove', markInput, { passive: true })
    el.addEventListener('pointerdown', markInput)
    el.addEventListener('keydown', onKey)
    el.addEventListener('scroll', onScroll)
    const resize = new ResizeObserver(follow)
    if (el.firstElementChild) resize.observe(el.firstElementChild)
    follow()
    return () => {
      el.removeEventListener('wheel', markInput)
      el.removeEventListener('touchmove', markInput)
      el.removeEventListener('pointerdown', markInput)
      el.removeEventListener('keydown', onKey)
      el.removeEventListener('scroll', onScroll)
      resize.disconnect()
    }
  }, [])
  useLayoutEffect(() => {
    const el = ref.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [dep])
  return ref
}

export function ChatView({ session }: { session: SessionMeta }) {
  const profiles = useStore((s) => s.profiles)
  const items = useStore((s) => s.transcripts[session.id]) || EMPTY
  const status = useStore((s) => s.status[session.id])
  const perms = useStore((s) => s.permissions[session.id])
  const { toast, liveOpen, setLiveOpen, loadSessions, openSession } = useStore()
  const running = status === 'running'
  const profile = profiles.find((p) => p.id === session.profileId)
  const scrollRef = useStickToBottom(items)
  const lastReasoning = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === 'reasoning') return items[i].id
    return undefined
  }, [items])
  const who = `${profile?.name || ENGINE_LABEL[session.engine]}${session.model ? ` · ${session.model}` : ''}`

  return (
    <>
      <div className="chat-header">
        <ProfileDot profile={profile} size={8} />
        <div className="chat-title">{session.title}</div>
        <span className="meta-chip" title={session.cwd}>
          {basename(session.cwd)}
        </span>
        <span className="meta-chip">{profile?.name || 'profil șters'}</span>
        <div className="spacer" />
        <ContextMeter sessionId={session.id} running={running} />
        <MiniLimits profileId={session.profileId} />
        <HandoffMenu session={session} profiles={profiles} />
        <button className="btn ghost small icon" onClick={() => setLiveOpen(!liveOpen)} title={liveOpen ? 'Ascunde panoul Live' : 'Arată panoul Live'}>
          {liveOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
        </button>
      </div>
      <div className="messages" ref={scrollRef}>
        <div className="messages-inner">
          {items.map((it, i) => {
            const startsReply = it.kind !== 'user' && it.kind !== 'notice' && (i === 0 || items[i - 1].kind === 'user')
            return (
              <Fragment key={it.id}>
                {startsReply && (
                  <div className="turn-head">
                    <ProfileDot profile={profile} /> {who}
                  </div>
                )}
                {it.kind === 'user' && session.engine === 'claude' ? (
                  <UserTurn sessionId={session.id} itemId={it.id} disabled={running}>
                    <MessageItem item={it} live={false} />
                  </UserTurn>
                ) : (
                  <MessageItem item={it} live={running && it.id === lastReasoning} />
                )}
              </Fragment>
            )
          })}
          {running && items[items.length - 1]?.kind === 'user' && (
            <div className="turn-head">
              <span className="dot running" /> {ENGINE_LABEL[session.engine]} pornește…
            </div>
          )}
          {perms?.map((r) => (
            <PermissionCard key={r.id} req={r} onDecide={(d) => void api.sessions.respond(session.id, r.id, d)} />
          ))}
        </div>
      </div>
      <TaskStrip sessionId={session.id} />
      <Composer
        running={running}
        profiles={profiles}
        profileId={session.profileId}
        cwd={session.cwd}
        model={session.model}
        otherProfileHint="Continuă conversația în acest cont"
        onPick={(profileId, m, effort) => {
          if (profileId === session.profileId) {
            void api.sessions
              .setModel(session.id, m)
              .then(() => (effort ? api.sessions.setEffort(session.id, effort) : undefined))
              .then(loadSessions)
              .catch((e) => toast(errMsg(e), true))
            return
          }
          // another account or engine cannot join a running engine session: carry the conversation over
          const target = profiles.find((x) => x.id === profileId)
          void api.sessions
            .handoff(session.id, profileId, m, effort)
            .then(async (meta) => {
              await loadSessions()
              await openSession(meta.id)
              toast(`Conversația continuă în ${target?.name || 'alt profil'}`)
            })
            .catch((e) => toast(errMsg(e), true))
        }}
        effort={session.effort}
        onEffort={(e) => void api.sessions.setEffort(session.id, e).then(loadSessions).catch((err) => toast(errMsg(err), true))}
        mode={session.permissionMode}
        onMode={(m) => void api.sessions.setPermissionMode(session.id, m).then(loadSessions).catch((e) => toast(errMsg(e), true))}
        browser={session.browser}
        onBrowser={(on) => void api.sessions.setBrowser(session.id, on).then(loadSessions).catch((e) => toast(errMsg(e), true))}
        onStop={() => void api.sessions.interrupt(session.id)}
        onSend={async (text, atts) => {
          try {
            await api.sessions.send(session.id, text, atts)
          } catch (err) {
            toast(errMsg(err), true)
          }
        }}
      />
    </>
  )
}

// ---------------------------------------------------------------------------
// New conversation
// ---------------------------------------------------------------------------
const STARTS = [
  'Explică-mi cum e construit proiectul',
  'Găsește bug-urile și repară-le',
  'Optimizează ce e lent',
  'Scrie teste pentru partea fragilă',
  'Fă interfața mai fluidă',
  'Pregătește-l pentru lansare'
]

export function NewChat() {
  const profiles = useStore((s) => s.profiles)
  const { openSession, loadSessions, toast } = useStore()
  const [profileId, setProfileId] = useState<string>()
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState<string>()
  const [mode, setMode] = useState<PermissionMode>(DEFAULT_MODE)
  const [browser, setBrowser] = useState(false)
  const [cwd, setCwd] = useState<string>()
  const [seed, setSeed] = useState<string>()

  useEffect(() => {
    void api.app.settings().then((s) => {
      setCwd(s.lastCwd)
      setProfileId((cur) => cur || s.lastProfileId || profiles[0]?.id)
    })
  }, [profiles])

  const pickCwd = async (): Promise<void> => {
    const dir = await api.app.pickFolder()
    if (dir) {
      setCwd(dir)
      await api.app.saveSettings({ lastCwd: dir })
    }
  }
  const profile = profiles.find((p) => p.id === profileId)

  return (
    <>
      <div className="welcome">
        <h1 className="headline">
          Ce construim
          <br />
          azi<span>?</span>
        </h1>
        <div className="context">
          {cwd ? (
            <>
              În <b>{basename(cwd)}</b>, cu <b>{profile?.name || 'un profil'}</b>.
            </>
          ) : (
            'Alege întâi folderul proiectului.'
          )}
        </div>
        <div className="starts">
          {STARTS.map((s) => (
            <button key={s} className="start" onClick={() => setSeed(s + ' ')}>
              {s}
              <ArrowRight size={14} />
            </button>
          ))}
        </div>
      </div>
      <Composer
        running={false}
        profiles={profiles}
        profileId={profileId}
        model={model}
        onPick={(id, m, e) => {
          if (profiles.find((p) => p.id === id)?.engine === 'hermes') {
            if (mode === 'plan' || mode === 'auto') setMode('ask')
            setBrowser(false)
          }
          if (id !== profileId) {
            setProfileId(id)
            void api.app.saveSettings({ lastProfileId: id })
          }
          setModel(m)
          setEffort(e)
        }}
        effort={effort}
        onEffort={setEffort}
        mode={mode}
        onMode={setMode}
        browser={browser}
        onBrowser={setBrowser}
        cwd={cwd}
        onCwd={() => void pickCwd()}
        seed={seed}
        onSend={async (text, atts) => {
          if (!cwd) {
            toast('Alege întâi folderul proiectului.', true)
            await pickCwd()
            return
          }
          if (!profileId) return
          try {
            const cheap = delegatePick(text, profiles, profileId)
            if (cheap) toast(`Delegat către ${cheap.name}: sarcină mecanică`)
            const meta = await api.sessions.start({
              profileId: cheap?.id || profileId,
              cwd,
              model: cheap ? undefined : model || undefined,
              effort: cheap ? undefined : effort || undefined,
              permissionMode: mode,
              browser
            })
            await loadSessions()
            await openSession(meta.id)
            await api.sessions.send(meta.id, text, atts)
          } catch (err) {
            toast(errMsg(err), true)
          }
        }}
      />
    </>
  )
}
