import { RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { UsageDay, UsageSummary } from '@shared/types'
import { ProfileDot } from '../components/Chat'
import { api, ENGINE_LABEL, errMsg, fmtTokens, fmtUsd, useStore } from '../store'
import { LimitMeters } from './Accounts'
import { dateLocale, tr } from '@shared/i18n'

function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(640)
  useEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.floor(e.contentRect.width))))
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

/** Tokens per day (one series). Today's bar carries the volt signal; hover shows the split. */
function DailyBars({ days }: { days: UsageDay[] }) {
  const [hover, setHover] = useState<number>()
  const [ref, W] = useWidth()
  const H = 170
  const pad = { l: 44, r: 4, t: 8, b: 22 }
  const totals = days.map((d) => d.inputTokens + d.outputTokens)
  const max = Math.max(1, ...totals)
  const niceMax = (() => {
    const p = 10 ** Math.floor(Math.log10(max))
    return Math.ceil(max / p) * p
  })()
  const plotW = W - pad.l - pad.r
  const plotH = H - pad.t - pad.b
  const slot = plotW / days.length
  const bw = Math.min(22, slot * 0.58)
  const y = (v: number): number => pad.t + plotH - (v / niceMax) * plotH
  const h = hover !== undefined ? days[hover] : undefined
  return (
    <div className="chart" ref={ref}>
      <div className="label" style={{ marginBottom: 10 }}>
       {tr("Tokeni pe zi · ultimele 14 zile")}
      </div>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={tr("Tokeni pe zi, ultimele 14 zile")}>
        {[0, niceMax / 2, niceMax].map((t) => (
          <g key={t}>
            <line className="grid-line" x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} />
            <text className="axis" x={pad.l - 8} y={y(t) + 3} textAnchor="end">
              {fmtTokens(t)}
            </text>
          </g>
        ))}
        {days.map((d, i) => {
          const x = pad.l + i * slot + (slot - bw) / 2
          const top = y(totals[i])
          const today = i === days.length - 1
          const active = hover === i
          return (
            <g key={d.day}>
              {totals[i] > 0 && <rect x={x} y={top} width={bw} height={y(0) - top} fill={active || today ? 'var(--volt)' : 'rgba(240,240,240,.82)'} />}
              <text className="axis" x={x + bw / 2} y={H - 6} textAnchor="middle" style={today ? { fill: 'var(--volt)' } : undefined}>
                {i % 2 === days.length % 2 || today ? d.day.slice(8, 10) : ''}
              </text>
              <rect className="bar-hit" x={pad.l + i * slot} y={pad.t} width={slot} height={plotH} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(undefined)} />
            </g>
          )
        })}
      </svg>
      {h && hover !== undefined && (
        <div className="tooltip" style={{ left: pad.l + hover * slot + slot / 2, top: Math.max(56, y(totals[hover]) + 26) }}>
          <b>{new Date(h.day).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'long' })}</b>
          <div>{fmtTokens(h.inputTokens + h.outputTokens)} {tr("tokeni")}</div>
          <div className="faint">
            {fmtTokens(h.inputTokens)} {tr("trimiși ·")} {fmtTokens(h.outputTokens)} {tr("generați")}
          </div>
          {h.costUsd > 0 && <div className="faint">≈ {fmtUsd(h.costUsd)} {tr("la prețuri API")}</div>}
        </div>
      )}
    </div>
  )
}

export function UsagePage() {
  const profiles = useStore((s) => s.profiles)
  const { onEvent, toast } = useStore()
  const [data, setData] = useState<UsageSummary[]>()
  const load = useCallback(async () => {
    const list = await api.usage.summary()
    setData(list)
    for (const u of list) if (u.limits) onEvent({ type: 'limits', snapshot: u.limits })
  }, [onEvent])
  useEffect(() => {
    void load()
  }, [load])

  const refreshAll = async (): Promise<void> => {
    for (const p of profiles.filter((x) => x.auth === 'subscription')) {
      try {
        const snap = await api.usage.refreshLimits(p.id)
        if (snap) onEvent({ type: 'limits', snapshot: snap })
      } catch (err) {
        toast(`${p.name}: ${errMsg(err)}`, true)
      }
    }
    await load()
  }

  const total = (data || []).reduce(
    (a, u) => ({ tokens: a.tokens + u.last30d.tokens, cost: a.cost + u.last30d.costUsd, turns: a.turns + u.last30d.turns }),
    { tokens: 0, cost: 0, turns: 0 }
  )
  return (
    <div className="page">
      <div className="page-inner">
        <div className="row">
          <h1 className="page-title">{tr("Consum")}</h1>
          <div className="spacer" />
          <button className="btn small" onClick={() => void refreshAll()}>
            <RefreshCw size={14} /> {tr("Actualizează limitele")}
          </button>
        </div>
        <p className="lead">
         {tr("Limitele abonamentelor vin direct de la Claude Code și Codex. Tokenii și costul sunt ce a trecut prin Jolty; la abonamente costul e doar o estimare la prețuri API, nu o plată în plus.")}
        </p>
        <div className="stat-strip" style={{ marginTop: 0 }}>
          <div className="stat">
            <div className="k">{tr("Tokeni în 30 de zile")}</div>
            <div className="v">{fmtTokens(total.tokens)}</div>
          </div>
          <div className="stat">
            <div className="k">{tr("Echivalent la prețuri API")}</div>
            <div className="v">{fmtUsd(total.cost)}</div>
          </div>
          <div className="stat">
            <div className="k">{tr("Răspunsuri")}</div>
            <div className="v">{total.turns}</div>
          </div>
        </div>
        <div className="grid">
          {data?.map((u) => {
            const p = profiles.find((x) => x.id === u.profileId)
            if (!p) return null
            const idle = u.last30d.turns === 0 && !u.limits?.windows.length
            return (
              <div className="card" key={u.profileId} style={{ opacity: idle ? 0.7 : 1 }}>
                <div className="row" style={{ marginBottom: 6 }}>
                  <ProfileDot profile={p} size={11} />
                  <b>{p.name}</b>
                  <span className="faint small">{ENGINE_LABEL[p.engine]}</span>
                </div>
                {p.auth === 'subscription' && <LimitMeters profileId={p.id} compact />}
                <div className="stat-strip">
                  {(
                    [
                      ['Ultimele 24 h', u.last24h],
                      [tr("Ultimele 7 zile"), u.last7d],
                      [tr("Ultimele 30 de zile"), u.last30d]
                    ] as const
                  ).map(([k, w]) => (
                    <div className="stat" key={k}>
                      <div className="k">{k}</div>
                      <div className="v">{fmtTokens(w.tokens)}</div>
                      <div className="sub">
                        {w.turns} {tr("răspunsuri")}{w.costUsd > 0 ? ` · ≈ ${fmtUsd(w.costUsd)}` : ''}
                      </div>
                    </div>
                  ))}
                </div>
                {u.last30d.turns > 0 ? (
                  <>
                    <DailyBars days={u.byDay} />
                    {u.byModel.length > 0 && (
                      <table className="table" style={{ marginTop: 12 }}>
                        <thead>
                          <tr>
                            <th>{tr("Model")}</th>
                            <th className="num">{tr("Tokeni (30 zile)")}</th>
                            <th className="num">{tr("≈ la prețuri API")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {u.byModel.map((m) => (
                            <tr key={m.model}>
                              <td className="mono">{m.model}</td>
                              <td className="num">{fmtTokens(m.tokens)}</td>
                              <td className="num">{m.costUsd > 0 ? fmtUsd(m.costUsd) : '-'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </>
                ) : (
                  <div className="faint small">{tr("Nicio activitate prin Jolty în ultimele 30 de zile.")}</div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
