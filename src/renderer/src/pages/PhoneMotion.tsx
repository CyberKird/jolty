import { useEffect, useState } from 'react'
import { tr } from '@shared/i18n'
import { frameMs, motionPref, setMotionPref, type MotionPref } from '../remote/motion'

const CHOICES: { id: MotionPref; label: () => string }[] = [
  { id: 'on', label: () => tr("Pornite") },
  { id: 'reduced', label: () => tr("Reduse") },
  { id: 'off', label: () => tr("Oprite") }
]

/** Settings on a paired phone: how the page moves there. Kept in the phone's own browser and applied at once (remote/motion.ts). */
export function PhoneMotion() {
  const [pref, setPref] = useState<MotionPref>(motionPref)
  const [hz, setHz] = useState(() => Math.round(1000 / frameMs()))
  useEffect(() => {
    const sync = (): void => {
      setPref(motionPref())
      setHz(Math.round(1000 / frameMs()))
    }
    // the rate is measured a moment after the page opens
    const t = setTimeout(sync, 1300)
    window.addEventListener('jolty:motion', sync)
    return () => {
      clearTimeout(t)
      window.removeEventListener('jolty:motion', sync)
    }
  }, [])
  const hint = pref === 'on' ? tr("Totul se mișcă fluid, potrivit ecranului ({hz} Hz).", { hz }) : pref === 'reduced' ? tr("Doar estompări scurte, nimic nu alunecă.") : tr("Nimic nu se mișcă, totul apare pe loc.")
  return (
    <div className="card phone-motion" style={{ marginBottom: 14 }}>
      <div className="phone-motion-text">
        <div className="phone-motion-title">{tr("Animații")}</div>
        <div className="muted small">{tr("Cum se mișcă Jolty pe acest telefon. Se aplică imediat și rămâne doar pe telefonul acesta.")}</div>
      </div>
      <div className="segmented phone-motion-seg" role="radiogroup" aria-label={tr("Animații")}>
        {CHOICES.map((c) => (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={pref === c.id}
            className={pref === c.id ? 'on' : ''}
            onClick={() => {
              setMotionPref(c.id)
              setPref(c.id)
            }}
          >
            {c.label()}
          </button>
        ))}
      </div>
      <div className="faint small" aria-live="polite">
        {hint}
      </div>
    </div>
  )
}
