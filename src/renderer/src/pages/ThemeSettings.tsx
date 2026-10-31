import { Palette } from 'lucide-react'
import { useState } from 'react'
import type { AppSettings } from '@shared/types'
import { tr } from '@shared/i18n'
import { api } from '../store'
import { applyTheme, setClear, THEMES, type ThemeId } from '../theme'

const TEXT: Record<ThemeId, { name: string; about: string }> = {
  volt: { name: 'Volt', about: tr("Negru, muchii ascuțite și verde volt. Aspectul de bază.") },
  glass: { name: 'Glass', about: tr("Sticlă transparentă care refractă lumina, cu reflexii pe muchii și o aurora vie în spate.") },
  frost: { name: 'Frost', about: tr("Sticlă luminoasă, în tonuri pastel și cu muchii irizate, ca o placă groasă de cristal.") }
}

/** The colour theme: the choice applies at once and is saved with the other settings. Glass can also let the desktop show through. */
export function ThemeSettings({ current, clear }: { current: AppSettings['theme']; clear: AppSettings['glassClear'] }) {
  const [theme, setTheme] = useState<ThemeId>(current || 'volt')
  const [see, setSee] = useState(clear || 0)
  const pick = (id: ThemeId): void => {
    setTheme(id)
    applyTheme(id, see)
    void api.app.saveSettings({ theme: id })
  }
  const slide = (n: number): void => {
    setSee(n)
    setClear(n)
  }
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="row" style={{ marginBottom: 10 }}>
        <Palette size={16} color="var(--volt)" />
        <b>{tr("Temă")}</b>
      </div>
      <div className="theme-grid" role="radiogroup" aria-label={tr("Temă")}>
        {THEMES.map((id) => (
          <button key={id} type="button" role="radio" aria-checked={theme === id} className={`theme-opt ${theme === id ? 'on' : ''}`} onClick={() => pick(id)}>
            <span className={`theme-swatch ${id}`} aria-hidden>
              <i /><i /><i />
            </span>
            <b>{TEXT[id].name}</b>
            <span className="muted small">{TEXT[id].about}</span>
          </button>
        ))}
      </div>
      {theme !== 'volt' && (
        <label className="theme-clear">
          <span>
            <b>{tr("Fereastră transparentă")}</b>
            <span className="muted small" style={{ display: 'block' }}>
              {tr("Lasă să se vadă desktopul și aplicațiile din spatele Jolty, încețoșate. Necesită Windows 11 22H2 sau mai nou.")}
            </span>
          </span>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={see}
            aria-label={tr("Fereastră transparentă")}
            onChange={(e) => slide(Number(e.target.value))}
            onPointerUp={() => void api.app.saveSettings({ glassClear: see })}
            onKeyUp={() => void api.app.saveSettings({ glassClear: see })}
          />
          <span className="muted small">{see ? `${see}%` : tr("Oprită")}</span>
        </label>
      )}
    </div>
  )
}
