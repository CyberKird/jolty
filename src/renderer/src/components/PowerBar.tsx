import { Power } from 'lucide-react'
import { api, useStore } from '../store'
import { dateLocale, tr } from '@shared/i18n'
import { ACTION_WHAT } from '@shared/power'

const REASONS = {
  done: () => tr("lucrul s-a terminat"),
  usage: () => tr("a rămas fără usage"),
  error: () => tr("lucrul s-a oprit cu o eroare"),
  timer: () => tr("timerul a expirat")
}

export const clock = (ms: number): string => new Date(ms).toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' })

/** Visible on every page while the power plan is armed, and during the countdown. */
export function PowerBar() {
  const power = useStore((s) => s.power)
  if (!power.armed) return null
  const counting = power.seconds !== undefined
  const what = ACTION_WHAT[power.plan.action]()
  return (
    <div className={`power-bar ${counting ? 'counting' : ''}`} role="status" aria-live="polite">
      <Power size={14} strokeWidth={2} />
      <span>
        {counting
          ? tr("{what} în {s} s: {why}", { what, s: power.seconds, why: REASONS[power.reason || 'done']() })
          : power.due
            ? tr("{action} la {time}", { action: what, time: clock(power.due) })
            : tr("{what} când termină lucrul sau când rămâi fără usage.", { what })}
      </span>
      <button className="btn small" onClick={() => void api.power.cancel()}>
        {tr("Renunță")}
      </button>
    </div>
  )
}
