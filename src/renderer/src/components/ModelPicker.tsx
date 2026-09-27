// One picker for every model Jolty knows about (all profiles), with the effort level underneath,
// the way the Claude app does it. Also the compact permission-mode menu next to it.
import { Check, ChevronDown } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { capability } from '@shared/complexity'
import type { ModelOption, PermissionMode, Profile } from '@shared/types'
import { api, ENGINE_LABEL, errMsg } from '../store'

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
  low: 'Răspunsuri rapide, gândire minimă',
  medium: 'Gândire moderată',
  high: 'Gândire în profunzime',
  xhigh: 'Mai adânc decât high: cel mai bun pentru cod și sarcini lungi',
  max: 'Efort maxim: cel mai lent și cel mai scump'
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
  const label = current?.label || p.model || (group?.loading ? 'Se încarcă…' : 'Alege modelul')

  return (
    <div className="picker" ref={ref}>
      <button className="picker-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} title={group ? `${group.profile.name} · ${label}` : label}>
        <span className="dot" style={{ width: 7, height: 7, background: group?.profile.color || 'var(--grey-2)' }} />
        <span className="ellipsis">{label}</span>
        {effort && <span className="picker-effort">{effort}</span>}
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="picker-pop" role="menu" aria-label="Model și efort">
          <div className="picker-list">
            {p.groups.map((g) => (
              <div className="picker-group" key={g.profile.id}>
                <div className="picker-group-head">
                  <span className="dot" style={{ width: 6, height: 6, background: g.profile.color }} />
                  <span className="ellipsis">{g.profile.name}</span>
                  <span className="picker-engine">{g.profile.local ? 'Local' : ENGINE_LABEL[g.profile.engine]}</span>
                </div>
                {g.loading && <div className="picker-empty">Se încarcă…</div>}
                {g.error && <div className="picker-empty">Neconectat. Intră în Conturi și chei.</div>}
                {!g.loading && !g.error && !g.models.length && <div className="picker-empty">Niciun model</div>}
                {g.models.map((m) => {
                  const on = g.profile.id === p.profileId && m.id === current?.id
                  const other = g.profile.id !== p.profileId
                  const cap = capability(g.profile, m)
                  return (
                    <button
                      key={m.id}
                      data-opt
                      role="menuitemradio"
                      aria-checked={on}
                      className={`picker-opt ${on ? 'on' : ''}`}
                      title={[cap.compare, m.description, m.efforts?.length ? `Efort: ${m.efforts.join(', ')}` : 'Fără niveluri de efort', m.vision === false ? 'Nu vede imagini: le descrie alt profil' : ''].filter(Boolean).join('\n')}
                      onClick={() => {
                        setOpen(false)
                        if (!on) p.onPick(g.profile.id, m.id)
                      }}
                    >
                      <span className="picker-opt-text">
                        <span className="picker-opt-name">
                          {m.label}
                          <span className={`picker-tag grade-${cap.grade}`}>{cap.tag}</span>
                          {m.isDefault && <span className="picker-tag">implicit</span>}
                          {m.vision === false && <span className="picker-tag">fără imagini</span>}
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
              <span className="picker-foot-label">Efort</span>
              <div className="segmented" role="radiogroup" aria-label="Efort">
                {/* a model without a declared default (Claude) runs its own default when nothing is picked */}
                {!current?.defaultEffort && (
                  <button data-opt role="radio" aria-checked={!p.effort} className={!p.effort ? 'on' : ''} title="Efortul implicit al modelului" onClick={() => p.onEffort('')}>
                    auto
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

export const MODES: { id: PermissionMode; label: string; desc: string; title: string }[] = [
  {
    id: 'auto',
    label: 'Auto',
    desc: 'Modelul decide singur ce aprobări îți cere',
    title: 'Claude folosește un clasificator care aprobă acțiunile sigure și te întreabă doar la cele riscante. Codex cere voie doar când consideră necesar.'
  },
  {
    id: 'ask',
    label: 'Manual',
    desc: 'Întreabă mereu înainte de modificări',
    title: 'Fiecare fișier modificat și fiecare comandă așteaptă acordul tău. Cel mai sigur, cel mai lent.'
  },
  {
    id: 'autoEdit',
    label: 'Acceptă editările',
    desc: 'Acceptă automat modificările de fișiere',
    title: 'Editează fișierele din proiect fără să întrebe, dar cere voie pentru comenzi în terminal.'
  },
  {
    id: 'plan',
    label: 'Plan',
    desc: 'Face un plan înainte de modificări',
    title: 'Doar citește și cercetează, apoi îți arată planul. Nu modifică nimic până nu aprobi.'
  },
  {
    id: 'full',
    label: 'Fără permisiuni',
    desc: 'Acceptă toate permisiunile',
    title: 'Rulează orice comandă și modifică orice fără să întrebe. Doar în proiecte în care ai încredere totală.'
  }
]

export function ModePicker({ mode, onMode }: { mode: PermissionMode; onMode: (m: PermissionMode) => void }) {
  const { open, setOpen, ref } = usePopover()
  const current = MODES.find((m) => m.id === mode) || MODES[0]
  // 1-5 pick a mode while the menu is open, like the Claude app
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      const m = MODES[Number(e.key) - 1]
      if (!m || e.ctrlKey || e.altKey || e.metaKey) return
      e.preventDefault()
      setOpen(false)
      onMode(m.id)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onMode, setOpen])
  return (
    <div className="picker" ref={ref}>
      <button className={`picker-btn mode-${mode}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} title={current.title}>
        <span className="ellipsis">{current.label}</span>
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="picker-pop small" role="menu" aria-label="Permisiuni">
          <div className="picker-list">
            <div className="picker-group-head">Mod</div>
            {MODES.map((m, i) => (
              <button
                key={m.id}
                data-opt
                role="menuitemradio"
                aria-checked={m.id === mode}
                className={`picker-opt ${m.id === mode ? 'on' : ''}`}
                title={m.title}
                onClick={() => {
                  setOpen(false)
                  onMode(m.id)
                }}
              >
                <span className="picker-opt-text">
                  <span className="picker-opt-name">
                    {m.label}
                    {m.id === DEFAULT_MODE && <span className="picker-tag">implicit</span>}
                  </span>
                  <span className="picker-opt-desc">{m.desc}</span>
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
