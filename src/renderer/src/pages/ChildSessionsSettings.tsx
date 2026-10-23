import { GitFork } from 'lucide-react'
import type { AppSettings, PermissionMode } from '@shared/types'
import { MODES } from '../components/ModelPicker'
import { api } from '../store'
import { tr } from '@shared/i18n'

/** How the sessions a chat starts for the parts of a job begin: their permissions and the browser. */
export function ChildSessionsSettings({ s, setS }: { s: AppSettings; setS: (s: AppSettings) => void }) {
  // "plan" and "ask" would leave a session waiting for someone to approve it
  const modes = MODES.filter((m) => m.id !== 'plan' && m.id !== 'ask')
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
      <label className="row" style={{ marginTop: 10, cursor: 'pointer' }}>
        <input type="checkbox" checked={s.childBrowser !== false} onChange={async (e) => setS(await api.app.saveSettings({ childBrowser: e.target.checked }))} />
        <span>{tr("Cu acces la browserul Jolty")}</span>
      </label>
    </div>
  )
}
