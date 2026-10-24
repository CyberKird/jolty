// The power button in the composer: what the PC does (shutdown, restart, sleep, hibernate, log off, lock)
// and when (once the work is done, after some minutes, or at a time of day), the way ShutdownTimer asks for it.
import { Check, Power } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { PowerAction, PowerWhen } from '@shared/types'
import { ACTION_LABEL, DESTRUCTIVE, POWER_ACTIONS } from '@shared/power'
import { api, useStore } from '../store'
import { tr } from '@shared/i18n'
import { usePopover } from './ModelPicker'
import { clock } from './PowerBar'

const KINDS: { id: PowerWhen['kind']; label: () => string }[] = [
  { id: 'done', label: () => tr("La final") },
  { id: 'in', label: () => tr("După") },
  { id: 'at', label: () => tr("La ora") }
]

const inAnHour = (): string => {
  const d = new Date(Date.now() + 3_600_000)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** In the bar only while a plan is armed; otherwise the tools menu mounts it with `autoOpen` and it leaves when closed. */
export function PowerMenu({ autoOpen, onClosed }: { autoOpen?: boolean; onClosed?: () => void }) {
  const power = useStore((s) => s.power)
  const { open, setOpen, ref } = usePopover()
  const wasOpen = useRef(false)
  useEffect(() => {
    if (autoOpen) setOpen(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (open) wasOpen.current = true
    else if (wasOpen.current) {
      wasOpen.current = false
      onClosed?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  const [action, setAction] = useState<PowerAction>('shutdown')
  const [kind, setKind] = useState<PowerWhen['kind']>('done')
  const [minutes, setMinutes] = useState(30)
  const [time, setTime] = useState('')
  const [force, setForce] = useState(true)

  // opening shows the plan that is armed, or the last one used
  useEffect(() => {
    if (!open) return
    const { plan } = power
    setAction(plan.action)
    setKind(plan.when.kind)
    setForce(plan.force)
    if (plan.when.kind === 'in') setMinutes(plan.when.minutes)
    setTime(plan.when.kind === 'at' ? plan.when.time : (t) => t || inAnHour())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const ok = kind === 'done' || (kind === 'in' ? minutes >= 1 && minutes <= 1440 : Boolean(time))
  const submit = (): void => {
    if (!ok) return
    const when: PowerWhen = kind === 'in' ? { kind, minutes } : kind === 'at' ? { kind, time } : { kind }
    void api.power.arm(true, { action, when, force })
    setOpen(false)
  }
  // the arrows belong to the number and time fields here, not to the menu's focus walk
  const field = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') e.stopPropagation()
    else if (e.key === 'Enter') submit()
  }

  const label = ACTION_LABEL[power.plan.action]()
  return (
    <div className="picker" ref={ref}>
      <button
        className={`chrome-toggle ${power.armed ? 'on' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title={
          power.armed
            ? tr("Clic ca să schimbi planul sau să-l anulezi.")
            : tr("Oprește, repornește, adoarme sau blochează PC-ul când termină lucrul sau la o oră aleasă.")
        }
      >
        <Power size={14} strokeWidth={1.8} />
        {power.armed && (power.due ? clock(power.due) : label)}
      </button>
      {open && (
        <div className="picker-pop small power-pop" role="menu" aria-label={tr("Oprire PC")}>
          <div className="picker-list">
            <div className="picker-group-head">{tr("Acțiune")}</div>
            {POWER_ACTIONS.map((a) => (
              <button key={a} data-opt role="menuitemradio" aria-checked={a === action} className={`picker-opt ${a === action ? 'on' : ''}`} onClick={() => setAction(a)}>
                <span className="picker-opt-text">
                  <span className="picker-opt-name">{ACTION_LABEL[a]()}</span>
                </span>
                {a === action && <Check size={14} />}
              </button>
            ))}
            <div className="picker-group-head">{tr("Când")}</div>
            <div className="power-when">
              <div className="segmented" role="radiogroup" aria-label={tr("Când")}>
                {KINDS.map((k) => (
                  <button key={k.id} data-opt role="radio" aria-checked={kind === k.id} className={kind === k.id ? 'on' : ''} onClick={() => setKind(k.id)}>
                    {k.label()}
                  </button>
                ))}
              </div>
              {kind === 'done' && (
                <div className="picker-opt-desc">{tr("Pornește doar după ce a început un task și toate conversațiile au fost liniștite 30 de secunde, sau când rămâi fără usage. Apoi ai timp să anulezi.")}</div>
              )}
              {kind === 'in' && (
                <label className="power-field">
                  <input className="input" type="number" min={1} max={1440} value={minutes} onChange={(e) => setMinutes(Math.round(Number(e.target.value)))} onKeyDown={field} />
                  {tr("min")}
                </label>
              )}
              {kind === 'at' && <input className="input power-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} onKeyDown={field} />}
            </div>
            {DESTRUCTIVE.includes(action) && (
              <label className="power-force">
                <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> {tr("Închide forțat aplicațiile deschise")}
              </label>
            )}
          </div>
          <div className="picker-foot power-foot">
            {power.armed && (
              <button className="btn small ghost" onClick={() => void api.power.cancel().then(() => setOpen(false))}>
                {tr("Renunță")}
              </button>
            )}
            <button className="btn small primary" disabled={!ok} onClick={submit}>
              {power.armed ? tr("Actualizează") : tr("Pornește")}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
