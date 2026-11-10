import { Smartphone } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { RemoteStatus } from '@shared/remote'
import { tr } from '@shared/i18n'
import { api, errMsg } from '../store'
import { QrCode } from '../components/QrCode'

/** Use Jolty from a paired phone over Tailscale (main/remote.ts). Only shown in the desktop window. */
export function PhoneSettings() {
  const [st, setSt] = useState<RemoteStatus>()
  const [hidden, setHidden] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [pairing, setPairing] = useState<{ code: string; link?: string; minutes: number }>()
  useEffect(() => {
    const load = (): void => void api.remote.status().then(setSt, () => setHidden(true))
    load()
    return api.remote.onChange(load)
  }, [])
  if (hidden || !st) return null

  const run = async (job: () => Promise<RemoteStatus | void>): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const next = await job()
      if (next) setSt(next)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  // Tailscale answers with a page of the user's own account to switch Serve on, once
  const serveLink = /https:\/\/login\.tailscale\.com\/[^\s]+/.exec(`${error} ${st.error || ''}`)?.[0]
  const tsNote = st.tailscale === 'missing' ? tr("Tailscale nu e instalat pe acest PC. Instalează-l de la tailscale.com, intră în cont, apoi revino aici.") : st.tailscale === 'off' ? tr("Tailscale nu e conectat. Pornește-l și intră în cont.") : ''

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="row" style={{ marginBottom: 10 }}>
        <Smartphone size={16} color="var(--volt)" />
        <b>{tr("Telefon")}</b>
      </div>
      <label className="row" style={{ marginBottom: 12, cursor: 'pointer', gap: 8 }}>
        <input type="checkbox" checked={st.enabled && st.running} disabled={busy || st.tailscale !== 'ready'} onChange={(e) => void run(() => api.remote.enable(e.target.checked))} />
        <span>
          <b>{tr("Folosește Jolty de pe telefon")}</b>
          <span className="muted small" style={{ display: 'block' }}>
            {tr("Telefonul vede aceleași conversații și lucrează pe acest PC, cu toate uneltele lui. Conexiunea trece privat prin Tailscale, fără porturi deschise. Jolty trebuie să rămână pornit pe PC.")}
          </span>
        </span>
      </label>
      {tsNote && <p className="muted small">{tsNote}</p>}
      {serveLink ? (
        <div style={{ marginBottom: 10 }}>
          <p className="muted small" style={{ marginTop: 0 }}>{tr("Tailscale Serve nu e activat în contul tău. Activează-l o dată, apoi bifează din nou.")}</p>
          <button className="btn small" onClick={() => void api.app.openExternal(serveLink)}>
            {tr("Activează Tailscale Serve")}
          </button>
        </div>
      ) : (
        (st.error || error) && <p className="small" style={{ color: 'var(--danger, #ff8a80)' }}>{error || st.error}</p>
      )}
      {st.enabled && st.running && (
        <>
          <div className="row" style={{ gap: 8, marginBottom: 10 }}>
            <button className="btn small" disabled={busy} onClick={() => void run(async () => void setPairing(await api.remote.pair()))}>
              {tr("Împerechează un telefon")}
            </button>
            {st.devices.length > 0 && (
              <button className="btn ghost small" disabled={busy} onClick={() => void run(() => api.remote.disconnect())}>
                {tr("Deconectează telefoanele acum")}
              </button>
            )}
          </div>
          {pairing && (
            <div className="field" style={{ marginBottom: 10 }}>
              <p className="muted small" style={{ marginTop: 0 }}>
                {tr("Scanează codul QR cu camera telefonului (Tailscale trebuie să fie pornit pe el). Codul e valabil {n} minute și merge o singură dată.", { n: pairing.minutes })}
              </p>
              {pairing.link && (
                <div style={{ marginBottom: 8, width: 180, lineHeight: 0 }} title={tr("Scanează cu camera telefonului")}>
                  <QrCode text={pairing.link} size={180} />
                </div>
              )}
              {pairing.link && <input className="input mono" readOnly value={pairing.link} onFocus={(e) => e.currentTarget.select()} style={{ marginBottom: 6 }} />}
              <div className="row" style={{ gap: 8 }}>
                <input className="input mono" readOnly value={pairing.code} style={{ width: 160, letterSpacing: '.12em' }} />
                {pairing.link && (
                  <button className="btn small" onClick={() => void api.app.copyText(pairing.link || '')}>
                    {tr("Copiază linkul")}
                  </button>
                )}
              </div>
            </div>
          )}
          {st.url && !pairing && <p className="muted small mono">{st.url}</p>}
          {st.devices.map((d) => (
            <div key={d.id} className="row" style={{ gap: 8, marginBottom: 6 }}>
              <span style={{ flex: 1 }}>
                <b>{d.name}</b>
                <span className="muted small" style={{ display: 'block' }}>
                  {d.lastSeen ? tr("Văzut ultima dată: {when}", { when: new Date(d.lastSeen).toLocaleString() }) : tr("Încă neconectat")}
                </span>
              </span>
              <button className="btn ghost small" disabled={busy} onClick={() => void run(() => api.remote.revoke(d.id))}>
                {tr("Elimină")}
              </button>
            </div>
          ))}
          <p className="muted small" style={{ marginBottom: 0 }}>{tr("De pe telefon nu se pot porni modurile fără întrebări (Liber în proiect, Fără permisiuni): rămân o alegere făcută la PC.")}</p>
        </>
      )}
    </div>
  )
}
