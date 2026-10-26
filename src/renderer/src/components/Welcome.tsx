import { ArrowRight, ExternalLink, KeyRound, Loader2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ModelOption, Profile } from '@shared/types'
import { CONNECT_PROVIDERS, canHelpSetup, wantsOwnKeyHint } from '@shared/setup'
import { api, errMsg, useStore } from '../store'
import { tr } from '@shared/i18n'
import { usePresence } from '../usePresence'

const spin = { animation: 'spin 1s linear infinite' }
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** The new profile becomes what the next chat opens on; loading the profiles also ends the welcome screen. */
async function finish(profile: Profile, model?: string): Promise<void> {
  const last = (await api.app.settings()).lastModels
  await api.app.saveSettings({ lastProfileId: profile.id, ...(model ? { lastModels: { ...last, [profile.id]: { model } } } : {}) })
  await useStore.getState().loadProfiles()
}

/** Pick a provider, open its key page, paste the key: it is only kept after one small request has been answered. */
export function ConnectKey({ onDone, onBack }: { onDone: (p: Profile) => void; onBack?: () => void }) {
  const [provider, setProvider] = useState<(typeof CONNECT_PROVIDERS)[number]>(CONNECT_PROVIDERS[0])
  const [model, setModel] = useState<string>(CONNECT_PROVIDERS[0].model)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const add = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      await api.setup.testKey(provider.baseUrl, model, key)
      onDone(await api.profiles.create({ name: provider.name, engine: 'claude', auth: 'endpoint', baseUrl: provider.baseUrl, models: [model.trim()], secret: key, vision: false }))
    } catch (err) {
      setError(errMsg(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div>
      <div className="row wrap" style={{ gap: 6, marginBottom: 14 }}>
        {CONNECT_PROVIDERS.map((p) => (
          <button key={p.name} className={`btn small ${provider.name === p.name ? 'on' : ''}`} aria-pressed={provider.name === p.name} onClick={() => { setProvider(p); setModel(p.model); setError(undefined) }}>
            {p.name}
          </button>
        ))}
      </div>
      <div className="field">
        <label>1. {tr("Ia o cheie de la furnizor")}</label>
        <div>
          <button className="btn small" onClick={() => void api.app.openExternal(provider.keyUrl)}>
            <ExternalLink size={14} /> {tr("Deschide pagina cheilor {provider}", { provider: provider.name })}
          </button>
        </div>
        <div className="hint">{tr("Te conectezi acolo, creezi o cheie și o copiezi. Ce oferă gratuit și ce costă stabilește furnizorul și se poate schimba.")}</div>
      </div>
      <div className="field">
        <label>
          <KeyRound size={12} /> 2. {tr("Lipește cheia")}
        </label>
        <input className="input mono" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-..." />
        <div className="hint">{tr("Se păstrează criptată cu protecția Windows a contului tău.")}</div>
      </div>
      <div className="field">
        <label>{tr("Model")}</label>
        <input className="input mono" value={model} onChange={(e) => setModel(e.target.value)} />
      </div>
      {error && <div className="hint" role="alert" style={{ color: 'var(--warning)', marginBottom: 10 }}>{error}</div>}
      <div className="row">
        <button className="btn primary" disabled={busy || !key.trim() || !model.trim()} onClick={() => void add()}>
          {busy ? <Loader2 size={14} style={spin} /> : null} {tr("Testează și adaugă")}
        </button>
        <button className="btn ghost" onClick={() => useStore.getState().setPage('accounts')}>{tr("Alt furnizor: Conturi și chei")}</button>
        {onBack && <button className="btn ghost" onClick={onBack}>{tr("Înapoi")}</button>}
      </div>
    </div>
  )
}

/** The last step of the welcome: what Jolty found on the account, with the scores it has; a model it knows nothing about is listed too and says so. */
function FoundModels({ profile, model, models, onDone }: { profile: Profile; model?: string; models: ModelOption[]; onDone: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const choice = models.filter((m) => m.score).length >= 2
  const go = async (): Promise<void> => {
    setBusy(true)
    try {
      await api.setup.presets().catch(() => false)
      await onDone()
    } finally {
      setBusy(false)
    }
  }
  /** the helper chat opens once the welcome is over, so the person lands in it */
  const helper = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      await api.setup.presets().catch(() => false)
      const meta = await api.setup.helper(profile.id, model)
      await onDone()
      useStore.getState().activateSession(meta)
      await useStore.getState().openSession(meta.id)
    } catch (err) {
      setError(errMsg(err))
      setBusy(false)
    }
  }
  return (
    <div className="swap" style={{ marginTop: 30 }}>
      <div className="field">
        <label>{tr("Modele găsite")} <span className="small">({profile.name})</span></label>
        {models.map((m) => (
          <div key={m.id} className="row" style={{ justifyContent: 'space-between', gap: 14, padding: '4px 0' }}>
            <span>{m.label}</span>
            <span className="small">
              {m.score ? `${tr("inteligență {iq}", { iq: m.score.iq })}${m.score.tps ? ` · ${tr("~{tps} tokeni/s", { tps: Math.round(m.score.tps) })}` : ''}` : tr("nu am găsit date despre acest model")}
            </span>
          </div>
        ))}
        <div className="hint">
          {choice ? tr("Jolty alege singur modelul sesiunilor pornite de el: cel mai bun pentru joburile grele, cel mai rapid care e destul de bun pentru cele simple. Schimbi din Setări.") : tr("Nu e nimic de ales între modele: totul rămâne pe modelul chatului.")}
        </div>
      </div>
      {canHelpSetup(profile.engine) && (
        <div className="field">
          <label>{tr("Vrei ca AI-ul să termine configurarea în locul tău?")}</label>
          <div className="hint">{tr("Un asistent verifică programele de care are nevoie Jolty și le instalează pe cele care lipsesc, explicându-ți fiecare pas pe înțelesul tuturor.")}</div>
          <div className="hint">
            {tr("Ca să nu te întrebe la fiecare pas, asistentul lucrează fără permisiuni: poate instala programe pe acest PC fără să ceară acordul de fiecare dată. I-am cerut să facă doar configurarea, să nu șteargă nimic și să nu se atingă de fișierele tale. Vezi tot ce face în chat și îl oprești oricând cu Stop.")}
          </div>
          <div>
            <button className="btn" disabled={busy} onClick={() => void helper()}>
              {tr("Da, fă-o tu")}
            </button>
          </div>
        </div>
      )}
      {error && <div className="hint" role="alert" style={{ color: 'var(--warning)', marginBottom: 10 }}>{error}</div>}
      <div className="row">
        <button className="btn primary" disabled={busy} onClick={() => void go()}>
          {busy ? <Loader2 size={14} style={spin} /> : null} {tr("Continuă")}
        </button>
      </div>
    </div>
  )
}

type Way = 'free' | 'key' | 'claude' | 'codex' | 'gemini'

/** Shown instead of the new-chat screen while there are no profiles: the shortest way to a first answer. */
export function Welcome() {
  const [way, setWay] = useState<Way>()
  const [step, setStep] = useState<string>()
  const [error, setError] = useState<string>()
  const [found, setFound] = useState<{ profile: Profile; model?: string; models: ModelOption[] }>()
  const cancelled = useRef(false)

  /** Shows what was found before the welcome ends; when nothing can be listed it ends at once. */
  const review = async (profile: Profile, model?: string): Promise<void> => {
    const models = await api.profiles.models(profile.id).catch(() => [] as ModelOption[])
    if (!models.length) return finish(profile, model)
    setStep(undefined)
    setFound({ profile, model, models })
  }

  const free = async (): Promise<void> => {
    setStep(tr("Instalez OpenCode (e o descărcare mare, poate dura)..."))
    await api.system.fix('opencode')
    const profile = (await api.profiles.list()).find((p) => p.engine === 'opencode')
    if (!profile) throw new Error(tr("OpenCode s-a instalat, dar nu l-am găsit. Verifică pagina Verificare sistem."))
    setStep(tr("Caut modelele gratuite..."))
    const models = await api.profiles.models(profile.id)
    const model = models.find((m) => m.isDefault) ?? models[0]
    if (!model) throw new Error(tr("OpenCode nu are acum modele gratuite. Adaugă o cheie proprie."))
    setStep(tr("Trimit un mesaj mic modelului {model}...", { model: model.label }))
    await api.setup.testFree(model.id)
    await review(profile, model.id)
  }

  const account = async (engine: 'claude' | 'codex'): Promise<void> => {
    setStep(tr("Caut contul conectat pe acest PC..."))
    const { profile, loggedIn } = await api.setup.account(engine)
    if (!loggedIn) {
      setStep(tr("Conectează-te în fereastra deschisă. Aștept..."))
      // Claude opens its own sign-in window and returns at once, Codex waits for the browser: both end up logged in
      void api.profiles.login(profile.id).catch(() => undefined)
      while (!(await api.profiles.status(profile.id)).loggedIn) {
        if (cancelled.current) return void api.profiles.remove(profile.id).catch(() => undefined)
        await sleep(2000)
      }
    }
    await review(profile)
  }

  /** Gemini lives in the Jolty browser: the sign-in is Google's own page there, and the wait ends when the chat box shows up. */
  const gemini = async (): Promise<void> => {
    setStep(tr("Caut contul Gemini în browserul Jolty..."))
    const { profile, loggedIn } = await api.setup.account('gemini')
    if (!loggedIn) {
      setStep(tr("Conectează-te la Google în fereastra browserului Jolty (cu abonamentul Gemini). Aștept..."))
      const status = await api.profiles.login(profile.id)
      if (cancelled.current) return void api.profiles.remove(profile.id).catch(() => undefined)
      if (!status.loggedIn) {
        void api.profiles.remove(profile.id).catch(() => undefined)
        throw new Error(status.error || tr("Nu m-am putut conecta la Gemini."))
      }
    }
    await review(profile)
  }

  const run = async (w: Way): Promise<void> => {
    cancelled.current = false
    setWay(w)
    setError(undefined)
    try {
      if (w === 'free') await free()
      else if (w === 'claude' || w === 'codex') await account(w)
      else if (w === 'gemini') await gemini()
    } catch (err) {
      setError(errMsg(err))
      setStep(undefined)
      setWay(undefined)
    }
  }

  const choices: { way: Way; title: string; text: string }[] = [
    { way: 'free', title: tr("Gratuit, fără cheie"), text: tr("Instalez OpenCode și folosesc modelele lui gratuite. Limitele le stabilește OpenCode.") },
    { way: 'key', title: tr("Am o cheie API"), text: tr("DeepSeek sau OpenRouter: te duc la pagina cheii, o lipești, o testez.") },
    { way: 'claude', title: tr("Abonament Claude"), text: tr("Te conectezi cu contul tău claude.ai.") },
    { way: 'codex', title: tr("Abonament ChatGPT"), text: tr("Te conectezi cu contul ChatGPT, prin Codex.") },
    { way: 'gemini', title: tr("Abonament Gemini"), text: tr("Folosești abonamentul Google direct din browserul Jolty, fără cheie.") }
  ]
  return (
    <div className="welcome">
      <h1 className="headline">
        {tr("Alege cu ce")}
        <br />
        {tr("lucrezi")}<span>.</span>
      </h1>
      <div className="context">{tr("Jolty nu vine cu un model al lui. Alege o variantă; o schimbi oricând din Conturi și chei.")}</div>
      <div className="context">{tr("Nu știi ce să alegi? Prima variantă merge fără cont și fără bani.")}</div>
      {error && <div className="hint" role="alert" style={{ color: 'var(--warning)', marginTop: 14 }}>{error}</div>}
      {step ? (
        <div className="row" style={{ marginTop: 30, gap: 10 }} role="status">
          <Loader2 size={16} style={spin} /> <span>{step}</span>
          {(way === 'claude' || way === 'codex' || way === 'gemini') && (
            <button className="btn small" onClick={() => { cancelled.current = true; setStep(undefined); setWay(undefined) }}>{tr("Renunță")}</button>
          )}
        </div>
      ) : found ? (
        <FoundModels profile={found.profile} model={found.model} models={found.models} onDone={() => finish(found.profile, found.model)} />
      ) : way === 'key' ? (
        <div className="swap" style={{ marginTop: 30 }}>
          <ConnectKey onDone={(p) => void review(p, p.models?.[0]).catch((err) => { setError(errMsg(err)); setWay(undefined) })} onBack={() => setWay(undefined)} />
        </div>
      ) : (
        <div className="starts">
          {choices.map((c) => (
            <button key={c.way} className="start" onClick={() => (c.way === 'key' ? setWay('key') : void run(c.way))}>
              <span>
                <b style={{ color: 'var(--white)', fontWeight: 500 }}>{c.title}</b>
                <br />
                <span className="small">{c.text}</span>
              </span>
              <ArrowRight size={14} />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** After the first chat on the free models: one quiet line that offers a key of their own, gone for good once closed. */
export function OwnKeyStrip() {
  const profiles = useStore((s) => s.profiles)
  const sessions = useStore((s) => s.sessions)
  const [dismissed, setDismissed] = useState(true)
  const [open, setOpen] = useState(false)
  const modal = usePresence(open)
  useEffect(() => {
    void api.app.settings().then((s) => setDismissed(Boolean(s.ownKeyHintDismissed)))
  }, [])
  if (!wantsOwnKeyHint(profiles, sessions.length, dismissed)) return null
  const dismiss = (): void => {
    setDismissed(true)
    void api.app.saveSettings({ ownKeyHintDismissed: true })
  }
  return (
    <>
      <div className="verification-strip update-strip" role="status">
        <span className="verification-text">{tr("Folosești modelele gratuite OpenCode. Adaugă o cheie proprie ca să nu depinzi de ele.")}</span>
        <button onClick={() => setOpen(true)}>{tr("Adaugă o cheie")}</button>
        <button onClick={dismiss} aria-label={tr("Nu mai arăta")} title={tr("Nu mai arăta")}>×</button>
      </div>
      {modal.shown && (
        <div className="modal-back" data-state={modal.state} onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
          <div className="modal">
            <h2 className="modal-title">{tr("Adaugă o cheie proprie")}</h2>
            <ConnectKey onDone={(p) => { setOpen(false); void finish(p, p.models?.[0]) }} />
          </div>
        </div>
      )}
    </>
  )
}
