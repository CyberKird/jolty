import { GitFork } from 'lucide-react'
import type { AppSettings, PermissionMode } from '@shared/types'
import { isAcp } from '@shared/types'
import { MODES, useAllModels } from '../components/ModelPicker'
import { api, useStore } from '../store'
import { tr } from '@shared/i18n'

/** How the sessions a chat starts for the parts of a job begin: their permissions and the browser. */
export function ChildSessionsSettings({ s, setS }: { s: AppSettings; setS: (s: AppSettings) => void }) {
  // "plan" and "ask" would leave a session waiting for someone to approve it
  const modes = MODES.filter((m) => m.id !== 'plan' && m.id !== 'ask')
  const profiles = useStore((x) => x.profiles).filter((p) => !isAcp(p.engine))
  const groups = useAllModels(profiles)
  const setModel = async (kind: 'simple' | 'hard', value: string): Promise<void> => {
    const [profileId, ...rest] = value.split('|')
    const next = { ...s.childModels, [kind]: value ? { profileId, model: rest.join('|') } : undefined }
    setS(await api.app.saveSettings({ childModels: next }))
  }
  const opus = groups.flatMap((g) => g.models).find((m) => /opus/i.test(`${m.id} ${m.label}`))
  const efforts = opus?.efforts?.length ? opus.efforts : ['low', 'medium', 'high', 'max']
  const modelSelect = (kind: 'simple' | 'hard', label: string) => (
    <div className="field" style={{ marginTop: 10 }}>
      <label>{label}</label>
      <select className="select" value={s.childModels?.[kind] ? `${s.childModels[kind]!.profileId}|${s.childModels[kind]!.model}` : ''} onChange={(e) => void setModel(kind, e.target.value)}>
        <option value="">{tr("Același model ca chatul")}</option>
        {groups.map((g) => (
          <optgroup key={g.profile.id} label={g.profile.name}>
            {g.models.map((m) => (
              <option key={m.id} value={`${g.profile.id}|${m.id}`}>
                {m.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  )
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="row" style={{ marginBottom: 10 }}>
        <GitFork size={16} color="var(--volt)" />
        <b>{tr("Sesiunile pornite de un chat")}</b>
      </div>
      <p className="muted small" style={{ marginTop: 0 }}>
        {tr("Când un chat pornește alte sesiuni pentru părți dintr-o sarcină, ele lucrează fără să le aprobe cineva pas cu pas. Alege cu ce permisiuni pornesc.")}
      </p>
      <select
        className="select"
        value={s.childMode ?? 'full'}
        onChange={async (e) => setS(await api.app.saveSettings({ childMode: e.target.value as PermissionMode }))}
      >
        {modes.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label} - {m.desc}
          </option>
        ))}
      </select>
      <p className="muted small" style={{ marginBottom: 0 }}>
        {tr("Modelul sesiunilor pornite, după cât de grea e sarcina (chatul alege când pornește sesiunea). Lăsat pe „Același model”, sesiunea folosește modelul chatului.")}
      </p>
      {modelSelect('simple', tr("Sarcini simple"))}
      {modelSelect('hard', tr("Sarcini grele"))}
      <label className="row" style={{ marginTop: 10, cursor: 'pointer' }}>
        <input type="checkbox" checked={s.childOpus === true} onChange={async (e) => setS(await api.app.saveSettings({ childOpus: e.target.checked }))} />
        <span>
          {tr("Sarcinile grele merg la Opus 5.5")}
          <span className="muted small" style={{ display: 'block' }}>
            {tr("Când chatul pornește o sesiune pentru o sarcină grea, ea rulează pe Opus 5.5, cu nivelul de gândire ales aici. Se folosește contul chatului, dacă are Opus. Are prioritate față de „Sarcini grele” de mai sus.")}
          </span>
        </span>
      </label>
      {s.childOpus === true && (
        <div className="field" style={{ marginTop: 8 }}>
          <label>{tr("Gândire pentru Opus")}</label>
          <select className="select" value={s.childOpusEffort || 'high'} onChange={async (e) => setS(await api.app.saveSettings({ childOpusEffort: e.target.value }))}>
            {efforts.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        </div>
      )}
      <label className="row" style={{ marginTop: 10, cursor: 'pointer' }}>
        <input type="checkbox" checked={s.childAutoModel === true} onChange={async (e) => setS(await api.app.saveSettings({ childAutoModel: e.target.checked }))} />
        <span>
          {tr("Alege modelul automat, după ce are Jolty")}
          <span className="muted small" style={{ display: 'block' }}>
            {tr("Acolo unde mai sus e „Același model ca chatul”, Jolty alege din conturile și furnizorii conectați, după scorul din selector: cel mai puternic pentru sarcini grele, cel mai rapid care e destul de bun pentru cele simple. Conturile aproape de limită sunt sărite.")}
          </span>
        </span>
      </label>
      <label className="row" style={{ marginTop: 10, cursor: 'pointer' }}>
        <input type="checkbox" checked={s.childBrowser !== false} onChange={async (e) => setS(await api.app.saveSettings({ childBrowser: e.target.checked }))} />
        <span>{tr("Cu acces la browserul Jolty")}</span>
      </label>
    </div>
  )
}
