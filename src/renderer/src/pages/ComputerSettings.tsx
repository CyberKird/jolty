import { Monitor, X } from 'lucide-react'
import type { AppSettings } from '@shared/types'
import { api } from '../store'
import { tr } from '@shared/i18n'

type Human = NonNullable<AppSettings['computerHuman']>

const LEVELS: { id: Human; label: string }[] = [
  { id: 'max', label: tr("Maxim: mișcare și scris ca ale unui om, cu mici greșeli corectate") },
  { id: 'normal', label: tr("Normal: ca un om care se grăbește puțin") },
  { id: 'fast', label: tr("Rapid: mișcări scurte, fără pauze de citit") }
]

export function ComputerSettings({ s, setS }: { s: AppSettings; setS: (v: AppSettings) => void }) {
  const trusted = s.computerTrusted ?? []
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="row" style={{ marginBottom: 10 }}>
        <Monitor size={16} color="var(--volt)" />
        <b>{tr("Computer")}</b>
      </div>
      <p className="muted small" style={{ marginTop: 0 }}>
        {tr("Cu butonul Computer din conversație, modelul vede ecranul și folosește mouse-ul și tastatura ca un om, doar în programele pe care le aprobi. Nu atinge Jolty, managerele de parole, ferestrele de securitate Windows și paginile de bancă. Dacă miști mouse-ul sau apeși o tastă, se oprește. Ctrl+Alt+Esc îl oprește oricând.")}
      </p>
      <div className="field" style={{ marginBottom: 12 }}>
        <label>{tr("Cât de uman")}</label>
        <select className="select" value={s.computerHuman ?? 'max'} onChange={async (e) => setS(await api.app.saveSettings({ computerHuman: e.target.value as Human }))}>
          {LEVELS.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>
      </div>
      <label className="row" style={{ marginBottom: 12, cursor: 'pointer', gap: 8 }}>
        <input type="checkbox" checked={s.computerPaste === true} onChange={async (e) => setS(await api.app.saveSettings({ computerPaste: e.target.checked }))} />
        <span>
          <b>{tr("Textele lungi pot fi lipite")}</b>
          <span className="muted small" style={{ display: 'block' }}>
            {tr("Oprit: modelul scrie tot, tastă cu tastă. Pornit: un text lung poate intra prin clipboard (mai repede, dar nu arată ca scrisul de mână).")}
          </span>
        </span>
      </label>
      <div className="field" style={{ marginBottom: 0 }}>
        <label>{tr("Programe aprobate pentru totdeauna")}</label>
        {trusted.length === 0 ? (
          <p className="muted small" style={{ margin: 0 }}>
            {tr("Niciunul încă: modelul te întreabă prima dată când vrea să lucreze într-un program.")}
          </p>
        ) : (
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
            {trusted.map((t) => (
              <span key={t} className="row mono small" style={{ gap: 4 }}>
                {t}
                <button className="btn ghost small" title={tr("Șterge")} onClick={async () => setS(await api.app.saveSettings({ computerTrusted: trusted.filter((x) => x !== t) }))}>
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
