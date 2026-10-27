import { ArrowRight, ArrowUp, ClipboardList, FolderOpen, GitFork, Globe, Loader2, MessageSquareDashed, Monitor, RotateCcw, Paperclip, PanelRightClose, PanelRightOpen, Power, Sparkles, Square, X } from 'lucide-react'
import { Fragment, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { assess, recommend } from '@shared/complexity'
import { secretHint } from '@shared/secrets'
import { usageRisk } from '@shared/usage-risk'
import type { AppSettings, Attachment, ChatItem, ModelOption, PermissionMode, Profile, SessionMeta } from '@shared/types'
import { hasJoltyBrowser, hasJoltyComputer, isAcp } from '@shared/types'
import { sameProvider } from '@shared/provider'
import { api, basename, compactBefore, compactFirst, ENGINE_LABEL, errMsg, levelColor, resetIn, setCompactFirst, useStore } from '../store'
import { MessageItem, PermissionCard } from './Messages'
import { useWindowedItems } from './useWindowedItems'
import { BrowserMenu, DEFAULT_MODE, modesFor, ModelPicker, ModePicker, OPEN_MODES, useAllModels, type ModelGroup } from './ModelPicker'
import { MentionMenu, useMentions } from './Mentions'
import { ToolsMenu } from './ToolsMenu'
import { PowerMenu } from './PowerMenu'
import { withQuote } from '@shared/quote'
import { ChatTools } from './ChatTools'
import { QuoteBar, SelectionPopup } from './Quote'
import { CompactStrip, LimitStrip, TaskStrip, UpdateStrip, VerificationStrip, WorkClock } from './Tasks'
import { tr } from '@shared/i18n'
import { VoiceButton } from './VoiceButton'
import { Trans } from './Trans'
import { OwnKeyStrip } from './Welcome'
import { usePresence, useSettled } from '../usePresence'
import { useShallow } from 'zustand/shallow'

const EMPTY: ChatItem[] = []

// ---------------------------------------------------------------------------
// Images: pasted, dropped or picked, downscaled so they stay light
// ---------------------------------------------------------------------------
async function toAttachment(file: File): Promise<Attachment> {
  // decode via a data: URL, not blob: + <img>: CSP img-src is 'self' data: only
  const src = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error(tr("fișierul nu a putut fi citit")))
    reader.readAsDataURL(file)
  })
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image()
    i.onload = () => resolve(i)
    i.onerror = () => reject(new Error(tr("imagine invalidă")))
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
  const [enabled, setEnabled] = useState(true)
  useEffect(() => {
    void api.app.settings().then((s) => setEnabled(s.modelAdvice !== false))
  }, [])
  const a = useMemo(() => (enabled ? assess(deferred, images) : undefined), [enabled, deferred, images])
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
          title={other ? tr("Conversația continuă în {profileName}, cu istoricul ei", { profileName: t.profileName }) : undefined}
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
const NO_PROFILES: Profile[] = []

interface ComposerProps {
  sessionId?: string
  running: boolean
  onSend: (text: string, attachments: Attachment[], parallel?: boolean) => Promise<void> | void
  onStop?: () => void
  profiles: Profile[]
  /** models already loaded by the parent; loaded here when not given */
  groups?: ModelGroup[]
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
  computer?: boolean
  onComputer: (on: boolean) => void
  /** temporary chat: chosen before the first message, shown as locked once the chat exists */
  temporary?: boolean
  onTemporary?: (on: boolean) => void
  cwd?: string
  onCwd?: () => void
  seed?: string
}

function Composer(p: ComposerProps) {
  const engine = p.profiles.find((profile) => profile.id === p.profileId)?.engine
  // what is typed stays through a switch of chat, a new chat and a restart; a temporary chat keeps it in memory only
  const draftStore = p.temporary ? sessionStorage : localStorage
  const draftKey = `jolty:draft:${p.sessionId ?? 'new'}`
  const [text, setText] = useState(() => {
    try {
      return draftStore.getItem(draftKey) || ''
    } catch { return '' }
  })
  const [atts, setAtts] = useState<Attachment[]>([])
  const [dragging, setDragging] = useState(false)
  const [improving, setImproving] = useState(false)
  const powerArmed = useStore((s) => s.power.armed)
  const [powerOpen, setPowerOpen] = useState(false)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const loaded = useAllModels(p.groups ? NO_PROFILES : p.profiles)
  const groups = p.groups || loaded
  const toast = useStore((s) => s.toast)
  const [caret, setCaret] = useState(0)
  const mentions = useMentions(text, caret, p.cwd)
  // a hint, not a block: what is typed here goes to the provider of the chosen profile, unless that profile is local
  const sendProfile = p.profiles.find((x) => x.id === p.profileId)
  const secret = sendProfile && !sendProfile.local ? secretHint(text) : undefined
  const costNote = usageRisk(text, atts.filter((a) => a.mime.startsWith('image/')).length, atts.filter((a) => a.mime.startsWith('video/')).length)
  // messages written while the model works wait here and go out, in order, when the turn ends
  // a temporary chat must not leave its queued messages on disk
  const queueStore = p.temporary ? sessionStorage : localStorage
  const [queue, setQueue] = useState<{ id: string; text: string; atts: Attachment[]; parallel?: boolean }[]>(() => {
    if (!p.sessionId) return []
    try {
      const saved = JSON.parse(queueStore.getItem(`jolty:queue:${p.sessionId}`) || '[]')
      return Array.isArray(saved) ? saved.filter((item) =>
        item && typeof item.id === 'string' && typeof item.text === 'string' && Array.isArray(item.atts)
      ) : []
    } catch { return [] }
  })
  const [restoredQueue, setRestoredQueue] = useState(() => {
    if (!queue.length || !p.sessionId) return queue.length > 0
    const immediateKey = `jolty:queue:immediate:${p.sessionId}`
    const immediate = sessionStorage.getItem(immediateKey) === '1'
    if (immediate) sessionStorage.removeItem(immediateKey)
    return !immediate
  })
  // Stop is not a cue to go on with the next message: what waited stays in the list until the user sends or removes it
  const [stoppedQueue, setStoppedQueue] = useState(false)
  const stop = (): void => {
    if (queue.length) { setRestoredQueue(true); setStoppedQueue(true) }
    p.onStop?.()
  }
  const queuedSent = useRef(false)
  const wasRunning = useRef(p.running || (queue.length > 0 && !restoredQueue))

  useEffect(() => {
    if (!p.sessionId) return
    try {
      const key = `jolty:queue:${p.sessionId}`
      if (queue.length) queueStore.setItem(key, JSON.stringify(queue))
      else queueStore.removeItem(key)
    } catch { toast(tr("Nu am putut salva coada locală."), true) }
  }, [p.sessionId, queue, queueStore, toast])

  useEffect(() => {
    if (!queue.length && restoredQueue) { setRestoredQueue(false); setStoppedQueue(false); return }
    if (p.running) { wasRunning.current = true; queuedSent.current = false; return }
    if (!wasRunning.current) return
    if (!queue.length || restoredQueue || queuedSent.current) return
    queuedSent.current = true
    const [next, ...rest] = queue
    setQueue(rest)
    void p.onSend(next.text, next.atts, next.parallel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.running, queue, restoredQueue])

  useEffect(() => {
    try {
      if (text) draftStore.setItem(draftKey, text)
      else draftStore.removeItem(draftKey)
      // the temporary switch moves the draft: it must not stay on disk
      if (p.temporary) localStorage.removeItem(draftKey)
    } catch { /* a full or blocked storage only loses the draft */ }
  }, [text, draftKey, draftStore, p.temporary])

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
      if (files.length > room) toast(tr("Maximum 8 fișiere per mesaj."), true)
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
            toast(tr("{name}: lipește un fișier sub 16 MB sau alege-l de pe disc.", { name: file.name }), true)
          }
        } catch (err) { toast(`${file.name}: ${errMsg(err)}`, true) }
      }
      setAtts((a) => [...a, ...converted].slice(0, 8))
    },
    [toast, atts.length]
  )

  // parallel: the same message, plus an instruction for the model to split the job into sessions (hidden from the chat)
  const submit = async (parallel = false): Promise<void> => {
    const own = text.trim()
    if (improving || (!own && !atts.length)) return
    if (parallel && (!own || isAcp(engine))) return
    const store = useStore.getState()
    const quote = p.sessionId ? store.quotes[p.sessionId] : undefined
    const t = own ? withQuote(quote, own) : own
    if (quote && own && p.sessionId) store.setQuote(p.sessionId, undefined)
    setText('')
    // at once, not on the next render: a new chat unmounts this box before the effect would run
    try { draftStore.removeItem(draftKey) } catch { /* nothing to remove */ }
    const a = atts
    setAtts([])
    if (p.running) {
      setQueue((q) => [...q, { id: crypto.randomUUID(), text: t, atts: a, parallel: parallel || undefined }])
      return
    }
    await p.onSend(t, a, parallel || undefined)
  }

  // the box is read-only while the model rewrites it; the result goes in as a paste over the old text, so Ctrl+Z brings the old one back
  const improve = async (): Promise<void> => {
    const ta = taRef.current
    const original = text
    if (!ta || improving || !original.trim()) return
    setImproving(true)
    try {
      const { text: better, question } = await api.sessions.improvePrompt(original, p.profileId, p.model, p.cwd, p.sessionId)
      if (!ta.isConnected || ta.value !== original) return
      if (question || !better) {
        toast(tr("Ca să îmbunătățesc mesajul, spune-mi: {question} Adaugă răspunsul în mesaj și apasă din nou.", { question: question || '' }))
        return
      }
      ta.readOnly = false
      ta.focus()
      ta.select()
      if (!document.execCommand('insertText', false, better)) setText(better)
    } catch (err) { toast(errMsg(err), true) }
    finally { setImproving(false) }
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
          <div className="queue-title">{restoredQueue ? (stoppedQueue ? tr("Oprite, trimite manual") : tr("Restaurate, trimite manual")) : tr("În așteptare")} <span>{queue.length}</span></div>
          {queue.map((q, i) => (
            <div className="queued" key={q.id}>
              <span className="queued-order">{i + 1}</span>
              <span className="queued-text" title={q.text || q.atts.map((a) => a.name).join(', ')}>{q.text || q.atts.map((a) => a.name).join(', ')}</span>
              {q.atts.length > 0 && <span className="queued-files"><Paperclip size={11} /> {q.atts.length}</span>}
              <button
                className="queued-send"
                onClick={() => {
                  setQueue((x) => x.filter((item) => item.id !== q.id))
                  void p.onSend(q.text, q.atts, q.parallel)
                }}
                aria-label={tr("Trimite acum")}
                title={tr("Trimite acum, fără să aștepți ca răspunsul curent să se termine")}
              >
                <ArrowUp size={12} />
              </button>
              <button onClick={() => setQueue((x) => x.filter((item) => item.id !== q.id))} aria-label={tr("Scoate mesajul din așteptare")} title={tr("Scoate din așteptare")}>
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
                <button onClick={() => setAtts((x) => x.filter((y) => y.id !== a.id))} aria-label={tr("Scoate {name}", { name: a.name })}>
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
        {atts.some((a) => a.mime.startsWith('image/')) && engine === 'claude' && p.profiles.find((profile) => profile.id === p.profileId)?.vision === false && <div className="attachment-note">{tr("Modelul ales nu vede imagini. Jolty va folosi încă un profil ca să le descrie, cu consum suplimentar.")}</div>}
        {mentions.open && <MentionMenu items={mentions.items} index={mentions.index} onPick={pickMention} onHover={(i) => mentions.move(i - mentions.index)} />}
        <QuoteBar sessionId={p.sessionId} />
        <textarea
          ref={taRef}
          value={text}
          readOnly={improving}
          style={improving ? { opacity: 0.55 } : undefined}
          placeholder={p.running ? tr("Scrie următorul mesaj: pleacă imediat ce termină.") : tr("Descrie ce vrei să facă. / pentru skill-uri, @ pentru fișiere.")}
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
              stop()
              return
            }
            // Shift+Tab cycles the permission mode, like Claude Code
            if (e.key === 'Tab' && e.shiftKey) {
              e.preventDefault()
              if (engine === 'gemini') return
              const modes = modesFor(engine).map((m) => m.id).filter((id) => isAcp(engine) || !OPEN_MODES.includes(id))
              const i = modes.findIndex((mode) => mode === p.mode)
              p.onMode(modes[(i + 1) % modes.length])
              return
            }
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void submit(true)
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
        {secret && (
          <div className="attachment-note" role="status">
           {tr("Mesajul pare să conțină {secret}. Nu l-am blocat, dar se trimite către {profile}. Pentru ceva sensibil, un model local nu trimite nimic în afara PC-ului.", { secret, profile: sendProfile?.name })}
          </div>
        )}
        <div className="composer-bar">
          <button className="btn ghost small icon" title={tr("Atașează imagini, videouri sau fișiere")} onClick={() => fileRef.current?.click()}>
            <Paperclip size={15} />
          </button>
          <VoiceButton
            onText={(said) => {
              // at the cursor, with a space if it lands right after a word
              const ta = taRef.current
              const at = ta?.selectionStart ?? text.length
              const before = text.slice(0, at) + (at && !/\s$/.test(text.slice(0, at)) ? ' ' : '') + said
              setText(before + text.slice(at))
              requestAnimationFrame(() => {
                ta?.focus()
                ta?.setSelectionRange(before.length, before.length)
              })
            }}
          />
          <button
            className="btn ghost small icon"
            onClick={() => void improve()}
            disabled={!text.trim() || improving}
            aria-label={tr("Îmbunătățește mesajul")}
            title={improving ? tr("Îmbunătățesc mesajul...") : tr("Îmbunătățește mesajul: un model îl rescrie mai clar, în aceeași limbă. Ctrl+Z aduce textul vechi înapoi.")}
          >
            {improving ? <Loader2 size={15} className="spin" /> : <Sparkles size={15} />}
          </button>
          <input ref={fileRef} type="file" multiple hidden onChange={(e) => { void addFiles([...(e.target.files || [])]); e.target.value = '' }} />
          {p.onCwd && (
            <button className="picker-btn cwd-btn" onClick={p.onCwd} title={p.cwd}>
              <FolderOpen size={14} strokeWidth={1.8} /> <span className="ellipsis">{p.cwd ? basename(p.cwd) : tr("Alege proiectul")}</span>
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
          {engine !== 'gemini' && <ModePicker mode={p.mode} onMode={p.onMode} engine={engine} />}
          <ToolsMenu
            tools={[
              ...(!isAcp(engine) ? [{
                id: 'plan', icon: <ClipboardList size={14} strokeWidth={1.8} />, label: 'Plan', on: p.mode === 'plan',
                title: p.mode === 'plan' ? tr("Plan activ: clic ca să revii la Build, unde editează fișiere") : tr("Comută în Plan: modelul doar cercetează și propune un plan, fără să modifice nimic"),
                onToggle: () => p.onMode(p.mode === 'plan' ? DEFAULT_MODE : 'plan')
              }] : []),
              {
                id: 'browser', icon: <Globe size={14} strokeWidth={1.8} />, label: tr("Browser"), on: Boolean(p.browser), disabled: !hasJoltyBrowser(engine),
                title: !hasJoltyBrowser(engine) ? tr("Hermes folosește uneltele proprii de browser. Conectarea la browserul Jolty nu este disponibilă.") : p.browser
                  ? tr("Jolty în browser e pornit: modelul poate folosi browserul tău (Chrome, Vivaldi, Edge, Brave), cu login-urile tale. Clic ca să-l oprești.")
                  : tr("Jolty în browser: modelul deschide pagini, dă clic, completează și citește în browserul tău. Merge cu orice model. Cere extensia Playwright (Setări)."),
                onToggle: () => p.onBrowser(!p.browser)
              },
              {
                id: 'computer', icon: <Monitor size={14} strokeWidth={1.8} />, label: tr("Computer"), on: Boolean(p.computer), disabled: !hasJoltyComputer(engine),
                title: !hasJoltyComputer(engine) ? (engine === 'gemini' ? tr("Controlul PC-ului nu este disponibil pentru Gemini.") : tr("Controlul PC-ului nu este disponibil pentru Hermes.")) : p.computer
                  ? tr("Computer e pornit: modelul vede ecranul și folosește mouse-ul și tastatura. Ctrl+Alt+Esc îl oprește oricând. Clic ca să-l oprești.")
                  : tr("Computer: modelul vede ecranul și folosește mouse-ul și tastatura ca un om, în programele pe care le aprobi. Merge cu orice model."),
                onToggle: () => p.onComputer(!p.computer)
              },
              ...(p.onTemporary || p.temporary ? [{
                id: 'temporary', icon: <MessageSquareDashed size={14} strokeWidth={1.8} />, label: tr("Temporar"), on: Boolean(p.temporary), disabled: isAcp(engine) || !p.onTemporary,
                title: isAcp(engine) ? tr("Conversația temporară nu este disponibilă pentru Hermes.") : !p.onTemporary
                  ? tr("Conversație temporară: nu apare în listă și dispare când o părăsești sau închizi Jolty.")
                  : p.temporary
                    ? tr("Conversație temporară activă: nu se salvează nimic, nici întrebările, nici răspunsurile. Clic ca s-o oprești.")
                    : tr("Conversație temporară: nu se salvează în Jolty, nu apare în listă și dispare când o părăsești sau închizi Jolty."),
                onToggle: () => p.onTemporary?.(!p.temporary)
              }] : []),
              {
                id: 'power', icon: <Power size={14} strokeWidth={1.8} />, label: tr("Oprire PC"), on: false, action: true,
                title: tr("Oprește, repornește, adoarme sau blochează PC-ul când termină lucrul sau la o oră aleasă."),
                onToggle: () => setPowerOpen(true)
              }
            ]}
            after={{ browser: !isAcp(engine) ? <BrowserMenu /> : undefined }}
          />
          {(powerArmed || powerOpen) && <PowerMenu autoOpen={powerOpen} onClosed={() => setPowerOpen(false)} />}
          <div className="spacer" />
          {p.sessionId && p.running && <WorkClock sessionId={p.sessionId} />}
          {p.running && (
            <button className="btn send-btn" onClick={stop} title={tr("Oprește (Esc)")}>
              <Square size={12} fill="currentColor" />
            </button>
          )}
          {!isAcp(engine) && text.trim() && (
            <button
              className="btn send-btn"
              onClick={() => void submit(true)}
              aria-label={tr("Trimite cu sesiuni paralele")}
              title={tr("Trimite și lucrează cu sesiuni paralele (Ctrl+Shift+Enter)")}
            >
              <GitFork size={15} />
            </button>
          )}
          {(!p.running || text.trim() || atts.length > 0) && (
            <button
              className="btn primary send-btn"
              onClick={() => void submit()}
              disabled={!text.trim() && !atts.length}
              title={p.running ? tr("Pune în așteptare (Enter)") : tr("Trimite (Enter)")}
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
          title={tr("Readuce fișierele proiectului la starea de dinainte de acest mesaj")}
          onClick={() => {
            if (!armed) return setArmed(true)
            setArmed(false)
            void api.sessions
              .rewind(sessionId, itemId)
              .then((r) => {
                setPreview(0)
                toast(tr("Am anulat modificările din {length} {v1}", { length: r.files.length, v1: r.files.length === 1 ? tr("fișier") : tr("fișiere") }))
              })
              .catch((e) => toast(errMsg(e), true))
          }}
        >
          <RotateCcw size={12} /> {armed ? tr("Sigur? Clic din nou") : tr("Anulează modificările de aici ({preview} {v1})", { preview, v1: preview === 1 ? tr("fișier") : tr("fișiere") })}
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
      title={tr("{k}{v1} tokeni în context. Clic ca să compactezi: modelul rezumă conversația și eliberează loc.", { k: k(ctx.used), v1: ctx.window ? tr(" din {k}", { k: k(ctx.window) }) : '' })}
      onClick={() => void api.sessions.compact(sessionId).then(() => toast(tr("Compactez conversația…"))).catch((e) => toast(errMsg(e), true))}
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
        <div className="mini-limit" key={w.label} title={tr("{label}: {pct}% folosit, {reset}", { label: tr(w.label), pct: Math.round(w.usedPercent), reset: resetIn(w.resetsAt) })}>
          {tr(w.label)} · {Math.round(w.usedPercent)}%
          <div className="track">
            <div className="fill" style={{ width: `${Math.min(100, w.usedPercent)}%`, background: levelColor(w.usedPercent) }} />
          </div>
        </div>
      ))}
    </div>
  )
}

/** A second opinion on the changes from the other model family, read-only. */
function ReviewButton({ session, running, items }: { session: SessionMeta; running: boolean; items: ChatItem[] }) {
  const [busy, setBusy] = useState(false)
  const toast = useStore((s) => s.toast)
  const changed = useMemo(() => items.some((i) => i.kind === 'tool' && i.diffs?.length), [items])
  if (!changed) return null
  return (
    <button
      className="btn small"
      disabled={busy || running}
      title={tr("Un model din altă familie (Codex pentru Claude sau invers) citește modificările și spune ce s-ar putea strica. Doar citire.")}
      onClick={() => {
        setBusy(true)
        void api.sessions
          .review(session.id)
          .catch((e) => toast(errMsg(e), true))
          .finally(() => setBusy(false))
      }}
    >
      {busy ? tr("Se verifică…") : tr("Verifică")}
    </button>
  )
}

function HandoffMenu({ session, profiles }: { session: SessionMeta; profiles: Profile[] }) {
  const [open, setOpen] = useState(false)
  const pop = usePresence(open)
  const [compact, setCompact] = useState(compactFirst)
  const { openSession, toast, loadSessions } = useStore(useShallow(({ openSession, toast, loadSessions }) => ({ openSession, toast, loadSessions })))
  const used = useStore((s) => s.contexts[session.id]?.used ?? 0)
  const me = profiles.find((p) => p.id === session.profileId)
  const targets = profiles.filter((p) => p.id !== session.profileId)
  if (!targets.length) return null
  const go = async (t: Profile, fresh: boolean): Promise<void> => {
    setOpen(false)
    try {
      // same chat on another account of the same provider: it reads the whole context there, so shrink it first
      if (!fresh && me && sameProvider(me, t)) await compactBefore(session.id)
      const meta = await api.sessions.handoff(session.id, t.id, undefined, undefined, fresh)
      await loadSessions()
      await openSession(meta.id)
      toast(tr("Conversația continuă în {name}", { name: t.name }))
    } catch (err) {
      toast(errMsg(err), true)
    }
  }
  return (
    <div style={{ position: 'relative' }}>
      <button className="btn small" onClick={() => setOpen(!open)} title={tr("Continuă conversația cu alt model sau alt cont")}>
       {tr("Continuă în")}
      </button>
      {pop.shown && (
        <div className="panel continue-pop" data-state={pop.state} style={{ position: 'absolute', right: 0, top: 36, zIndex: 20, width: 290, padding: 6 }} onMouseLeave={() => setOpen(false)}>
          <label className="small faint" style={{ display: 'flex', gap: 8, padding: '6px 10px 8px', cursor: 'pointer' }} title={tr("Un cont sau un model nou citește tot contextul de la zero, fără cache. Compactat, citește doar rezumatul.")}>
            <input
              type="checkbox"
              checked={compact}
              onChange={(e) => {
                setCompact(e.target.checked)
                setCompactFirst(e.target.checked)
              }}
            />
            {tr("Compactează înainte ({k}k tokeni acum)", { k: Math.round(used / 1000) })}
          </label>
          {targets.map((t) => {
            const same = Boolean(me && sameProvider(me, t))
            return (
              <Fragment key={t.id}>
                <button
                  className="nav-item"
                  style={{ width: '100%' }}
                  title={same ? tr("Același chat, pe celălalt cont. Cu bifa de sus, compactat înainte.") : tr("Chat nou cu un rezumat compact al istoricului.")}
                  onClick={() => void go(t, false)}
                >
                  <ProfileDot profile={t} />
                  <span className="ellipsis">{t.name}</span>
                  <span className="count">{same ? tr("același chat") : ENGINE_LABEL[t.engine]}</span>
                </button>
                {same && (
                  <button className="nav-item" style={{ width: '100%' }} title={tr("Chat nou cu doar un rezumat de câțiva mii de tokeni, fără compactare.")} onClick={() => void go(t, true)}>
                    <ProfileDot profile={t} />
                    <span className="ellipsis">{t.name}</span>
                    <span className="count">{tr("rezumat rapid")}</span>
                  </button>
                )}
              </Fragment>
            )
          })}
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
    let lastTop = el.scrollTop
    let held = false
    const markInput = (): void => { lastInput = Date.now() }
    const onDown = (): void => { held = true; markInput() }
    const onUp = (): void => { held = false }
    const onScroll = (): void => {
      const top = el.scrollTop
      const gap = el.scrollHeight - top - el.clientHeight
      const byUser = held || Date.now() - lastInput < 500
      // going up lets go at once, even inside the 120 px: otherwise the next resize pulls the reader back down (the rubber band)
      if (byUser && top < lastTop) stick.current = false
      else if (byUser) stick.current = gap < 120
      // not by the reader (scroll anchoring, momentum): only the very bottom follows again
      else if (top > lastTop && gap < 2) stick.current = true
      lastTop = top
    }
    const onKey = (event: KeyboardEvent): void => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) markInput()
    }
    const follow = (): void => { if (stick.current) el.scrollTop = el.scrollHeight }
    el.addEventListener('wheel', markInput, { passive: true })
    el.addEventListener('touchmove', markInput, { passive: true })
    el.addEventListener('pointerdown', onDown)
    window.addEventListener('pointerup', onUp)
    el.addEventListener('keydown', onKey)
    el.addEventListener('scroll', onScroll)
    const resize = new ResizeObserver(follow)
    if (el.firstElementChild) resize.observe(el.firstElementChild)
    follow()
    return () => {
      el.removeEventListener('wheel', markInput)
      el.removeEventListener('touchmove', markInput)
      el.removeEventListener('pointerdown', onDown)
      window.removeEventListener('pointerup', onUp)
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
  const { toast, liveOpen, setLiveOpen, loadSessions, openSession } = useStore(useShallow(({ toast, liveOpen, setLiveOpen, loadSessions, openSession }) => ({ toast, liveOpen, setLiveOpen, loadSessions, openSession })))
  const running = status === 'running'
  const profile = profiles.find((p) => p.id === session.profileId)
  const scrollRef = useStickToBottom(items)
  // a chat created moments ago has no history to wait for; an old one is settled once its transcript is in
  const loaded = useStore((s) => s.transcripts[session.id] !== undefined) || Date.now() - session.createdAt < 10_000
  const settled = useSettled(loaded)
  const { start, older } = useWindowedItems(items.length, scrollRef)
  const lastReasoning = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === 'reasoning') return items[i].id
    return undefined
  }, [items])
  const how = tr("{v0} · efort {v1}", { v0: session.model || tr("model implicit"), v1: session.effort || tr("implicit") })
  const who = `${profile?.name || ENGINE_LABEL[session.engine]} · ${how}`

  return (
    <>
      <div className="chat-header">
        <ProfileDot profile={profile} size={8} />
        <div className="chat-title">{session.title}</div>
        <span className="meta-chip" title={session.cwd}>
          {basename(session.cwd)}
        </span>
        <span className="meta-chip" title={profile?.name}>{profile?.name || tr("profil șters")}</span>
        <div className="spacer" />
        <ContextMeter sessionId={session.id} running={running} />
        <MiniLimits profileId={session.profileId} />
        <ReviewButton session={session} running={running} items={items} />
        <HandoffMenu session={session} profiles={profiles} />
        <button className="btn ghost small icon" onClick={() => setLiveOpen(!liveOpen)} title={liveOpen ? tr("Închide panoul Live") : tr("Arată panoul Live")}>
          {liveOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
        </button>
      </div>
      <div className="messages" ref={scrollRef}>
        <div className="messages-inner" data-live={settled ? '' : undefined}>
          {start > 0 && (
            <div ref={older} className="older-marker">
              {tr("Se încarcă mesajele mai vechi ({n})", { n: start })}
            </div>
          )}
          {items.slice(start).map((it, j) => {
            const i = start + j
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
                  <MessageItem item={it} live={running && it.id === lastReasoning && i === items.length - 1} streaming={running && i === items.length - 1} />
                )}
              </Fragment>
            )
          })}
          {running && items[items.length - 1]?.kind === 'user' && (
            <div className="turn-head">
              <span className="dot running" /> {tr("Jolty pornește ·")} {how}
            </div>
          )}
          {perms?.map((r) => (
            <PermissionCard key={r.id} req={r} onDecide={(d) => void api.sessions.respond(session.id, r.id, d)} />
          ))}
        </div>
      </div>
      <SelectionPopup root={scrollRef} />
      <ChatTools />
      <UpdateStrip />
      <LimitStrip session={session} />
      <CompactStrip sessionId={session.id} />
      <TaskStrip sessionId={session.id} />
      <VerificationStrip session={session} />
      <Composer
        sessionId={session.id}
        running={running}
        profiles={profiles}
        profileId={session.profileId}
        cwd={session.cwd}
        model={session.model}
        otherProfileHint={tr("Continuă conversația în acest cont")}
        seed={session.handoffPending ? tr("Continuă de unde ai rămas.") : undefined}
        onPick={(profileId, m, effort) => {
          if (profileId === session.profileId) {
            // a new model has no cache of this conversation: compact first, unless only the effort changes
            void (m !== session.model ? compactBefore(session.id) : Promise.resolve())
              .then(() => api.sessions.setModel(session.id, m))
              .then(() => (effort ? api.sessions.setEffort(session.id, effort) : undefined))
              .then(loadSessions)
              .catch((e) => toast(errMsg(e), true))
            return
          }
          // another account or engine cannot join a running engine session: carry the conversation over
          const target = profiles.find((x) => x.id === profileId)
          const from = profiles.find((x) => x.id === session.profileId)
          void (from && target && sameProvider(from, target) ? compactBefore(session.id) : Promise.resolve())
            .then(() => api.sessions.handoff(session.id, profileId, m, effort))
            .then(async (meta) => {
              await loadSessions()
              await openSession(meta.id)
              toast(tr("Conversația continuă în {v0}", { v0: target?.name || tr("alt profil") }))
            })
            .catch((e) => toast(errMsg(e), true))
        }}
        effort={session.effort}
        onEffort={(e) => void api.sessions.setEffort(session.id, e).then(loadSessions).catch((err) => toast(errMsg(err), true))}
        mode={session.permissionMode}
        onMode={(m) => void api.sessions.setPermissionMode(session.id, m).then(loadSessions).catch((e) => toast(errMsg(e), true))}
        browser={session.browser}
        computer={session.computer}
        onComputer={(on) => void api.sessions.setComputer(session.id, on).then(loadSessions).catch((e) => toast(errMsg(e), true))}
        temporary={session.temporary}
        onBrowser={(on) => void api.sessions.setBrowser(session.id, on).then(loadSessions).catch((e) => toast(errMsg(e), true))}
        onStop={() => {
          // the chat shows "stopped" now; the engine winds down in its own time and the main process drops what it still says
          useStore.getState().onEvent({ type: 'status', sessionId: session.id, status: 'idle' })
          void api.sessions.interrupt(session.id).catch((err) => toast(errMsg(err), true))
        }}
        onSend={async (text, atts, parallel) => {
          useStore.getState().onEvent({ type: 'status', sessionId: session.id, status: 'running' })
          try {
            await api.sessions.send(session.id, text, atts, parallel)
          } catch (err) {
            useStore.getState().onEvent({ type: 'status', sessionId: session.id, status: 'error', error: errMsg(err) })
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
  tr("Explică-mi cum e construit proiectul"),
  tr("Găsește bug-urile și repară-le"),
  tr("Optimizează ce e lent"),
  tr("Scrie teste pentru partea fragilă"),
  tr("Fă interfața mai fluidă"),
  tr("Pregătește-l pentru lansare")
]

export function NewChat() {
  const profiles = useStore((s) => s.profiles)
  const { loadSessions, toast } = useStore(useShallow(({ loadSessions, toast }) => ({ loadSessions, toast })))
  const [profileId, setProfileId] = useState<string>()
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState<string>()
  const [mode, setMode] = useState<PermissionMode>(DEFAULT_MODE)
  const [browser, setBrowser] = useState(false)
  const [computer, setComputer] = useState(false)
  const [temporary, setTemporary] = useState(false)
  const [cwd, setCwd] = useState<string>()
  const [seed, setSeed] = useState<string>()
  const groups = useAllModels(profiles)
  const [lastModels, setLastModels] = useState<AppSettings['lastModels']>()
  // the profile whose last model and level were already put in the picker (or that the user picked by hand)
  const restored = useRef<string | undefined>(undefined)
  const launching = useRef(false)
  const launchQueue = useRef<{ id: string; text: string; atts: Attachment[]; parallel?: boolean }[]>([])

  useEffect(() => {
    void api.app.settings().then((s) => {
      setCwd(s.lastCwd)
      setLastModels(s.lastModels)
      setProfileId((cur) => cur || s.lastProfileId || profiles[0]?.id)
    })
  }, [profiles])

  // a new chat opens on what this profile used last, not on the default
  useEffect(() => {
    const g = groups.find((x) => x.profile.id === profileId)
    if (!profileId || !g || g.loading || !lastModels || restored.current === profileId) return
    restored.current = profileId
    const last = lastModels[profileId]
    const m = last && g.models.find((x) => x.id === last.model)
    if (!m) return
    setModel(m.id)
    setEffort(last.effort && m.efforts?.includes(last.effort) ? last.effort : undefined)
  }, [groups, profileId, lastModels])

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
         {tr("Ce construim")}
          <br />
         {tr("azi")}<span>?</span>
        </h1>
        <div className="context">
          {cwd ? (
            <>
             <Trans text={tr("În {folder}, cu {profile}.")} values={{ folder: <b>{basename(cwd)}</b>, profile: <b>{profile?.name || tr("un profil")}</b> }} />
            </>
          ) : (
            tr("Alege întâi folderul proiectului.")
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
      <UpdateStrip />
      <OwnKeyStrip />
      <Composer
        running={false}
        profiles={profiles}
        groups={groups}
        profileId={profileId}
        model={model}
        onPick={(id, m, e) => {
          restored.current = id
          const picked = profiles.find((p) => p.id === id)?.engine
          if (isAcp(picked)) {
            if (mode === 'auto' || (mode === 'plan' && picked === 'hermes')) setMode('ask')
            if (!hasJoltyBrowser(picked)) setBrowser(false)
            if (!hasJoltyComputer(picked)) setComputer(false)
            setTemporary(false)
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
        computer={computer}
        onComputer={setComputer}
        temporary={temporary}
        onTemporary={setTemporary}
        cwd={cwd}
        onCwd={() => void pickCwd()}
        seed={seed}
        onSend={async (text, atts, parallel) => {
          if (launching.current) {
            launchQueue.current.push({ id: crypto.randomUUID(), text, atts, parallel })
            toast(tr("Mesajul a intrat în așteptare până pornește conversația."))
            return
          }
          if (!cwd) {
            toast(tr("Alege întâi folderul proiectului."), true)
            await pickCwd()
            return
          }
          if (!profileId) return
          launching.current = true
          let meta: SessionMeta | undefined
          try {
            meta = await api.sessions.start({
              profileId,
              cwd,
              model: model || undefined,
              effort: effort || undefined,
              permissionMode: mode,
              browser,
              computer: computer || undefined,
              temporary: temporary || undefined
            })
            const queued = launchQueue.current.splice(0)
            if (queued.length) {
              try {
                ;(temporary ? sessionStorage : localStorage).setItem(`jolty:queue:${meta.id}`, JSON.stringify(queued))
                sessionStorage.setItem(`jolty:queue:immediate:${meta.id}`, '1')
              } catch {
                toast(tr("Nu am putut salva mesajele puse în așteptare."), true)
              }
            }
            useStore.getState().activateSession(meta)
            void loadSessions().catch((err) => toast(errMsg(err), true))
            await api.sessions.send(meta.id, text, atts, parallel)
          } catch (err) {
            if (meta) useStore.getState().onEvent({ type: 'status', sessionId: meta.id, status: 'error', error: errMsg(err) })
            toast(errMsg(err), true)
          } finally {
            launching.current = false
            launchQueue.current = []
          }
        }}
      />
    </>
  )
}
