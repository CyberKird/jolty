import { CalendarClock, FolderOpen, MessageSquare, Pencil, Play, Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AppSettings, Profile } from '@shared/types'
import { MIN_EVERY_MINUTES, nextRun, TASK_MODES, type ScheduledTask, type TaskInput, type TaskSchedule } from '@shared/schedule'
import { ProfileDot } from '../components/Chat'
import { modesFor } from '../components/ModelPicker'
import { api, basename, errMsg, useStore } from '../store'
import { dateLocale, tr } from '@shared/i18n'

const when = (t: number): string => new Date(t).toLocaleString(dateLocale(), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

/** Weekday names in the interface language, Sunday first (the same numbering as Date.getDay). */
const weekdays = (): string[] => [...Array(7)].map((_, d) => new Date(2026, 0, 4 + d).toLocaleDateString(dateLocale(), { weekday: 'short' }))

export function describeSchedule(s: TaskSchedule): string {
  if (s.kind === 'once') return tr("O dată, {when}", { when: when(s.at) })
  if (s.kind === 'every') return tr("La fiecare {n} min", { n: s.minutes })
  if (!s.days?.length) return tr("Zilnic la {time}", { time: s.time })
  const names = weekdays()
  return tr("{days}, la {time}", { days: s.days.map((d) => names[d]).join(', '), time: s.time })
}

/** "2026-10-20T09:00" for an <input type="datetime-local">, in local time. */
function localInput(t: number): string {
  const d = new Date(t)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

export function SchedulesPage() {
  const { profiles, toast, openSession, loadSessions } = useStore()
  const [tasks, setTasks] = useState<ScheduledTask[]>()
  const [editing, setEditing] = useState<ScheduledTask | 'new'>()
  const [settings, setSettings] = useState<AppSettings>()

  useEffect(() => {
    const load = (): void => void api.schedules.list().then(setTasks)
    load()
    void api.app.settings().then(setSettings)
    return api.sessions.onEvent((e) => e.type === 'schedules' && load())
  }, [])

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn()
    } catch (err) {
      toast(errMsg(err), true)
    }
  }

  const open = async (sessionId: string): Promise<void> => {
    await loadSessions()
    await openSession(sessionId)
  }

  if (!tasks || !settings) return null
  return (
    <div className="page">
      <div className="page-inner narrow">
        <h1 className="page-title">{tr("Programate")}</h1>
        <p className="lead">
          {tr("Mesaje pe care Jolty le trimite singur, la o oră sau din când în când. Fiecare rulare e o conversație nouă, apare în listă și te anunță când e gata. Rulează doar cât Jolty e deschis; o rulare pierdută cât era închis pornește o dată la următoarea deschidere. Poți cere și în chat: „în fiecare dimineață la 9 verifică…”.")}
        </p>
        {editing ? (
          <TaskForm
            task={editing === 'new' ? undefined : editing}
            profiles={profiles}
            settings={settings}
            onCancel={() => setEditing(undefined)}
            onSave={(input) =>
              act(async () => {
                if (editing === 'new') await api.schedules.add(input)
                else await api.schedules.update(editing.id, input)
                setEditing(undefined)
                toast(tr("Sarcina e salvată"))
              })
            }
          />
        ) : (
          <button className="btn primary" style={{ marginBottom: 16 }} onClick={() => setEditing('new')}>
            <Plus size={14} /> {tr("Sarcină nouă")}
          </button>
        )}
        {!tasks.length && !editing && (
          <div className="card empty">
            <CalendarClock size={18} />
            <div>{tr("Nicio sarcină programată încă.")}</div>
          </div>
        )}
        {tasks.map((t) => {
          const profile = profiles.find((p) => p.id === t.profileId)
          const next = nextRun(t)
          const mode = modesFor(profile?.engine).find((m) => m.id === t.permissionMode)
          return (
            <div className="card" key={t.id} style={{ marginBottom: 12 }}>
              <div className="row" style={{ marginBottom: 8 }}>
                <ProfileDot profile={profile} size={10} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }} className="ellipsis">
                    {t.name}
                  </div>
                  <div className="faint small">
                    {describeSchedule(t.schedule)} · {profile?.name || tr("profil șters")} · {basename(t.cwd)}
                    {mode ? ` · ${mode.label}` : ''}
                  </div>
                </div>
                <div className="spacer" />
                <label className="row small" style={{ gap: 6, cursor: 'pointer' }} title={t.enabled ? tr("Oprește sarcina") : tr("Pornește sarcina")}>
                  <input type="checkbox" checked={t.enabled} onChange={(e) => void act(() => api.schedules.update(t.id, { enabled: e.target.checked }))} />
                  {t.enabled ? tr("pornită") : tr("oprită")}
                </label>
              </div>
              <div className="muted small ellipsis" title={t.prompt}>
                {t.prompt}
              </div>
              <div className="faint small" style={{ marginTop: 6 }}>
                {next !== undefined ? tr("Următoarea rulare: {when}", { when: next <= Date.now() ? tr("în următorul minut") : when(next) }) : tr("Nu mai are rulări programate.")}
                {t.lastRunAt ? ` · ${tr("Ultima: {when}", { when: when(t.lastRunAt) })}` : ''}
              </div>
              {t.lastError && (
                <div className="small" style={{ color: 'var(--warning)', marginTop: 6 }}>
                  {tr("Ultima rulare nu a pornit: {error}", { error: t.lastError })}
                </div>
              )}
              <div className="row wrap" style={{ marginTop: 12 }}>
                <button className="btn small" onClick={() => void act(async () => open(await api.schedules.run(t.id)))}>
                  <Play size={14} /> {tr("Rulează acum")}
                </button>
                {t.lastSessionId && (
                  <button className="btn small" onClick={() => void act(() => open(t.lastSessionId!))}>
                    <MessageSquare size={14} /> {tr("Ultima rulare")}
                  </button>
                )}
                <div className="spacer" />
                <button className="btn ghost small icon" title={tr("Editează sarcina")} onClick={() => setEditing(t)}>
                  <Pencil size={14} />
                </button>
                <button
                  className="btn ghost small icon danger"
                  title={tr("Șterge sarcina")}
                  onClick={() => {
                    if (confirm(tr("Ștergi sarcina „{name}”? Conversațiile rulărilor de până acum rămân.", { name: t.name }))) void act(() => api.schedules.remove(t.id))
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function TaskForm({ task, profiles, settings, onSave, onCancel }: { task?: ScheduledTask; profiles: Profile[]; settings: AppSettings; onSave: (t: TaskInput) => Promise<void>; onCancel: () => void }) {
  const firstProfile = profiles.find((p) => p.id === settings.lastProfileId) || profiles[0]
  const [name, setName] = useState(task?.name || '')
  const [prompt, setPrompt] = useState(task?.prompt || '')
  const [profileId, setProfileId] = useState(task?.profileId || firstProfile?.id || '')
  const [cwd, setCwd] = useState(task?.cwd || settings.lastCwd || '')
  const [kind, setKind] = useState<TaskSchedule['kind']>(task?.schedule.kind || 'daily')
  const s = task?.schedule
  const [at, setAt] = useState(localInput(s?.kind === 'once' ? s.at : Date.now() + 3600e3))
  const [minutes, setMinutes] = useState(s?.kind === 'every' ? s.minutes : 60)
  const [time, setTime] = useState(s?.kind === 'daily' ? s.time : '09:00')
  const [days, setDays] = useState<number[]>(s?.kind === 'daily' ? s.days || [] : [])
  const engine = profiles.find((p) => p.id === profileId)?.engine
  const modes = modesFor(engine).filter((m) => TASK_MODES.includes(m.id))
  const [mode, setMode] = useState(task?.permissionMode || 'autoEdit')
  const [busy, setBusy] = useState(false)
  const names = weekdays()
  // Monday first on screen, the usual week in most of the languages Jolty speaks
  const order = [1, 2, 3, 4, 5, 6, 0]

  const save = async (): Promise<void> => {
    const schedule: TaskSchedule = kind === 'once' ? { kind, at: Date.parse(at) } : kind === 'every' ? { kind, minutes } : { kind, time, days }
    // the model a new chat on this profile would start with; an edited task keeps its own
    const last = settings.lastModels?.[profileId]
    const sameProfile = task?.profileId === profileId
    setBusy(true)
    try {
      await onSave({
        name,
        prompt,
        profileId,
        cwd,
        permissionMode: modes.some((m) => m.id === mode) ? mode : 'autoEdit',
        schedule,
        model: sameProfile ? task?.model : last?.model,
        effort: sameProfile ? task?.effort : last?.effort
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="field">
        <label>{tr("Nume")}</label>
        <input className="input" value={name} maxLength={80} placeholder={tr("de exemplu: Raport de dimineață")} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label>{tr("Mesajul pentru model")}</label>
        <textarea className="textarea" rows={5} value={prompt} placeholder={tr("Scrie-l complet: rularea nu vede alte conversații.")} onChange={(e) => setPrompt(e.target.value)} />
      </div>
      <div className="field">
        <label>{tr("Cont")}</label>
        <select className="select" value={profileId} onChange={(e) => setProfileId(e.target.value)}>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>{tr("Folderul proiectului")}</label>
        <div className="row">
          <input className="input mono" value={cwd} onChange={(e) => setCwd(e.target.value)} />
          <button className="btn small" onClick={async () => setCwd((await api.app.pickFolder()) || cwd)}>
            <FolderOpen size={14} /> {tr("Alege")}
          </button>
        </div>
      </div>
      <div className="field">
        <label>{tr("Când")}</label>
        <div className="segmented" role="radiogroup" aria-label={tr("Când")}>
          {(['once', 'every', 'daily'] as const).map((k) => (
            <button key={k} role="radio" aria-checked={kind === k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
              {k === 'once' ? tr("O dată") : k === 'every' ? tr("Repetat") : tr("Zilnic")}
            </button>
          ))}
        </div>
      </div>
      {kind === 'once' && (
        <div className="field">
          <input className="input" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
        </div>
      )}
      {kind === 'every' && (
        <div className="field">
          <label>{tr("La fiecare (minute)")}</label>
          <input className="input" type="number" min={MIN_EVERY_MINUTES} step={5} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} />
          <span className="hint">{tr("Minimum {n} minute, ca să nu consume abonamentul degeaba.", { n: MIN_EVERY_MINUTES })}</span>
        </div>
      )}
      {kind === 'daily' && (
        <div className="field">
          <input className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          <div className="segmented" style={{ marginTop: 8 }}>
            {order.map((d) => (
              <button key={d} className={days.includes(d) ? 'on' : ''} aria-pressed={days.includes(d)} onClick={() => setDays(days.includes(d) ? days.filter((x) => x !== d) : [...days, d])}>
                {names[d]}
              </button>
            ))}
          </div>
          <span className="hint">{tr("Fără nicio zi aleasă rulează în fiecare zi.")}</span>
        </div>
      )}
      <div className="field">
        <label>{tr("Permisiuni")}</label>
        <select className="select" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
          {modes.map((m) => (
            <option key={m.id} value={m.id} title={m.title}>
              {m.label}: {m.desc}
            </option>
          ))}
        </select>
        <span className="hint">{tr("Nimeni nu aprobă la rulare: ce cere acord așteaptă până deschizi conversația.")}</span>
      </div>
      <div className="row">
        <div className="spacer" />
        <button className="btn" onClick={onCancel}>
          {tr("Renunță")}
        </button>
        <button className="btn primary" disabled={busy || !name.trim() || !prompt.trim() || !cwd} onClick={() => void save()}>
          {tr("Salvează")}
        </button>
      </div>
    </div>
  )
}
