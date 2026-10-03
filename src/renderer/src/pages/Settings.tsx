import { ExternalLink, Eye, FolderOpen, Globe, KeyRound, Save, ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AppSettings, BrowserApp, BrowserInfo } from '@shared/types'
import { api, errMsg, timeAgo, useStore } from '../store'

export function SettingsPage() {
  const profiles = useStore((s) => s.profiles)
  const { toast } = useStore()
  const [s, setS] = useState<AppSettings>()
  const [version, setVersion] = useState('')
  const [hasToken, setHasToken] = useState(false)
  const [token, setToken] = useState('')
  const [browserInfo, setBrowserInfo] = useState<BrowserInfo>()
  useEffect(() => {
    void api.app.settings().then(setS)
    void api.app.version().then(setVersion)
    void api.browser.hasToken().then(setHasToken)
    void api.browser.info().then(setBrowserInfo)
  }, [])
  if (!s) return null
  const visionCandidates = profiles.filter((p) => p.engine !== 'hermes' && (p.auth !== 'endpoint' || p.vision))
  return (
    <div className="page">
      <div className="page-inner narrow">
        <h1 className="page-title">Setări</h1>
        <p className="lead">Jolty {version}</p>
        <UpdatesCard />
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="row" style={{ marginBottom: 10 }}>
            <Eye size={16} color="var(--volt)" />
            <b>Imagini pentru modelele care nu văd</b>
          </div>
          <p className="muted small" style={{ marginTop: 0 }}>
            Când trimiți o imagine unui model fără vision (de exemplu DeepSeek sau un model local mic), profilul de aici o descrie în detaliu (text exact, interfață, cod, erori), iar modelul tău primește descrierea.
          </p>
          <select className="select" value={s.visionProfileId || ''} onChange={(e) => setS({ ...s, visionProfileId: e.target.value || undefined })}>
            <option value="">Automat (primul profil Claude)</option>
            {visionCandidates.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="row" style={{ marginBottom: 10 }}>
            <ShieldCheck size={16} color="var(--volt)" />
            <b>Confidențialitate</b>
          </div>
          <p className="muted small" style={{ marginTop: 0 }}>
            Jolty nu trimite nicio statistică. Pornește Claude Code și Codex cu telemetria, rapoartele de erori, sondajele de feedback și traficul neesențial oprite. Conversațiile, cheile și consumul rămân doar pe PC-ul tău.
          </p>
          <p className="muted small">
            Folosirea conversațiilor pentru antrenarea modelelor se setează în contul fiecărui furnizor, nu în aplicație. Oprește-o o singură dată pe fiecare cont:
          </p>
          <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <button className="btn small" onClick={() => void api.app.openExternal('https://claude.ai/settings/data-privacy-controls')} title="Oprește „Help improve Claude”">
              <ExternalLink size={13} /> Claude: confidențialitate
            </button>
            <button className="btn small" onClick={() => void api.app.openExternal('https://chatgpt.com/#settings/DataControls')} title="Oprește „Improve the model for everyone”">
              <ExternalLink size={13} /> ChatGPT: controlul datelor
            </button>
          </div>
          <p className="faint small" style={{ marginBottom: 0 }}>
            Cheile API Anthropic și OpenAI nu sunt folosite pentru antrenare implicit. Furnizorii compatibili (DeepSeek, MiMo, OpenRouter) au propriile reguli, iar modelele locale prin Ollama nu trimit nimic în afara PC-ului.
          </p>
        </div>
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="row" style={{ marginBottom: 10 }}>
            <Globe size={16} color="var(--volt)" />
            <b>Jolty în browser</b>
          </div>
          <div className="field">
            <label>Browser</label>
            <select
              className="select"
              value={s.browserApp || ''}
              onChange={async (e) => {
                const browserApp = (e.target.value || undefined) as BrowserApp | undefined
                setS(await api.app.saveSettings({ browserApp }))
                setBrowserInfo(await api.browser.info())
              }}
            >
              <option value="">
                Browserul implicit din Windows
                {browserInfo?.defaultApp ? ` (${browserInfo.installed.find((b) => b.id === browserInfo.defaultApp)?.name || browserInfo.defaultApp})` : ''}
              </option>
              {browserInfo?.installed.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
            <div className="hint">
              Merge cu orice browser construit pe Chromium: Chrome, Vivaldi, Edge, Brave. Extensia se instalează din Chrome Web Store și în Vivaldi.
              {browserInfo?.active && (
                <>
                  {' '}
                  <b>{browserInfo.extension ? 'Extensia e instalată în browserul ales.' : 'Extensia nu e instalată în browserul ales.'}</b>
                </>
              )}
            </div>
          </div>
          <p className="muted small" style={{ marginTop: 0 }}>
            Cu butonul Browser din conversație, modelul lucrează în browserul tău, cu login-urile tale: deschide pagini, dă clic, completează formulare, citește și face capturi. Merge cu orice model din Jolty. Te întreabă înainte să trimită, să cumpere sau să posteze ceva.
          </p>
          <ol className="muted small steps">
            <li>
              Instalează extensia oficială Playwright în browserul ales.{' '}
              <button className="btn small" onClick={() => void api.browser.openExtensionPage()}>
                <ExternalLink size={13} /> Deschide în Chrome Web Store
              </button>
            </li>
            <li>La prima folosire, browserul îți arată o pagină unde alegi tabul la care are acces modelul.</li>
            <li>Opțional: ca să nu mai alegi de fiecare dată, copiază tokenul din pagina extensiei și pune-l aici.</li>
          </ol>
          <div className="field">
            <label>
              <KeyRound size={12} /> Token extensie {hasToken ? '(salvat; lasă gol ca să-l păstrezi)' : ''}
            </label>
            <div className="row" style={{ gap: 8 }}>
              <input className="input mono" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="din pagina extensiei Playwright" />
              <button
                className="btn small"
                disabled={!token.trim()}
                onClick={async () => {
                  try {
                    await api.browser.setToken(token)
                    setToken('')
                    setHasToken(true)
                    toast('Token salvat și aplicat. Conversațiile cu Browser pornit îl folosesc acum.')
                  } catch (e) {
                    toast(errMsg(e), true)
                  }
                }}
              >
                Salvează
              </button>
              {hasToken && (
                <button
                  className="btn ghost small"
                  onClick={async () => {
                    await api.browser.setToken('')
                    setHasToken(false)
                    toast('Token șters')
                  }}
                >
                  Șterge
                </button>
              )}
            </div>
          </div>
          <label className="row" style={{ marginBottom: 12, cursor: 'pointer', gap: 8 }}>
            <input
              type="checkbox"
              checked={s.browserOverlay !== false}
              onChange={async (e) => setS(await api.app.saveSettings({ browserOverlay: e.target.checked }))}
            />
            <span>
              <b>Arată ce face modelul în pagină</b>
              <span className="muted small" style={{ display: 'block' }}>
                Halou verde în jurul paginii, cursor „Jolty” care merge la element înainte de clic și un fulger pe tab cât timp lucrează.
              </span>
            </span>
          </label>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Profil din browser (opțional)</label>
            <input
              className="input mono"
              value={s.browserProfileDir || ''}
              placeholder="ultimul profil folosit, de ex. Default sau Profile 1"
              onChange={(e) => setS({ ...s, browserProfileDir: e.target.value || undefined })}
            />
          </div>
        </div>
        <label className="card row" style={{ marginBottom: 14, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={Boolean(s.reduceMotion)}
            onChange={async (e) => {
              const reduceMotion = e.target.checked
              document.documentElement.classList.toggle('reduce-motion', reduceMotion)
              setS(await api.app.saveSettings({ reduceMotion }))
            }}
          />
          <span>
            <b>Reduce mișcarea</b>
            <span className="muted small" style={{ display: 'block' }}>
              Fără animații: panourile, meniurile și paginile apar instant.
            </span>
          </span>
        </label>
        <label className="card row" style={{ marginBottom: 14, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={s.protectSecretFiles !== false}
            onChange={async (e) => setS(await api.app.saveSettings({ protectSecretFiles: e.target.checked }))}
          />
          <span>
            <b>Întreabă înainte să atingă fișiere cu secrete</b>
            <span className="muted small" style={{ display: 'block' }}>
              Claude cere acordul tău înainte să citească sau să modifice .env, chei private, secrets.json și ~/.ssh, chiar și în modurile fără întrebări. Poți răspunde „da” oricând, nu e interzis. Se aplică la sesiunile pornite după schimbare.
            </span>
          </span>
        </label>
        <div className="card" style={{ marginBottom: 14 }}>
          <b>Motoare</b>
          <p className="muted small">Claude Code și Codex sunt incluse. Hermes folosește instalarea de pe PC. Completează doar dacă vrei alt executabil.</p>
          <div className="field">
            <label>Claude Code (claude.exe)</label>
            <input className="input mono" value={s.claudePath || ''} placeholder="versiunea inclusă" onChange={(e) => setS({ ...s, claudePath: e.target.value || undefined })} />
          </div>
          <div className="field">
            <label>Codex (codex.exe)</label>
            <input className="input mono" value={s.codexPath || ''} placeholder="versiunea inclusă" onChange={(e) => setS({ ...s, codexPath: e.target.value || undefined })} />
          </div>
          <div className="field">
            <label>Hermes ACP (hermes-acp.exe)</label>
            <input className="input mono" value={s.hermesPath || ''} placeholder="instalarea existentă" onChange={(e) => setS({ ...s, hermesPath: e.target.value || undefined })} />
          </div>
        </div>
        <div className="row">
          <button className="btn" onClick={() => void api.app.openPath(s.dataDir)} title={s.dataDir}>
            <FolderOpen size={14} /> Deschide datele Jolty
          </button>
          <div className="spacer" />
          <button
            className="btn primary"
            onClick={async () => {
              await api.app.saveSettings(s)
              toast('Setări salvate')
            }}
          >
            <Save size={14} /> Salvează
          </button>
        </div>
      </div>
    </div>
  )
}

function UpdatesCard() {
  const update = useStore((s) => s.update)
  const { onEvent } = useStore()
  const [busy, setBusy] = useState(false)
  const text =
    update?.state === 'ready'
      ? `Jolty ${update.version} e descărcat. Repornește ca să-l instalezi, sau se instalează când închizi aplicația.`
      : update?.state === 'downloading'
        ? `Descarc Jolty ${update.version || ''}: ${update.percent ?? 0}%.`
        : update?.state === 'checking'
          ? 'Caut o versiune nouă…'
          : update?.state === 'latest'
            ? `Ai ultima versiune.${update.checkedAt ? ` Verificat ${timeAgo(update.checkedAt)}.` : ''}`
            : update?.state === 'error'
              ? `Verificarea nu a mers: ${update.error}`
              : update?.state === 'dev'
                ? 'Versiune de dezvoltare: actualizările vin doar în aplicația instalată.'
                : 'Jolty caută singur versiuni noi la pornire și la câteva ore, le descarcă în fundal și te anunță.'
  return (
    <div className="card row" style={{ marginBottom: 14, gap: 14, flexWrap: 'wrap' }}>
      <div style={{ flex: 1, minWidth: 240 }}>
        <b>Actualizări</b>
        <div className="muted small" style={{ marginTop: 4 }}>
          {text}
        </div>
      </div>
      {update?.state === 'ready' ? (
        <button className="btn primary small" onClick={() => void api.updates.install()}>
          Repornește și actualizează
        </button>
      ) : (
        <button
          className="btn small"
          disabled={busy || update?.state === 'checking' || update?.state === 'downloading'}
          onClick={async () => {
            setBusy(true)
            try {
              onEvent({ type: 'update', status: await api.updates.check() })
            } finally {
              setBusy(false)
            }
          }}
        >
          Caută acum
        </button>
      )}
    </div>
  )
}
