import { ArrowUp, Loader2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Profile } from '@shared/types'
import { tr } from '@shared/i18n'
import { api, basename, errMsg, useStore } from '../store'
import { VoiceButton } from './VoiceButton'
import './quick.css'

/** The quick entry box (main/quick.ts): type or dictate, Enter starts a new chat, Esc puts it away. */
export function QuickEntry() {
  const [text, setText] = useState('')
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [projects, setProjects] = useState<string[]>([])
  const [profileId, setProfileId] = useState('')
  const [cwd, setCwd] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const toast = useStore((s) => s.toasts.at(-1))
  const ta = useRef<HTMLTextAreaElement>(null)

  // every time it opens: the accounts and projects as they are now, last used ones picked
  const load = useCallback(async () => {
    const [list, sessions, s] = await Promise.all([api.profiles.list(), api.sessions.list(), api.app.settings()])
    const dirs = [...new Set([s.lastCwd, ...[...sessions].sort((a, b) => b.updatedAt - a.updatedAt).map((x) => x.cwd)].filter((d): d is string => Boolean(d)))].slice(0, 12)
    setProfiles(list)
    setProjects(dirs)
    setProfileId((cur) => (list.some((p) => p.id === cur) ? cur : list.find((p) => p.id === s.lastProfileId)?.id || list[0]?.id || ''))
    setCwd((cur) => (dirs.includes(cur) ? cur : dirs[0] || ''))
  }, [])

  useEffect(() => {
    document.documentElement.classList.add('quick')
    void load()
    const off = api.background.onQuickShown(() => {
      setError('')
      void load()
      requestAnimationFrame(() => ta.current?.focus())
    })
    ta.current?.focus()
    return off
  }, [load])

  const submit = async (): Promise<void> => {
    if (!text.trim() || sending) return
    if (!profileId) return setError(tr("Adaugă întâi un cont în Jolty."))
    if (!cwd) return setError(tr("Deschide Jolty și alege întâi folderul proiectului."))
    setSending(true)
    setError('')
    try {
      await api.background.quickSubmit({ text, profileId, cwd })
      setText('')
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setSending(false)
    }
  }

  return (
    <div
      className="quick-box"
      onKeyDown={(e) => {
        // Esc while dictating only drops the recording (VoiceButton)
        if (e.key === 'Escape' && !document.querySelector('.voice.rec')) void api.background.quickClose()
      }}
    >
      <div className="quick-head">
        <svg className="bolt" width={5} height={16} viewBox="0 0 205 740" aria-hidden>
          <polygon points="52,0 170,0 118,300 205,284 56,740 84,408 0,426" />
        </svg>
        <select className="quick-pick" value={profileId} onChange={(e) => setProfileId(e.target.value)} aria-label={tr("Profil")}>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select className="quick-pick" value={cwd} onChange={(e) => setCwd(e.target.value)} aria-label={tr("Proiect")} title={cwd}>
          {projects.map((d) => (
            <option key={d} value={d}>
              {basename(d)}
            </option>
          ))}
        </select>
        <span className="quick-keys">{tr("Enter trimite · Esc închide")}</span>
      </div>
      <textarea
        ref={ta}
        value={text}
        rows={2}
        placeholder={tr("Ce construim azi?")}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            void submit()
          }
        }}
      />
      <div className="quick-bar">
        <VoiceButton onText={(said) => setText((t) => (t && !/\s$/.test(t) ? `${t} ${said}` : t + said))} />
        <span className={`quick-note ${error || toast?.error ? 'error' : ''}`} role="status">
          {error || toast?.text}
        </span>
        <button className="btn primary send-btn" onClick={() => void submit()} disabled={!text.trim() || sending} title={tr("Conversație nouă (Enter)")} aria-label={tr("Conversație nouă")}>
          {sending ? <Loader2 size={15} className="spin" /> : <ArrowUp size={17} />}
        </button>
      </div>
    </div>
  )
}
