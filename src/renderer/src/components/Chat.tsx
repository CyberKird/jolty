import { ArrowRight, ArrowUp, FolderOpen, ImagePlus, PanelRightClose, PanelRightOpen, Square, X } from 'lucide-react'
import { Fragment, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { assess, sameModel, suggest } from '@shared/complexity'
import type { Attachment, ChatItem, ModelOption, PermissionMode, Profile, SessionMeta } from '@shared/types'
import { api, basename, ENGINE_LABEL, errMsg, levelColor, resetIn, useStore } from '../store'
import { MessageItem, PermissionCard } from './Messages'

const EMPTY: ChatItem[] = []

const MODES: { id: PermissionMode; label: string; title: string }[] = [
  { id: 'ask', label: 'Întreabă', title: 'Cere voie înainte de modificări și comenzi' },
  { id: 'autoEdit', label: 'Editează', title: 'Modifică fișiere fără să întrebe; cere voie pentru comenzi' },
  { id: 'plan', label: 'Plan', title: 'Doar citește și propune un plan' },
  { id: 'full', label: 'Total', title: 'Fără aprobări (doar în proiecte în care ai încredere)' }
]

const EFFORT_TITLES: Record<string, string> = {
  low: 'Răspunsuri rapide, gândire minimă',
  medium: 'Gândire moderată',
  high: 'Gândire în profunzime',
  xhigh: 'Mai adânc decât high: cel mai bun pentru cod și sarcini lungi',
  max: 'Efort maxim: cel mai lent și cel mai scump'
}

// ---------------------------------------------------------------------------
// Images: pasted, dropped or picked, downscaled so they stay light
// ---------------------------------------------------------------------------
async function toAttachment(file: File): Promise<Attachment> {
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image()
      i.onload = () => resolve(i)
      i.onerror = reject
      i.src = url
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
  } finally {
    URL.revokeObjectURL(url)
  }
}

function useModels(profileId?: string): { models: ModelOption[]; loading: boolean } {
  const [state, setState] = useState<{ models: ModelOption[]; loading: boolean }>({ models: [], loading: false })
  useEffect(() => {
    if (!profileId) return
    let alive = true
    setState({ models: [], loading: true })
    api.profiles
      .models(profileId)
      .then((models) => alive && setState({ models, loading: false }))
      .catch(() => alive && setState({ models: [], loading: false }))
    return () => {
      alive = false
    }
  }, [profileId])
  return state
}

export function ProfileDot({ profile, size = 7 }: { profile?: Profile; size?: number }) {
  return <span className="dot" style={{ width: size, height: size, background: profile?.color || 'var(--grey-2)' }} />
}

// ---------------------------------------------------------------------------
// Suggestion strip: task complexity -> model and effort
// ---------------------------------------------------------------------------
function Advice({ text, images, profile, models, model, effort, onApply }: {
  text: string
  images: number
  profile?: Profile
  models: ModelOption[]
  model?: string
  effort?: string
  onApply: (model: string | undefined, effort: string | undefined) => void
}) {
  const deferred = useDeferredValue(text)
  const a = useMemo(() => assess(deferred, images), [deferred, images])
  if (!a) return null
  const s = suggest(a, profile, models)
  const currentModel = models.find((m) => m.id === model) || models.find((m) => m.isDefault)
  const modelOk = !s.model || sameModel(s.model, currentModel)
  const effortOk = !s.effort || s.effort === (effort || currentModel?.defaultEffort)
  const fits = modelOk && effortOk
  return (
    <div className="advice" aria-live="polite">
      <span className="advice-level" title={a.reasons.join(' · ')}>
        {[1, 2, 3, 4].map((n) => (
          <i key={n} className={n <= a.level ? (n === a.level ? 'on' : 'fill') : ''} />
        ))}
      </span>
      <span className="advice-label">{a.label}</span>
      {a.reasons.length > 0 && <span className="advice-why">{a.reasons.join(' · ')}</span>}
      <span className="spacer" />
      {s.note ? (
        <span className="advice-note">{s.note}</span>
      ) : fits ? (
        <span className="advice-ok">Potrivit</span>
      ) : (
        <button className="advice-apply" onClick={() => onApply(modelOk ? undefined : s.model?.id, effortOk ? undefined : s.effort)}>
          {!modelOk && s.model ? s.model.label : currentModel?.label}
          {s.effort ? ` · ${s.effort}` : ''}
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
  onProfile?: (id: string) => void
  profileLocked?: boolean
  model?: string
  onModel: (m: string) => void
  effort?: string
  onEffort: (e: string) => void
  mode: PermissionMode
  onMode: (m: PermissionMode) => void
  cwd?: string
  onCwd?: () => void
  seed?: string
}

function Composer(p: ComposerProps) {
  const [text, setText] = useState('')
  const [atts, setAtts] = useState<Attachment[]>([])
  const [dragging, setDragging] = useState(false)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const { models, loading } = useModels(p.profileId)
  const toast = useStore((s) => s.toast)
  const profile = p.profiles.find((x) => x.id === p.profileId)
  const current = models.find((m) => m.id === p.model) || models.find((m) => m.isDefault)
  const efforts = current?.efforts || []

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
      const imgs = files.filter((f) => f.type.startsWith('image/'))
      if (files.length && !imgs.length) toast('Deocamdată se pot atașa doar imagini.', true)
      const converted = await Promise.all(imgs.map(toAttachment))
      setAtts((a) => [...a, ...converted].slice(0, 8))
    },
    [toast]
  )

  const submit = async (): Promise<void> => {
    const t = text.trim()
    if ((!t && !atts.length) || p.running) return
    setText('')
    const a = atts
    setAtts([])
    await p.onSend(t, a)
  }

  return (
    <div className="composer-wrap">
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
      >
        {atts.length > 0 && (
          <div className="attachments">
            {atts.map((a) => (
              <div className="attachment" key={a.id} title={a.name}>
                <img src={`data:${a.mime};base64,${a.data}`} alt={a.name} />
                <button onClick={() => setAtts((x) => x.filter((y) => y.id !== a.id))} aria-label="Scoate imaginea">
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={taRef}
          value={text}
          placeholder="Descrie ce vrei să facă. Poți lipi sau trage imagini."
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const files = [...e.clipboardData.files]
            if (files.some((f) => f.type.startsWith('image/'))) {
              e.preventDefault()
              void addFiles(files)
            }
          }}
          onKeyDown={(e) => {
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
          profile={profile}
          models={models}
          model={p.model}
          effort={p.effort}
          onApply={(m, e) => {
            if (m) p.onModel(m)
            if (e) p.onEffort(e)
          }}
        />
        <div className="composer-bar">
          <button className="btn ghost small icon" title="Atașează imagini" onClick={() => fileRef.current?.click()}>
            <ImagePlus size={15} />
          </button>
          <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => void addFiles([...(e.target.files || [])])} />
          {p.onCwd && (
            <button className="pill-select" style={{ paddingRight: 10, cursor: 'pointer', background: 'transparent' }} onClick={p.onCwd} title={p.cwd}>
              <FolderOpen size={13} /> <span style={{ color: 'var(--white)' }}>{p.cwd ? basename(p.cwd) : 'Alege proiectul'}</span>
            </button>
          )}
          <div className="pill-select" title="Profil">
            <ProfileDot profile={profile} />
            <select value={p.profileId} disabled={p.profileLocked} onChange={(e) => p.onProfile?.(e.target.value)} aria-label="Profil">
              {p.profiles.map((pr) => (
                <option key={pr.id} value={pr.id}>
                  {pr.name}
                </option>
              ))}
            </select>
          </div>
          <div className="pill-select" title={current?.description || 'Model'}>
            <select value={p.model || ''} onChange={(e) => p.onModel(e.target.value)} aria-label="Model">
              <option value="">{loading ? 'Se încarcă…' : 'Model implicit'}</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                  {m.vision === false ? ' · fără imagini' : ''}
                </option>
              ))}
            </select>
          </div>
          {efforts.length > 0 && (
            <div className="segmented" role="radiogroup" aria-label="Efort">
              {/* a model without a declared default (Claude) runs its own default when nothing is picked */}
              {!current?.defaultEffort && (
                <button className={!p.effort ? 'on' : ''} title="Efortul implicit al modelului" onClick={() => p.onEffort('')}>
                  auto
                </button>
              )}
              {efforts.map((e) => (
                <button key={e} className={(p.effort || current?.defaultEffort) === e ? 'on' : ''} title={EFFORT_TITLES[e] || e} onClick={() => p.onEffort(e)}>
                  {e}
                </button>
              ))}
            </div>
          )}
          <div className="segmented" role="radiogroup" aria-label="Permisiuni">
            {MODES.map((m) => (
              <button key={m.id} className={p.mode === m.id ? 'on' : ''} title={m.title} onClick={() => p.onMode(m.id)}>
                {m.label}
              </button>
            ))}
          </div>
          <div className="spacer" />
          {p.running ? (
            <button className="btn send-btn" onClick={p.onStop} title="Oprește">
              <Square size={12} fill="currentColor" />
            </button>
          ) : (
            <button className="btn primary send-btn" onClick={() => void submit()} disabled={!text.trim() && !atts.length} title="Trimite (Enter)">
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
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = (): void => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    }
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
  }, [])
  useEffect(() => {
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
  const { toast, liveOpen, setLiveOpen, loadSessions } = useStore()
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
                <MessageItem item={it} live={running && it.id === lastReasoning} />
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
      <Composer
        running={running}
        profiles={profiles}
        profileId={session.profileId}
        profileLocked
        model={session.model}
        onModel={(m) => void api.sessions.setModel(session.id, m).then(loadSessions).catch((e) => toast(errMsg(e), true))}
        effort={session.effort}
        onEffort={(e) => void api.sessions.setEffort(session.id, e).then(loadSessions).catch((err) => toast(errMsg(err), true))}
        mode={session.permissionMode}
        onMode={(m) => void api.sessions.setPermissionMode(session.id, m).then(loadSessions)}
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
  const [mode, setMode] = useState<PermissionMode>('ask')
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
        onProfile={(id) => {
          setProfileId(id)
          setModel('')
          setEffort(undefined)
          void api.app.saveSettings({ lastProfileId: id })
        }}
        model={model}
        onModel={(m) => {
          setModel(m)
          setEffort(undefined)
        }}
        effort={effort}
        onEffort={setEffort}
        mode={mode}
        onMode={setMode}
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
            const meta = await api.sessions.start({ profileId, cwd, model: model || undefined, effort: effort || undefined, permissionMode: mode })
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
