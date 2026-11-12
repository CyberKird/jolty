import { LogIn, LogOut, RefreshCw, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/shallow'
import type { Profile } from '@shared/types'
import { tr } from '@shared/i18n'
import { api, errMsg, resetAt, resetIn, useStore } from '../store'

/**
 * The limit resets and promotions of a Claude account ("Full reset", "Fable reset"), as claude.ai lists them. They are only read
 * with that account's own claude.ai session, so each profile has its own sign-in: a window the person fills in, kept apart per profile.
 */
export function LimitResets({ profile, compact }: { profile: Profile; compact?: boolean }) {
  const { info, resets, load, toast } = useStore(
    useShallow((s) => ({ info: s.claudeWeb[profile.id], resets: s.resets[profile.id], load: s.loadClaudeWeb, toast: s.toast }))
  )
  const [busy, setBusy] = useState<'connect' | 'refresh' | undefined>()
  useEffect(() => void load(), [load])
  const grants = resets?.grants ?? []
  const ok = Boolean(info?.connected && !info.problem)
  const run = (kind: 'connect' | 'refresh', job: () => Promise<unknown>): void => {
    setBusy(kind)
    job()
      .catch((e) => toast(errMsg(e), true))
      .finally(() => setBusy(undefined))
  }

  if (compact) {
    if (!ok || !grants.length) return null
    return (
      <div className="faint small reset-line" title={grants.map((g) => g.label).join('\n')}>
        {tr("Resetări de limită")}: {grants.length} · {tr("Expiră {when}", { when: resetAt(grants[0].endsAt) })}
      </div>
    )
  }
  return (
    <div className="resets">
      <div className="meter-head">
        <span>{tr("Resetări de limită")}</span>
        {ok && (
          <span className="row" style={{ gap: 6 }}>
            <button className="btn small icon" title={tr("Actualizează resetările")} aria-label={tr("Actualizează resetările")} disabled={busy !== undefined} onClick={() => run('refresh', () => api.claudeWeb.refresh(profile.id))}>
              {busy === 'refresh' ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
            </button>
            <button className="btn small" title={info?.email} onClick={() => void api.claudeWeb.disconnect(profile.id)}>
              <LogOut size={13} /> {tr("Deconectează claude.ai")}
            </button>
          </span>
        )}
      </div>
      {ok && !grants.length && <div className="faint small">{tr("Contul nu are resetări acum.")}</div>}
      {ok &&
        grants.map((g) => (
          <div className="reset-row" key={g.id}>
            <div className="reset-main">
              <b>{g.full ? tr("Reset complet") : tr("Reset parțial")}</b>
              {g.total > 1 && <span className="faint small"> {tr("{left} din {total}", { left: g.left, total: g.total })}</span>}
              <div className="faint small">{g.label}</div>
            </div>
            <div className="reset-when small" title={g.endsAt ? resetIn(g.endsAt) : undefined}>
              {g.endsAt ? tr("Expiră {when}", { when: resetAt(g.endsAt) }) : ''}
              {!g.usableNow && <div className="faint">{tr("Nu se poate folosi acum")}</div>}
            </div>
          </div>
        ))}
      {!ok && (
        <>
          <div className="faint small">
            {info?.problem === 'signin'
              ? tr("Sesiunea claude.ai a expirat. Conectează-te din nou.")
              : info?.problem === 'account'
                ? tr("Sesiunea claude.ai e pe alt cont ({email}). Conectează-l pe cel al acestui profil.", { email: info.email ?? '' })
                : tr("Resetările și promoțiile contului vin de la claude.ai. Te conectezi o dată, într-o fereastră Jolty, doar pentru acest cont.")}
          </div>
          <div style={{ marginTop: 8 }}>
            <button className="btn small" disabled={busy !== undefined} onClick={() => run('connect', () => api.claudeWeb.connect(profile.id))}>
              {busy === 'connect' ? <Loader2 size={13} className="spin" /> : <LogIn size={13} />} {tr("Conectează claude.ai")}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
