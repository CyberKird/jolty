import { Cpu, ExternalLink, Eye, FolderOpen, Gauge, Globe, Info, Languages, Save, ShieldCheck, Sparkles, SlidersHorizontal } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AppSettings } from '@shared/types'
import { isAcp } from '@shared/types'
import { BrowserSettings } from './BrowserSettings'
import { ComputerSettings } from './ComputerSettings'
import { ChildSessionsSettings } from './ChildSessionsSettings'
import { api, timeAgo, useStore } from '../store'
import { setMascot } from '../mascot/Mascot'
import { openWhatsNew } from '../components/WhatsNew'
import { PageTabs, useSavedTab } from '../components/PageTabs'
import { soundsOn } from '../mascot/sfx'
import { setLowPowerMode } from '../lowpower'
import { getLang, LANGUAGES, tr } from '@shared/i18n'
import { GEMINI_BROWSER } from '@shared/gemini'

const TABS = ['general', 'models', 'tools', 'privacy', 'about'] as const
type Tab = (typeof TABS)[number]
/** the tabs with fields that wait for Save (paths, the vision profile, the browser profile) */
const NEEDS_SAVE: Tab[] = ['models', 'tools']

export function SettingsPage() {
  const profiles = useStore((s) => s.profiles)
  const { toast } = useStore()
  const [s, setS] = useState<AppSettings>()
  const [version, setVersion] = useState('')
  const [tab, setTab] = useSavedTab<Tab>('jolty.settingsTab', TABS)
  useEffect(() => {
    void api.app.settings().then(setS)
    void api.app.version().then(setVersion)
  }, [])
  if (!s) return null
  const visionCandidates = profiles.filter((p) => !isAcp(p.engine) && (p.auth !== 'endpoint' || p.vision))
  return (
    <div className="page">
      <div className="page-inner narrow">
        <h1 className="page-title">{tr("Setări")}</h1>
        <p className="lead">Jolty {version}</p>
        <PageTabs
          label={tr("Setări")}
          tab={tab}
          onPick={setTab}
          tabs={[
            { id: 'general', label: tr("General"), icon: SlidersHorizontal },
            { id: 'models', label: tr("Modele și sesiuni"), icon: Cpu },
            { id: 'tools', label: tr("Browser și computer"), icon: Globe },
            { id: 'privacy', label: tr("Confidențialitate"), icon: ShieldCheck },
            { id: 'about', label: tr("Actualizări și despre"), icon: Info }
          ]}
        />
        <div role="tabpanel" className="settings-pane" key={tab}>
          {tab === 'general' && (
            <>
              <div className="card" style={{ marginBottom: 14 }}>
                <div className="row" style={{ marginBottom: 10 }}>
                  <Languages size={16} color="var(--volt)" />
                  <b>{tr("Limba aplicației")}</b>
                </div>
                <p className="muted small" style={{ marginTop: 0 }}>
                  {tr("Limba interfeței. Modelele îți răspund în limba în care le scrii, oricare ar fi aceasta.")}
                </p>
                <select
                  className="select"
                  value={getLang()}
                  onChange={async (e) => {
                    await api.app.saveSettings({ language: e.target.value })
                    // every text is rebuilt in the new language
                    location.reload()
                  }}
                >
                  {LANGUAGES.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.name}
                    </option>
                  ))}
                </select>
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
                  <b>{tr("Reduce mișcarea")}</b>
                  <span className="muted small" style={{ display: 'block' }}>
                   {tr("Fără animații: panourile, meniurile și paginile apar instant.")}
                  </span>
                </span>
              </label>
              <div className="card" style={{ marginBottom: 14 }}>
                <div className="row" style={{ marginBottom: 10 }}>
                  <Gauge size={16} color="var(--volt)" />
                  <b>{tr("Mod economic")}</b>
                </div>
                <p className="muted small" style={{ marginTop: 0 }}>
                  {tr("Aspect plat, fără animații decorative și o mascotă mai ușoară, pentru PC-uri slabe. Automat îl pornește pe PC-uri cu cel mult 4 nuclee sau 4 GB de memorie.")}
                </p>
                <select
                  className="select"
                  aria-label={tr("Mod economic")}
                  value={s.lowPower ?? 'auto'}
                  onChange={async (e) => {
                    const lowPower = e.target.value as 'auto' | 'on' | 'off'
                    setLowPowerMode(lowPower)
                    setS(await api.app.saveSettings({ lowPower }))
                  }}
                >
                  <option value="auto">{tr("Automat (după PC)")}</option>
                  <option value="on">{tr("Mereu pornit")}</option>
                  <option value="off">{tr("Mereu oprit")}</option>
                </select>
              </div>
              <label className="card row" style={{ marginBottom: 14, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={s.mascot !== false}
                  onChange={async (e) => {
                    await setMascot(e.target.checked)
                    setS(await api.app.settings())
                  }}
                />
                <span>
                  <b>{tr("Mascota Jolty")}</b>
                  <span className="muted small" style={{ display: 'block' }}>
                   {tr("Jolty umblă prin interfață: tastează cât lucrează modelul, arată spre cererile de aprobare, sare de bucurie la final. Îl poți prinde de glugă și arunca.")}
                  </span>
                </span>
              </label>
              <label className="card row" style={{ marginBottom: 14, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={s.mascotSounds !== false}
                  onChange={async (e) => {
                    soundsOn(e.target.checked)
                    setS(await api.app.saveSettings({ mascotSounds: e.target.checked }))
                  }}
                />
                <span>
                  <b>{tr("Sunetele lui Jolty")}</b>
                  <span className="muted small" style={{ display: 'block' }}>
                    {tr("Sunete scurte și încete când sare, aterizează, e aruncat sau se bucură. Tac cât lucrezi în altă fereastră.")}
                  </span>
                </span>
              </label>
              {(
                [
                  ['notifyDone', tr("Notificare la sfârșitul unei sarcini"), tr("Primești o notificare Windows când un model termină sau se oprește cu o eroare, cât timp Jolty nu e în față.")],
                  ['notifyAttention', tr("Notificare când ai de făcut ceva"), tr("Primești o notificare când un model așteaptă o permisiune sau aprobarea unui plan, cât timp Jolty nu e în față.")],
                  ['notifySound', tr("Sunet la notificări"), tr("Sunetul Windows care însoțește notificările de mai sus.")]
                ] as const
              ).map(([key, title, hint]) => (
                <label key={key} className="card row" style={{ marginBottom: 14, cursor: 'pointer' }}>
                  <input type="checkbox" checked={s[key] !== false} onChange={async (e) => setS(await api.app.saveSettings({ [key]: e.target.checked }))} />
                  <span>
                    <b>{title}</b>
                    <span className="muted small" style={{ display: 'block' }}>{hint}</span>
                  </span>
                </label>
              ))}
            </>
          )}
          {tab === 'models' && (
            <>
              <label className="card row" style={{ marginBottom: 14, cursor: 'pointer' }}>
                <input type="checkbox" checked={s.modelAdvice !== false} onChange={async (e) => setS(await api.app.saveSettings({ modelAdvice: e.target.checked }))} />
                <span>
                  <b>{tr("Sugerează modelul potrivit")}</b>
                  <span className="muted small" style={{ display: 'block' }}>
                    {tr("Când scrii o sarcină, o bară deasupra casetei îți propune alt model sau alt efort dacă cel ales nu se potrivește. Debifat, nu mai apare niciodată.")}
                  </span>
                </span>
              </label>
              <div className="card" style={{ marginBottom: 14 }}>
                <div className="row" style={{ marginBottom: 10 }}>
                  <Eye size={16} color="var(--volt)" />
                  <b>{tr("Imagini pentru modelele care nu văd")}</b>
                </div>
                <p className="muted small" style={{ marginTop: 0 }}>
                 {tr("Când trimiți o imagine unui model fără vision (de exemplu DeepSeek sau un model local mic), profilul de aici o descrie în detaliu (text exact, interfață, cod, erori), iar modelul tău primește descrierea.")}
                </p>
                <select className="select" value={s.visionProfileId || ''} onChange={(e) => setS({ ...s, visionProfileId: e.target.value || undefined })}>
                  <option value="">{tr("Automat (primul profil Claude)")}</option>
                  {visionCandidates.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                  <option value={GEMINI_BROWSER}>{tr("Gemini (prin browserul Jolty)")}</option>
                </select>
                <p className="muted small" style={{ marginBottom: 0 }}>
                  {tr("Gemini folosește contul tău Google din browserul Jolty, e mai lent (cam un minut) și, dacă nu merge, imaginea e descrisă de profilul automat.")}
                </p>
              </div>
              <ChildSessionsSettings s={s} setS={setS} />
              <label className="card row" style={{ marginBottom: 14, cursor: 'pointer' }}>
                <input type="checkbox" checked={s.learningLoop !== false} onChange={async (e) => setS(await api.app.saveSettings({ learningLoop: e.target.checked }))} />
                <span>
                  <b>{tr("Învață din conversații")}</b>
                  <span className="muted small" style={{ display: 'block' }}>
                    {tr("Ca la Hermes: la fiecare 10 mesaje modelul își notează în memorie ce a aflat despre tine și cum vrei să lucreze, iar la fiecare 15 actualizează sau creează un skill când a apărut ceva reutilizabil. Vezi în chat ce a salvat. Nu se aplică la conversațiile temporare.")}
                  </span>
                </span>
              </label>
              <div className="card" style={{ marginBottom: 14 }}>
                <b>{tr("Motoare")}</b>
                <p className="muted small">{tr("Claude Code și Codex sunt incluse. Hermes folosește instalarea de pe PC. Completează doar dacă vrei alt executabil.")}</p>
                <div className="field">
                  <label>Claude Code (claude.exe)</label>
                  <input className="input mono" value={s.claudePath || ''} placeholder={tr("versiunea inclusă")} onChange={(e) => setS({ ...s, claudePath: e.target.value || undefined })} />
                </div>
                <div className="field">
                  <label>Codex (codex.exe)</label>
                  <input className="input mono" value={s.codexPath || ''} placeholder={tr("versiunea inclusă")} onChange={(e) => setS({ ...s, codexPath: e.target.value || undefined })} />
                </div>
                <div className="field">
                  <label>Hermes ACP (hermes-acp.exe)</label>
                  <input className="input mono" value={s.hermesPath || ''} placeholder={tr("instalarea existentă")} onChange={(e) => setS({ ...s, hermesPath: e.target.value || undefined })} />
                </div>
                <div className="field">
                  <label>OpenCode (opencode.exe)</label>
                  <input className="input mono" value={s.opencodePath || ''} placeholder={tr("instalarea existentă")} onChange={(e) => setS({ ...s, opencodePath: e.target.value || undefined })} />
                </div>
              </div>
            </>
          )}
          {tab === 'tools' && (
            <>
              <BrowserSettings s={s} setS={setS} />
              <ComputerSettings s={s} setS={setS} />
            </>
          )}
          {tab === 'privacy' && (
            <>
              <div className="card" style={{ marginBottom: 14 }}>
                <div className="row" style={{ marginBottom: 10 }}>
                  <ShieldCheck size={16} color="var(--volt)" />
                  <b>{tr("Confidențialitate")}</b>
                </div>
                <p className="muted small" style={{ marginTop: 0 }}>
                 {tr("Jolty nu trimite nicio statistică. Pornește Claude Code și Codex cu telemetria, rapoartele de erori, sondajele de feedback și traficul neesențial oprite. Conversațiile, cheile și consumul rămân doar pe PC-ul tău.")}
                </p>
                <p className="muted small">
                 {tr("Folosirea conversațiilor pentru antrenarea modelelor se setează în contul fiecărui furnizor, nu în aplicație. Oprește-o o singură dată pe fiecare cont:")}
                </p>
                <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
                  <button className="btn small" onClick={() => void api.app.openExternal('https://claude.ai/settings/data-privacy-controls')} title={tr("Oprește „Help improve Claude”")}>
                    <ExternalLink size={13} /> {tr("Claude: confidențialitate")}
                  </button>
                  <button className="btn small" onClick={() => void api.app.openExternal('https://chatgpt.com/#settings/DataControls')} title={tr("Oprește „Improve the model for everyone”")}>
                    <ExternalLink size={13} /> {tr("ChatGPT: controlul datelor")}
                  </button>
                </div>
                <p className="faint small" style={{ marginBottom: 0 }}>
                 {tr("Cheile API Anthropic și OpenAI nu sunt folosite pentru antrenare implicit. Furnizorii compatibili (DeepSeek, MiMo, OpenRouter) au propriile reguli, iar modelele locale prin Ollama nu trimit nimic în afara PC-ului.")}
                </p>
              </div>
              <label className="card row" style={{ marginBottom: 14, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={s.protectSecretFiles !== false}
                  onChange={async (e) => setS(await api.app.saveSettings({ protectSecretFiles: e.target.checked }))}
                />
                <span>
                  <b>{tr("Întreabă înainte să atingă fișiere cu secrete")}</b>
                  <span className="muted small" style={{ display: 'block' }}>
                   {tr("Claude cere acordul tău înainte să citească sau să modifice .env, chei private, secrets.json și ~/.ssh, chiar și în modurile fără întrebări. Poți răspunde „da” oricând, nu e interzis. Se aplică la sesiunile pornite după schimbare.")}
                  </span>
                </span>
              </label>
            </>
          )}
          {tab === 'about' && (
            <>
              <UpdatesCard />
              <div className="card row" style={{ marginBottom: 14 }}>
                <Sparkles size={16} color="var(--volt)" />
                <span style={{ flex: 1 }}>
                  <b>{tr("Ce e nou în Jolty")}</b>
                  <span className="muted small" style={{ display: 'block' }}>
                    {tr("Ce s-a schimbat în fiecare versiune, de la cea mai nouă. Se deschide singur o dată după fiecare actualizare.")}
                  </span>
                </span>
                <button className="btn small" onClick={openWhatsNew}>
                  {tr("Vezi noutățile")}
                </button>
              </div>
              <div className="card row" style={{ marginBottom: 14 }}>
                <FolderOpen size={16} color="var(--volt)" />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <b>{tr("Datele Jolty")}</b>
                  <span className="muted small mono ellipsis" style={{ display: 'block' }} title={s.dataDir}>
                    {s.dataDir}
                  </span>
                </span>
                <button className="btn small" onClick={() => void api.app.openPath(s.dataDir)} title={s.dataDir}>
                  {tr("Deschide datele Jolty")}
                </button>
              </div>
            </>
          )}
        </div>
        {NEEDS_SAVE.includes(tab) && (
          <div className="row">
            <div className="spacer" />
            <button
              className="btn primary"
              onClick={async () => {
                await api.app.saveSettings(s)
                toast(tr("Setări salvate"))
              }}
            >
              <Save size={14} /> {tr("Salvează")}
            </button>
          </div>
        )}
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
      ? tr("Jolty {version} e descărcat. Repornește ca să-l instalezi, sau se instalează când închizi aplicația.", { version: update.version })
      : update?.state === 'downloading'
        ? `Descarc Jolty ${update.version || ''}: ${update.percent ?? 0}%.`
        : update?.state === 'checking'
          ? tr("Caut o versiune nouă…")
          : update?.state === 'latest'
            ? tr("Ai ultima versiune.{v0}", { v0: update.checkedAt ? ` Verificat ${timeAgo(update.checkedAt)}.` : '' })
            : update?.state === 'error'
              ? tr("Verificarea nu a mers: {error}", { error: update.error })
              : update?.state === 'dev'
                ? tr("Versiune de dezvoltare: actualizările vin doar în aplicația instalată.")
                : tr("Jolty caută singur versiuni noi la pornire, din oră în oră și când revii în aplicație, le descarcă în fundal și te anunță.")
  return (
    <div className="card row" style={{ marginBottom: 14, gap: 14, flexWrap: 'wrap' }}>
      <div style={{ flex: 1, minWidth: 240 }}>
        <b>{tr("Actualizări")}</b>
        <div className="muted small" style={{ marginTop: 4 }}>
          {text}
        </div>
      </div>
      {update?.state === 'ready' ? (
        <button className="btn primary small" onClick={() => void api.updates.install()}>
         {tr("Repornește și actualizează")}
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
         {tr("Caută acum")}
        </button>
      )}
    </div>
  )
}
