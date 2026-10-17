import { Power } from 'lucide-react'
import { api, useStore } from '../store'
import { tr } from '@shared/i18n'

const REASONS = { done: () => tr("lucrul s-a terminat"), usage: () => tr("a rămas fără usage"), error: () => tr("lucrul s-a oprit cu o eroare") }

/** Visible on every page while "turn the PC off when done" is armed, and during the countdown. */
export function PowerBar() {
  const power = useStore((s) => s.power)
  if (!power.armed) return null
  const counting = power.seconds !== undefined
  return (
    <div className={`power-bar ${counting ? 'counting' : ''}`} role="status" aria-live="polite">
      <Power size={14} strokeWidth={2} />
      <span>
        {counting
          ? tr("PC-ul se oprește în {s} s: {why}", { s: power.seconds, why: REASONS[power.reason || 'done']() })
          : tr("PC-ul se oprește când termină lucrul sau când rămâi fără usage.")}
      </span>
      <button className="btn small" onClick={() => void api.power.cancel()}>
        {tr("Anulează")}
      </button>
    </div>
  )
}
