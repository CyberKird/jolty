import { Check, Copy, ExternalLink, Globe, KeyRound } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AppSettings, BrowserApp, BrowserInfo, BrowserMode, NativeBrowserStatus } from '@shared/types'
import { api, errMsg, useStore } from '../store'
import { tr } from '@shared/i18n'

const MODES: { id: BrowserMode; label: string }[] = [
  { id: 'jolty', label: tr("Extensia Jolty (recomandat)") },
  { id: 'auto', label: tr("Extensia Playwright, tab propriu") },
  { id: 'pick', label: tr("Extensia Playwright, aleg eu tabul") },
  { id: 'own', label: tr("Fereastră Jolty, profil separat") }
]

function Status({ st }: { st?: NativeBrowserStatus }) {
  const state = !st ? 'wait' : st.connected ? 'on' : st.installed ? 'off' : 'none'
  const text =
    state === 'on'
      ? tr("Conectată la browser (versiunea {v})", { v: st?.version || '?' })
      : state === 'off'
        ? tr("Instalată, dar browserul nu e conectat. Deschide browserul sau apasă pe iconița extensiei și pe Reconectează.")
        : state === 'none'
          ? tr("Nu e instalată încă în browser.")
          : tr("Verific…")
  return (
    <div className="row" style={{ gap: 8, marginBottom: 12 }}>
      <span className="dot" style={{ width: 9, height: 9, background: state === 'on' ? 'var(--volt)' : 'var(--critical)' }} />
      <b>{tr("Extensia Jolty")}</b>
      <span className="muted small">{text}</span>
    </div>
  )
}

export function BrowserSettings({ s, setS }: { s: AppSettings; setS: (v: AppSettings) => void }) {
  const { toast } = useStore()
  const [info, setInfo] = useState<BrowserInfo>()
  const [native, setNative] = useState<NativeBrowserStatus>()
  const [hasToken, setHasToken] = useState(false)
  const [token, setToken] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    void api.browser.hasToken().then(setHasToken)
    void api.browser.info().then(setInfo)
    const poll = (): void => void api.browser.native().then(setNative)
    poll()
    const t = setInterval(poll, 2000)
    return () => clearInterval(t)
  }, [])

  const mode = info?.mode || s.browserMode || 'jolty'
  const browserName = info?.installed.find((b) => b.id === info.active)?.name || tr("browser")

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="row" style={{ marginBottom: 10 }}>
        <Globe size={16} color="var(--volt)" />
        <b>{tr("Jolty în browser")}</b>
      </div>
      <p className="muted small" style={{ marginTop: 0 }}>
        {tr("Cu butonul Browser din conversație, modelul lucrează în browserul tău, cu login-urile tale: deschide pagini, dă clic, completează formulare, citește și face capturi. Merge cu orice model din Jolty. Te întreabă înainte să trimită, să cumpere sau să posteze ceva.")}
      </p>
      <div className="field">
        <label>{tr("Cum se conectează")}</label>
        <select
          className="select"
          value={mode}
          onChange={async (e) => {
            setS(await api.app.saveSettings({ browserMode: e.target.value as BrowserMode }))
            setInfo(await api.browser.info())
          }}
        >
          {MODES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>{tr("Browser")}</label>
        <select
          className="select"
          value={s.browserApp || ''}
          onChange={async (e) => {
            const browserApp = (e.target.value || undefined) as BrowserApp | undefined
            setS(await api.app.saveSettings({ browserApp }))
            setInfo(await api.browser.info())
          }}
        >
          <option value="">
            {tr("Browserul implicit din Windows")}
            {info?.defaultApp ? ` (${info.installed.find((b) => b.id === info.defaultApp)?.name || info.defaultApp})` : ''}
          </option>
          {info?.installed.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        <div className="hint">{tr("Merge cu orice browser construit pe Chromium: Chrome, Vivaldi, Edge, Brave.")}</div>
      </div>

      {mode === 'jolty' ? (
        <>
          <Status st={native} />
          {native?.connected ? (
            <p className="muted small" style={{ marginTop: 0 }}>
              {tr("Modelul lucrează într-o fereastră separată, deschisă de el, ca să nu-ți atingă tab-urile. Dacă îi ceri să lucreze pe pagina pe care o ai deschisă, o preia doar cu acordul tău. Cât lucrează, browserul arată o bară „depanează acest browser”: e normală și nu poate fi ascunsă.")}
            </p>
          ) : (
            <>
              <ol className="muted small steps">
                <li>
                  {tr("Apasă Instalează: pun fișierele extensiei într-un folder și deschid pagina de extensii din {name}.", { name: browserName })}{' '}
                  <button
                    className="btn small"
                    onClick={async () => {
                      try {
                        setNative(await api.browser.installNative())
                      } catch (e) {
                        toast(errMsg(e), true)
                      }
                    }}
                  >
                    <ExternalLink size={13} /> {native?.installed ? tr("Deschide pagina de extensii") : tr("Instalează extensia")}
                  </button>
                </li>
                <li>{tr("Pe pagina de extensii pornește „Mod dezvoltator” (colț dreapta sus).")}</li>
                <li>
                  {tr("Apasă „Încarcă nepachetată” și alege folderul:")}
                  {native?.dir && (
                    <span className="row" style={{ gap: 8, marginTop: 4 }}>
                      <code className="mono small">{native.dir}</code>
                      <button
                        className="btn ghost small"
                        onClick={() => {
                          void navigator.clipboard.writeText(native.dir)
                          setCopied(true)
                          setTimeout(() => setCopied(false), 1500)
                        }}
                      >
                        {copied ? <Check size={13} /> : <Copy size={13} />}
                      </button>
                    </span>
                  )}
                </li>
                <li>{tr("Gata: starea de mai sus devine „Conectată”. Se face o singură dată; după aceea extensia se conectează singură și se actualizează odată cu Jolty.")}</li>
              </ol>
            </>
          )}
        </>
      ) : (
        <>
          {mode !== 'own' && (
            <>
              <p className="muted small" style={{ marginTop: 0 }}>
                {info?.extension ? tr("Extensia Playwright e instalată în browserul ales.") : tr("Extensia Playwright nu e instalată în browserul ales.")}{' '}
                <button className="btn small" onClick={() => void api.browser.openExtensionPage()}>
                  <ExternalLink size={13} /> {tr("Deschide în Chrome Web Store")}
                </button>
              </p>
              <div className="field">
                <label>
                  <KeyRound size={12} /> {tr("Token extensie")} {hasToken ? tr("(salvat; lasă gol ca să-l păstrezi)") : ''}
                </label>
                <div className="row" style={{ gap: 8 }}>
                  <input className="input mono" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={tr("din pagina extensiei Playwright")} />
                  <button
                    className="btn small"
                    disabled={!token.trim()}
                    onClick={async () => {
                      try {
                        await api.browser.setToken(token)
                        setToken('')
                        setHasToken(true)
                        toast(tr("Token salvat și aplicat. Conversațiile cu Browser pornit îl folosesc acum."))
                      } catch (e) {
                        toast(errMsg(e), true)
                      }
                    }}
                  >
                    {tr("Salvează")}
                  </button>
                  {hasToken && (
                    <button
                      className="btn ghost small"
                      onClick={async () => {
                        await api.browser.setToken('')
                        setHasToken(false)
                        toast(tr("Token șters"))
                      }}
                    >
                      {tr("Șterge")}
                    </button>
                  )}
                </div>
              </div>
            </>
          )}
          <div className="field" style={{ marginBottom: 12 }}>
            <label>{tr("Profil din browser (opțional)")}</label>
            <input
              className="input mono"
              value={s.browserProfileDir || ''}
              placeholder={tr("ultimul profil folosit, de ex. Default sau Profile 1")}
              onChange={(e) => setS({ ...s, browserProfileDir: e.target.value || undefined })}
            />
          </div>
        </>
      )}

      <label className="row" style={{ marginBottom: 0, cursor: 'pointer', gap: 8 }}>
        <input type="checkbox" checked={s.browserOverlay !== false} onChange={async (e) => setS(await api.app.saveSettings({ browserOverlay: e.target.checked }))} />
        <span>
          <b>{tr("Arată ce face modelul în pagină")}</b>
          <span className="muted small" style={{ display: 'block' }}>
            {tr("Halou verde în jurul paginii, cursor „Jolty” care merge la element înainte de clic și un fulger pe tab cât timp lucrează.")}
          </span>
        </span>
      </label>
    </div>
  )
}
