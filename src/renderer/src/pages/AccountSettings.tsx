import { useEffect, useState } from 'react'
import type { UseStats } from '@shared/backup'
import { getLang, tr } from '@shared/i18n'
import { api } from '../store'
import { BackupSettings } from './BackupSettings'

/** "1 month, 11 days (1,000 h)": the time in years, months and days, and the total hours beside it. */
export function fmtSpan(ms: number): string {
  const hours = Math.round(ms / 3_600_000)
  const total = `${hours.toLocaleString(getLang())} h`
  const days = Math.floor(ms / 86_400_000)
  const years = Math.floor(days / 365)
  const months = Math.floor((days % 365) / 30)
  const d = days - years * 365 - months * 30
  const parts = days >= 1 ? { years, months, days: d } : { hours: Math.floor(ms / 3_600_000), minutes: Math.floor((ms % 3_600_000) / 60_000) }
  let text: string
  try {
    text = new (Intl as unknown as { DurationFormat: new (l: string, o: object) => { format(p: object): string } }).DurationFormat(getLang(), { style: 'long' }).format(parts)
  } catch {
    text = Object.entries(parts).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(' ')
  }
  return `${text || `0 ${tr("minute")}`} (${total})`
}

/** The two clocks and a few counts, from the day Jolty began counting. */
function UseTime() {
  const [s, setS] = useState<UseStats>()
  useEffect(() => {
    const load = (): void => void api.usage.time().then(setS).catch(() => undefined)
    load()
    const timer = setInterval(load, 30_000)
    return () => clearInterval(timer)
  }, [])
  if (!s) return null
  const num = (n: number): string => n.toLocaleString(getLang())
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <b>{tr("Timp de utilizare")}</b>
      <div className="use-grid" style={{ marginTop: 12 }}>
        <div className="use-metric">
          <span className="label">{tr("Timp de prompting cu AI")}</span>
          <b>{fmtSpan(s.aiMs)}</b>
        </div>
        <div className="use-metric">
          <span className="label">{tr("Timp petrecut în aplicație")}</span>
          <b>{fmtSpan(s.appMs)}</b>
        </div>
      </div>
      <div className="use-grid" style={{ marginTop: 16 }}>
        <div className="use-metric">
          <span className="label">{tr("Mesaje trimise")}</span>
          <b>{num(s.turns)}</b>
        </div>
        <div className="use-metric">
          <span className="label">{tr("Conversații")}</span>
          <b>{num(s.chats)}</b>
        </div>
        <div className="use-metric">
          <span className="label">{tr("Tokeni procesați")}</span>
          <b>{num(s.tokens)}</b>
        </div>
        <div className="use-metric">
          <span className="label">{tr("Zile active")}</span>
          <b>{num(s.activeDays)}</b>
        </div>
      </div>
      <p className="faint small" style={{ marginBottom: 0 }}>
        {tr("Timpul în aplicație se numără din {date}. Timpul de prompting include o estimare pentru perioada dinainte (pauzele de peste 10 minute nu se iau în calcul).", { date: new Date(s.since).toLocaleDateString(getLang()) })}
      </p>
    </div>
  )
}

/** Settings > Account: the storages the personalization is backed up to, and how long Jolty has been used. */
export function AccountSettings() {
  return (
    <>
      <BackupSettings />
      <UseTime />
    </>
  )
}
