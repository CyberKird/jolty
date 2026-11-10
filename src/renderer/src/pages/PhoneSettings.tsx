import { Check, Copy, Monitor, Smartphone } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { RemoteStatus } from '@shared/remote'
import { tr } from '@shared/i18n'
import { api, errMsg } from '../store'
import { QrCode } from '../components/QrCode'
import { WakeSetup } from './WakeSetup'
import './phone-settings.css'

interface Pairing {
  code: string
  link?: string
  /** when the code stops working */
  until: number
  /** the phones that were paired before, so a new one is recognised */
  known: string[]
}

const clock = (s: number): string => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

/** Use Jolty from a paired phone over Tailscale (main/remote.ts). Only shown in the desktop window. */
export function PhoneSettings() {
  const [st, setSt] = useState<RemoteStatus>()
  const [hidden, setHidden] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [pairing, setPairing] = useState<Pairing>()
  const [left, setLeft] = useState(0)
  const [joined, setJoined] = useState('')
  const [copied, setCopied] = useState(false)
  const total = useRef(300)

  useEffect(() => {
    const load = (): void => void api.remote.status().then(setSt, () => setHidden(true))
    load()
    return api.remote.onChange(load)
  }, [])

  // the code counts down to the second it stops working
  useEffect(() => {
    if (!pairing) return
    const tick = (): void => setLeft(Math.max(0, Math.round((pairing.until - Date.now()) / 1000)))
    tick()
    const t = setInterval(tick, 500)
    return () => clearInterval(t)
  }, [pairing])

  // a phone that used the code: the panel says so and folds away
  useEffect(() => {
    if (!pairing || !st) return
    const fresh = st.devices.find((d) => !pairing.known.includes(d.id))
    if (!fresh) return
    setJoined(fresh.name)
    setPairing(undefined)
    const t = setTimeout(() => setJoined(''), 3600)
    return () => clearTimeout(t)
  }, [st, pairing])

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

  const pair = async (): Promise<void> => {
    setBusy(true)
    setError('')
    setJoined('')
    try {
      const p = await api.remote.pair()
      total.current = p.minutes * 60
      setPairing({ code: p.code, link: p.link, until: Date.now() + p.minutes * 60_000, known: st.devices.map((d) => d.id) })
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  const copy = async (): Promise<void> => {
    if (!pairing?.link) return
    await api.app.copyText(pairing.link)
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  // Tailscale answers with a page of the user's own account to switch Serve on, once
  const serveLink = /https:\/\/login\.tailscale\.com\/[^\s]+/.exec(`${error} ${st.error || ''}`)?.[0]
  const tsNote = st.tailscale === 'missing' ? tr("Tailscale nu e instalat pe acest PC. Instalează-l de la tailscale.com, intră în cont, apoi revino aici.") : st.tailscale === 'off' ? tr("Tailscale nu e conectat. Pornește-l și intră în cont.") : ''
  const on = st.enabled && st.running
  const online = st.devices.filter((d) => d.online).length
  const expired = Boolean(pairing) && left === 0
  const R = 46
  const ring = pairing ? (left / total.current) * 2 * Math.PI * R : 0

  return (
    <div className="card ph" style={{ marginBottom: 14 }}>
      <div className="ph-head">
        <span className={`ph-icon ${on ? 'on' : ''}`}>
          <Smartphone size={17} />
          {online > 0 && <i className="ph-live" />}
        </span>
        <b>{tr("Telefon")}</b>
        {on && online > 0 && (
          <span className="ph-pill">
            <i /> {tr("Conectat acum")}
          </span>
        )}
      </div>

      <label className="row" style={{ marginBottom: 12, cursor: 'pointer', gap: 8 }}>
        <input type="checkbox" checked={on} disabled={busy || st.tailscale !== 'ready'} onChange={(e) => void run(() => api.remote.enable(e.target.checked))} />
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

      {on && (
        <>
          <ol className="ph-steps" aria-label={tr("Conexiune")}>
            {[tr("Tailscale conectat"), tr("Serverul rulează"), tr("Adresa privată e gata")].map((label, i) => (
              <li key={label} style={{ animationDelay: `${i * 140}ms` }}>
                <span className="ph-tick">
                  <Check size={11} strokeWidth={3} />
                </span>
                {label}
              </li>
            ))}
          </ol>

          <div className="ph-actions">
            <button className="btn primary small" disabled={busy} onClick={() => void pair()}>
              <Smartphone size={14} /> {tr("Împerechează un telefon")}
            </button>
            {st.devices.length > 0 && (
              <button className="btn ghost small" disabled={busy} onClick={() => void run(() => api.remote.disconnect())}>
                {tr("Deconectează telefoanele acum")}
              </button>
            )}
          </div>

          <div className={`ph-collapse ${pairing || joined ? 'open' : ''}`}>
            <div className="ph-collapse-in">
              {joined ? (
                <div className="ph-done" role="status">
                  <span className="ph-done-mark">
                    <Check size={26} strokeWidth={3} />
                  </span>
                  <b>{tr("{name} s-a conectat", { name: joined })}</b>
                  <span className="muted small">{tr("Gata, poți folosi Jolty de pe telefon.")}</span>
                </div>
              ) : (
                pairing && (
                  <div className={`ph-pair ${expired ? 'expired' : ''}`}>
                    <div className="ph-qr" title={tr("Scanează cu camera telefonului")}>
                      <span className="ph-corner a" />
                      <span className="ph-corner b" />
                      <span className="ph-corner c" />
                      <span className="ph-corner d" />
                      {pairing.link ? <QrCode text={pairing.link} size={176} /> : <div className="ph-qr-empty" />}
                      {!expired && <span className="ph-scan" />}
                    </div>
                    <div className="ph-side">
                      <p className="muted small" style={{ margin: 0 }}>
                        {tr("Scanează codul QR cu camera telefonului (Tailscale trebuie să fie pornit pe el). Codul e valabil {n} minute și merge o singură dată.", { n: Math.round(total.current / 60) })}
                      </p>
                      <div className="ph-code" aria-label={tr("Cod de împerechere")}>
                        {pairing.code.slice(0, 5)}
                        <i /> {pairing.code.slice(5)}
                      </div>
                      <div className="ph-timer">
                        <svg viewBox="0 0 100 100" width="34" height="34" aria-hidden>
                          <circle cx="50" cy="50" r={R} className="ph-ring-bg" />
                          <circle cx="50" cy="50" r={R} className="ph-ring" strokeDasharray={`${ring} 999`} />
                        </svg>
                        <span>{expired ? tr("Codul a expirat") : tr("Valabil încă {t}", { t: clock(left) })}</span>
                      </div>
                      <div className="ph-actions">
                        {expired ? (
                          <button className="btn primary small" disabled={busy} onClick={() => void pair()}>
                            {tr("Cod nou")}
                          </button>
                        ) : (
                          <button className="btn small" onClick={() => void copy()}>
                            {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? tr("Copiat") : tr("Copiază linkul")}
                          </button>
                        )}
                        <button className="btn ghost small" onClick={() => setPairing(undefined)}>
                          {tr("Închide")}
                        </button>
                      </div>
                    </div>
                  </div>
                )
              )}
            </div>
          </div>

          <label className="row ph-screen" style={{ gap: 8, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={st.screen.allowed}
              onChange={async (e) => {
                await api.app.saveSettings({ remoteScreen: e.target.checked })
                setSt(await api.remote.status())
              }}
            />
            <Monitor size={15} style={{ flex: 'none', marginTop: 2 }} />
            <span>
              <b>{tr("Permite ecranul PC-ului pe telefon")}</b>
              <span className="muted small" style={{ display: 'block' }}>
                {tr("Telefonul poate vedea acest ecran și folosi mouse-ul și tastatura. Ctrl+Alt+Esc îl oprește oricând.")}
              </span>
            </span>
          </label>

          <WakeSetup />

          <div className="ph-list-head">{tr("Dispozitive împerecheate")}</div>
          {st.devices.length === 0 && <p className="muted small" style={{ margin: 0 }}>{tr("Niciun telefon împerecheat încă")}</p>}
          {st.devices.map((d) => (
            <div key={d.id} className="ph-device">
              <span className={`ph-dev-icon ${d.online ? 'on' : ''}`}>
                <Smartphone size={16} />
              </span>
              <span className="ph-dev-text">
                <b>{d.name}</b>
                <span className="muted small">
                  {d.online ? tr("Conectat acum") : d.lastSeen ? tr("Văzut ultima dată: {when}", { when: new Date(d.lastSeen).toLocaleString() }) : tr("Încă neconectat")}
                </span>
              </span>
              <button className="btn ghost small" disabled={busy} onClick={() => void run(() => api.remote.revoke(d.id))}>
                {tr("Elimină")}
              </button>
            </div>
          ))}
        </>
      )}
    </div>
  )
}
