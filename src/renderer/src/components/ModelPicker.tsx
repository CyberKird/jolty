// One picker for every model Jolty knows about (all profiles), with the effort level underneath,
// the way the Claude app does it. Also the compact permission-mode menu next to it.
import { Check, ChevronDown } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { capability } from '@shared/complexity'
import { modelScore } from '@shared/scores'
import type { BrowserMode, EngineKind, ModelOption, PermissionMode, Profile, SiteTrust } from '@shared/types'
import { api, ENGINE_LABEL, errMsg } from '../store'
import { tr } from '@shared/i18n'

export interface ModelGroup {
  profile: Profile
  models: ModelOption[]
  loading: boolean
  error?: string
}

// ponytail: cached for the app's lifetime; the key changes when an endpoint profile's model list does
const cache = new Map<string, Promise<ModelOption[]>>()
const key = (p: Profile): string => `${p.id}:${(p.models || []).join(',')}`

function load(p: Profile): Promise<ModelOption[]> {
  let pr = cache.get(key(p))
  if (!pr) {
    // a subscription that is not logged in lists its models but cannot run them
    pr = (p.auth === 'subscription'
      ? api.profiles.status(p.id).then((s) => {
          if (!s.loggedIn) throw new Error('neconectat')
        })
      : Promise.resolve()
    ).then(() => api.profiles.models(p.id))
    cache.set(key(p), pr)
    pr.catch(() => cache.delete(key(p)))
  }
  return pr
}

/** Models of every profile, loaded in parallel. A profile that is not logged in shows its error. */
export function useAllModels(profiles: Profile[]): ModelGroup[] {
  const [state, setState] = useState<Record<string, { models: ModelOption[]; loading: boolean; error?: string }>>({})
  const sig = profiles.map(key).join('|')
  useEffect(() => {
    let alive = true
    for (const p of profiles) {
      setState((s) => (s[p.id] && !s[p.id].error ? s : { ...s, [p.id]: { models: [], loading: true } }))
      load(p)
        .then((models) => alive && setState((s) => ({ ...s, [p.id]: { models, loading: false } })))
        .catch((err) => alive && setState((s) => ({ ...s, [p.id]: { models: [], loading: false, error: errMsg(err) } })))
    }
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig])
  return profiles.map((profile) => ({ profile, ...(state[profile.id] || { models: [], loading: true }) }))
}

export const EFFORT_TITLES: Record<string, string> = {
  low: tr("Răspunsuri rapide, gândire minimă"),
  medium: tr("Gândire moderată"),
  high: tr("Gândire în profunzime"),
  xhigh: tr("Mai adânc decât high: cel mai bun pentru cod și sarcini lungi"),
  max: tr("Efort maxim: cel mai lent și cel mai scump"),
  off: tr("Fără gândire: răspunde direct, cel mai rapid și ieftin"),
  on: tr("Cu gândire: raționează înainte să răspundă")
}

/** Closes a popover on outside click or Escape, and moves focus with the arrow keys. */
function usePopover(): { open: boolean; setOpen: (v: boolean) => void; ref: React.RefObject<HTMLDivElement | null> } {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const el = ref.current
    const items = (): HTMLElement[] => [...(el?.querySelectorAll<HTMLElement>('[data-opt]:not(:disabled)') || [])]
    ;(el?.querySelector<HTMLElement>('[data-opt][aria-checked="true"]') || items()[0])?.focus()
    const onDown = (e: MouseEvent): void => {
      if (el && !el.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setOpen(false)
        el?.querySelector<HTMLElement>('.picker-btn')?.focus()
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const list = items()
        const i = list.indexOf(document.activeElement as HTMLElement)
        list[(i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus()
        e.preventDefault()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  return { open, setOpen, ref }
}

export function ModelPicker(p: {
  groups: ModelGroup[]
  profileId?: string
  model?: string
  effort?: string
  onPick: (profileId: string, model: string) => void
  onEffort: (effort: string) => void
  /** shown on models from other profiles when picking them does more than switch the model */
  otherProfileHint?: string
}) {
  const { open, setOpen, ref } = usePopover()
  const group = p.groups.find((g) => g.profile.id === p.profileId)
  const current = group?.models.find((m) => m.id === p.model) || group?.models.find((m) => m.isDefault)
  const efforts = current?.efforts || []
  const effort = p.effort || current?.defaultEffort
  const label = current?.label || p.model || (group?.loading ? tr("Se încarcă…") : tr("Alege modelul"))

  return (
    <div className="picker" ref={ref}>
      <button className="picker-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} title={group ? `${group.profile.name} · ${label}` : label}>
        <span className="dot" style={{ width: 7, height: 7, background: group?.profile.color || 'var(--grey-2)' }} />
        <span className="ellipsis">{label}</span>
        {effort && <span className="picker-effort">{effort}</span>}
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="picker-pop" role="menu" aria-label={tr("Model și efort")}>
          <div className="picker-legend">{tr("Numărul e inteligența (Artificial Analysis, mai mare e mai bine), cuvântul e viteza.")}</div>
          <div className="picker-list">
            {p.groups.map((g) => (
              <div className="picker-group" key={g.profile.id}>
                <div className="picker-group-head">
                  <span className="dot" style={{ width: 6, height: 6, background: g.profile.color }} />
                  <span className="ellipsis">{g.profile.name}</span>
                  <span className="picker-engine">{g.profile.local ? 'Local' : ENGINE_LABEL[g.profile.engine]}</span>
                </div>
                {g.loading && <div className="picker-empty">{tr("Se încarcă…")}</div>}
                {g.error && <div className="picker-empty">{tr("Neconectat. Intră în Conturi și chei.")}</div>}
                {!g.loading && !g.error && !g.models.length && <div className="picker-empty">{tr("Niciun model")}</div>}
                {g.models.map((m) => {
                  const on = g.profile.id === p.profileId && m.id === current?.id
                  const other = g.profile.id !== p.profileId
                  const cap = capability(g.profile, m)
                  const sc = modelScore(g.profile, m)
                  const scoreTip = sc ? tr("Inteligență {iq}{v1} (Artificial Analysis): {note}", { iq: sc.iq, v1: sc.tps ? `, ~${Math.round(sc.tps)} tokeni/s` : '', note: sc.note }) : cap.compare
                  return (
                    <button
                      key={m.id}
                      data-opt
                      role="menuitemradio"
                      aria-checked={on}
                      className={`picker-opt ${on ? 'on' : ''}`}
                      title={[scoreTip, m.description, m.efforts?.length ? tr("Gândire: {join}", { join: m.efforts.join(', ') }) : tr("Fără niveluri de gândire"), m.vision === false ? tr("Nu vede imagini: le descrie alt profil") : ''].filter(Boolean).join('\n')}
                      onClick={() => {
                        setOpen(false)
                        if (!on) p.onPick(g.profile.id, m.id)
                      }}
                    >
                      <span className="picker-opt-text">
                        <span className="picker-opt-name">
                          {m.label}
                          {sc && <span className={`picker-score ${sc.iq >= 45 ? 'hi' : sc.iq < 25 ? 'lo' : ''}`}>{sc.iq}</span>}
                          {sc?.speed && <span className="picker-speed">{sc.speed}</span>}
                        </span>
                        {(m.description || (other && p.otherProfileHint)) && (
                          <span className="picker-opt-desc">{other && p.otherProfileHint ? p.otherProfileHint : m.description}</span>
                        )}
                      </span>
                      {on && <Check size={14} />}
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
          {efforts.length > 0 && (
            <div className="picker-foot">
              <span className="picker-foot-label">{tr("Gândire")}</span>
              <div className="segmented" role="radiogroup" aria-label={tr("Nivel de gândire")}>
                {/* a model without a declared default (Claude) runs its own default when nothing is picked */}
                {!current?.defaultEffort && (
                  <button data-opt role="radio" aria-checked={!p.effort} className={!p.effort ? 'on' : ''} title={tr("Efortul implicit al modelului")} onClick={() => p.onEffort('')}>
                   {tr("auto")}
                  </button>
                )}
                {efforts.map((e) => (
                  <button key={e} data-opt role="radio" aria-checked={effort === e} className={effort === e ? 'on' : ''} title={EFFORT_TITLES[e] || e} onClick={() => p.onEffort(e)}>
                    {e}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export const DEFAULT_MODE: PermissionMode = 'autoEdit'

export const MODES: { id: PermissionMode; label: string; desc: string; title: string; only?: EngineKind }[] = [
  {
    id: 'auto',
    label: tr("Auto"),
    desc: tr("Modelul decide singur ce aprobări îți cere"),
    title: tr("Claude folosește un clasificator care aprobă acțiunile sigure și te întreabă doar la cele riscante. Codex cere voie doar când consideră necesar.")
  },
  {
    id: 'ask',
    label: tr("Manual"),
    desc: tr("Întreabă mereu înainte de modificări"),
    title: tr("Fiecare fișier modificat și fiecare comandă așteaptă acordul tău. Cel mai sigur, cel mai lent.")
  },
  {
    id: 'autoEdit',
    label: tr("Acceptă editările"),
    desc: tr("Acceptă automat modificările de fișiere"),
    title: tr("Editează fișierele din proiect fără să întrebe, dar cere voie pentru comenzi în terminal.")
  },
  {
    id: 'plan',
    label: tr("Plan"),
    desc: tr("Face un plan înainte de modificări"),
    title: tr("Doar citește și cercetează, apoi îți arată planul. Nu modifică nimic până nu aprobi.")
  },
  {
    id: 'project',
    label: tr("Liber în proiect"),
    desc: tr("Fără întrebări, doar în folderul proiectului"),
    title: tr("Codex lucrează fără să întrebe, dar sandbox-ul lui nu îl lasă să scrie în afara folderului proiectului. Rețeaua e pornită, ca să poată instala pachete."),
    only: 'codex'
  },
  {
    id: 'full',
    label: tr("Fără permisiuni"),
    desc: tr("Acceptă toate permisiunile, pe tot discul"),
    title: tr("Rulează orice comandă și modifică orice fără să întrebe, oriunde pe disc. Doar în proiecte în care ai încredere totală.")
  }
]

const HERMES_MODES = [
  { id: 'ask' as const, label: tr("Aprobă editările"), desc: tr("Cere acordul pentru fișiere și comenzi periculoase"), title: tr("Hermes cere acordul înainte de editări și comenzi periculoase. Alte comenzi pot rula automat.") },
  { id: 'autoEdit' as const, label: tr("Acceptă editările"), desc: tr("Editează automat în proiect și în folderul temporar"), title: tr("Hermes aprobă editările în proiect și în folderul temporar. Cere acordul pentru căi sensibile și comenzi periculoase.") },
  { id: 'full' as const, label: tr("Editări extinse"), desc: tr("Aprobă editările din afara proiectului"), title: tr("Hermes aprobă editările în această sesiune, cu excepția căilor sensibile. Comenzile periculoase cer în continuare acordul.") }
]

/** The modes this engine offers. */
export function modesFor(engine?: EngineKind): { id: PermissionMode; label: string; desc: string; title: string }[] {
  return engine === 'hermes' ? HERMES_MODES : MODES.filter((m) => !m.only || m.only === engine)
}

/** Whole-disk access is never one slip away: it needs a yes, and Shift+Tab does not pass through it. */
export const OPEN_MODES: PermissionMode[] = ['project', 'full']

export function ModePicker({ mode, onMode, engine }: { mode: PermissionMode; onMode: (m: PermissionMode) => void; engine?: EngineKind }) {
  const { open, setOpen, ref } = usePopover()
  const choices = modesFor(engine)
  // a native confirm() leaves Electron without keyboard focus (the chatbox stops taking input), so the yes is asked inline
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!open) setArmed(false)
  }, [open])
  const pick = (m: PermissionMode): void => {
    if (m === 'full' && mode !== 'full' && engine !== 'hermes' && !armed) {
      setArmed(true)
      setOpen(true)
      return
    }
    setOpen(false)
    onMode(m)
  }
  const current = choices.find((m) => m.id === mode) || choices[0]
  // 1-5 pick a mode while the menu is open, like the Claude app
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      const m = choices[Number(e.key) - 1]
      if (!m || e.ctrlKey || e.altKey || e.metaKey) return
      e.preventDefault()
      pick(m.id)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, onMode, setOpen, choices, armed])
  return (
    <div className="picker" ref={ref}>
      <button className={`picker-btn mode-${mode}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} title={current.title}>
        <span className="ellipsis">{current.label}</span>
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="picker-pop small" role="menu" aria-label={tr("Permisiuni")}>
          <div className="picker-list">
            <div className="picker-group-head">{tr("Mod")}</div>
            {choices.map((m, i) => (
              <button
                key={m.id}
                data-opt
                role="menuitemradio"
                aria-checked={m.id === mode}
                className={`picker-opt ${m.id === mode ? 'on' : ''}`}
                title={m.title}
                onClick={() => pick(m.id)}
              >
                <span className="picker-opt-text">
                  <span className="picker-opt-name">
                    {armed && m.id === 'full' ? tr("Confirmă: fără permisiuni") : m.label}
                    {m.id === DEFAULT_MODE && <span className="picker-tag">{tr("implicit")}</span>}
                  </span>
                  <span className="picker-opt-desc">
                    {armed && m.id === 'full' ? tr("Rulează orice comandă și modifică orice fișier de pe disc. Doar câteva comenzi ireversibile rămân blocate. Apasă din nou ca să continui.") : m.desc}
                  </span>
                </span>
                {m.id === mode && <Check size={14} />}
                <kbd className="picker-key">{i + 1}</kbd>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

const TRUST: { id: SiteTrust; label: string; desc: string }[] = [
  { id: 'ask', label: tr("Întreabă la fiecare acțiune"), desc: tr("Clicul, tastarea și formularele cer acordul de fiecare dată") },
  { id: 'site', label: tr("O dată pe site"), desc: tr("Recomandat: întreabă prima dată pe un site, apoi lucrează liber pe el în conversația asta") },
  { id: 'free', label: tr("Liber"), desc: tr("Fără întrebări pentru clic și tastare. Cod în pagină, încărcarea de fișiere și închiderea tabului tot cer acordul") }
]

const CONNECT: { id: BrowserMode; label: string; desc: string }[] = [
  { id: 'auto', label: tr("Tab propriu, automat"), desc: tr("Browserul tău: se conectează singur și lucrează într-un tab deschis de el") },
  { id: 'pick', label: tr("Aleg eu tabul"), desc: tr("Browserul tău: extensia îți arată tab-urile deschise și modelul lucrează în cel pe care îl alegi") },
  { id: 'own', label: tr("Fereastră Jolty, profil separat"), desc: tr("Un browser aparte, cu profilul lui: vede toate tab-urile din fereastra aceea și nu atinge conturile tale. Te loghezi o dată pe site-urile de care are nevoie") }
]

/** What a model may do in the browser without asking, and how it attaches to a tab. */
export function BrowserMenu() {
  const { open, setOpen, ref } = usePopover()
  const [trust, setTrust] = useState<SiteTrust>('site')
  const [mode, setMode] = useState<BrowserMode>('auto')
  useEffect(() => {
    if (open)
      void api.app.settings().then((s) => {
        setTrust(s.siteTrust || 'site')
        setMode(s.browserMode || 'auto')
      })
  }, [open])
  return (
    <div className="picker" ref={ref}>
      <button className="chrome-toggle chevron" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} title={tr("Permisiunile și conectarea browserului")} aria-label={tr("Permisiunile browserului")}>
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="picker-pop" role="menu" aria-label={tr("Permisiunile browserului")}>
          <div className="picker-list">
            <div className="picker-group-head">{tr("Cât de liber lucrează modelul")}</div>
            {TRUST.map((t) => (
              <button
                key={t.id}
                data-opt
                role="menuitemradio"
                aria-checked={trust === t.id}
                className={`picker-opt ${trust === t.id ? 'on' : ''}`}
                onClick={() => {
                  setTrust(t.id)
                  void api.app.saveSettings({ siteTrust: t.id })
                }}
              >
                <span className="picker-opt-text">
                  <span className="picker-opt-name">{t.label}</span>
                  <span className="picker-opt-desc">{t.desc}</span>
                </span>
                {trust === t.id && <Check size={14} />}
              </button>
            ))}
            <div className="picker-group-head" style={{ marginTop: 8 }}>{tr("Conectare")}</div>
            {CONNECT.map((c) => (
              <button
                key={c.id}
                data-opt
                role="menuitemradio"
                aria-checked={mode === c.id}
                className={`picker-opt ${mode === c.id ? 'on' : ''}`}
                onClick={() => {
                  setMode(c.id)
                  void api.app.saveSettings({ browserMode: c.id })
                }}
              >
                <span className="picker-opt-text">
                  <span className="picker-opt-name">{c.label}</span>
                  <span className="picker-opt-desc">{c.desc}</span>
                </span>
                {mode === c.id && <Check size={14} />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
