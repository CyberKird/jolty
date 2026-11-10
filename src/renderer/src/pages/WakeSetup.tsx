import { Check, ChevronDown, Copy, Power } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { WakeStatus, WakeTest } from '@shared/remote'
import { tr } from '@shared/i18n'
import { api, errMsg } from '../store'

const SCRIPT = 'https://raw.githubusercontent.com/CyberKird/jolty/main/tools/wake-agent.py'
const PORT = 8787

/** Starting the PC from the phone while it is off: three steps on a device that stays on in the same network, free, no server in the cloud. */
export function WakeSetup() {
  const [w, setW] = useState<WakeStatus>()
  const [open, setOpen] = useState(false)
  const [mac, setMac] = useState('')
  const [url, setUrl] = useState('')
  const [test, setTest] = useState<WakeTest>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState('')

  useEffect(() => {
    if (!open || w) return
    void api.remote.wakeStatus().then((s) => {
      setW(s)
      setUrl(s.url)
      setMac(s.macs[0]?.mac || '')
    })
  }, [open, w])

  const copy = async (id: string, text: string): Promise<void> => {
    await api.app.copyText(text)
    setCopied(id)
    setTimeout(() => setCopied(''), 1500)
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    setError('')
    setTest(undefined)
    try {
      const s = await api.remote.wakeSet(url)
      setW(s)
      setUrl(s.url)
      if (s.url) setTest(await api.remote.wakeTest())
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  const args = w && mac ? `--mac ${mac} --token ${w.token} --origin ${w.origin}` : ''
  const run = `curl -fsSL ${SCRIPT} -o ~/jolty-wake.py && nohup python3 ~/jolty-wake.py ${args} >/dev/null 2>&1 &`
  const keep = `(crontab -l 2>/dev/null; echo "@reboot nohup python3 $HOME/jolty-wake.py ${args} >/dev/null 2>&1 &") | crontab -`
  const serve = `tailscale serve --bg --https=8443 http://127.0.0.1:${PORT}`
  const ready = Boolean(w?.origin && mac)

  const Cmd = ({ id, text }: { id: string; text: string }) => (
    <div className="wk-cmd">
      <code>{text}</code>
      <button className="btn small" onClick={() => void copy(id, text)} disabled={!ready} aria-label={tr("Copiază")}>
        {copied === id ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </div>
  )

  return (
    <div className="wk">
      <button className="wk-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Power size={15} />
        <span>
          <b>{tr("Pornește PC-ul de pe telefon")}</b>
          <span className="muted small" style={{ display: 'block' }}>
            {tr("Un PC oprit nu poate răspunde: o scriptă mică pe un dispozitiv care rămâne pornit în aceeași rețea îi trimite semnalul. Gratuit, fără server în cloud.")}
          </span>
        </span>
        <ChevronDown size={16} className={open ? 'up' : ''} />
      </button>
      <div className={`ph-collapse ${open ? 'open' : ''}`}>
        <div className="ph-collapse-in">
          {w && (
            <ol className="wk-steps">
              <li>
                <b>{tr("Placa de rețea a acestui PC")}</b>
                {w.macs.length > 0 ? (
                  <select className="select" value={mac} onChange={(e) => setMac(e.target.value)}>
                    {w.macs.map((m) => (
                      <option key={m.mac} value={m.mac}>
                        {m.name} · {m.mac} · {m.ip}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="muted small">{tr("Nu am găsit nicio placă de rețea.")}</span>
                )}
                <span className="muted small">{tr("În BIOS pornește Wake on LAN (uneori „Power on by PCIe”), iar în Windows oprește Fast Startup.")}</span>
              </li>
              <li>
                <b>{tr("Pe dispozitivul care stă mereu pornit (Raspberry Pi, NAS, alt PC cu Linux și Tailscale), rulează:")}</b>
                {!w.origin && <span className="muted small">{tr("Mai întâi pornește „Folosește Jolty de pe telefon” și activează Tailscale Serve.")}</span>}
                <Cmd id="run" text={run} />
                <span className="muted small">{tr("Ca să pornească singur după o repornire:")}</span>
                <Cmd id="keep" text={keep} />
                <span className="muted small">{tr("Apoi, o singură dată, ca telefonul să-l poată atinge doar prin Tailscale:")}</span>
                <Cmd id="serve" text={serve} />
              </li>
              <li>
                <b>{tr("Adresa agentului")}</b>
                <div className="wk-url">
                  <input className="input mono" value={url} placeholder="https://cutia-mea.tailnet.ts.net:8443" onChange={(e) => setUrl(e.target.value)} spellCheck={false} autoCapitalize="none" />
                  <button className="btn primary small" disabled={busy} onClick={() => void save()}>
                    {tr("Salvează și testează")}
                  </button>
                </div>
                {error && <span className="small" style={{ color: 'var(--danger, #ff8a80)' }}>{error}</span>}
                {test && (
                  <span className={`wk-test small ${test.ok ? 'ok' : 'bad'}`}>
                    {test.ok ? (test.mac && mac && test.mac.toUpperCase() !== mac.toUpperCase() ? tr("Agentul răspunde, dar pornit cu altă placă ({mac}). Rulează din nou comanda de la pasul 2.", { mac: test.mac }) : tr("Agentul răspunde și știe ce PC să pornească.")) : test.error}
                  </span>
                )}
              </li>
            </ol>
          )}
        </div>
      </div>
    </div>
  )
}
