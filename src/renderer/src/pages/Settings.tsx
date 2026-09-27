import { Eye, FolderOpen, Save } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AppSettings } from '@shared/types'
import { api, useStore } from '../store'

export function SettingsPage() {
  const profiles = useStore((s) => s.profiles)
  const { toast } = useStore()
  const [s, setS] = useState<AppSettings>()
  const [version, setVersion] = useState('')
  useEffect(() => {
    void api.app.settings().then(setS)
    void api.app.version().then(setVersion)
  }, [])
  if (!s) return null
  const visionCandidates = profiles.filter((p) => p.auth !== 'endpoint' || p.vision)
  return (
    <div className="page">
      <div className="page-inner narrow">
        <h1 className="page-title">Setări</h1>
        <p className="lead">Jolty {version}</p>
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="row" style={{ marginBottom: 10 }}>
            <Eye size={16} color="var(--volt)" />
            <b>Imagini pentru modelele care nu văd</b>
          </div>
          <p className="muted small" style={{ marginTop: 0 }}>
            Când trimiți o imagine unui model fără vision (de exemplu DeepSeek sau un model local mic), profilul de aici o descrie în detaliu (text exact, interfață, cod, erori), iar modelul tău primește descrierea.
          </p>
          <select className="select" value={s.visionProfileId || ''} onChange={(e) => setS({ ...s, visionProfileId: e.target.value || undefined })}>
            <option value="">Automat (primul profil Claude)</option>
            {visionCandidates.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="card" style={{ marginBottom: 14 }}>
          <b>Motoare</b>
          <p className="muted small">Jolty folosește versiunile incluse. Completează doar dacă vrei alt executabil.</p>
          <div className="field">
            <label>Claude Code (claude.exe)</label>
            <input className="input mono" value={s.claudePath || ''} placeholder="versiunea inclusă" onChange={(e) => setS({ ...s, claudePath: e.target.value || undefined })} />
          </div>
          <div className="field">
            <label>Codex (codex.exe)</label>
            <input className="input mono" value={s.codexPath || ''} placeholder="versiunea inclusă" onChange={(e) => setS({ ...s, codexPath: e.target.value || undefined })} />
          </div>
        </div>
        <div className="row">
          <button className="btn" onClick={() => void api.app.openPath(s.dataDir)} title={s.dataDir}>
            <FolderOpen size={14} /> Deschide datele Jolty
          </button>
          <div className="spacer" />
          <button
            className="btn primary"
            onClick={async () => {
              await api.app.saveSettings(s)
              toast('Setări salvate')
            }}
          >
            <Save size={14} /> Salvează
          </button>
        </div>
      </div>
    </div>
  )
}
