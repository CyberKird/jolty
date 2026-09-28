import { KeyRound, LogIn, LogOut, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AccountStatus, AuthKind, EngineKind, Profile, ProfileInput } from '@shared/types'
import { ProfileDot } from '../components/Chat'
import { api, ENGINE_LABEL, errMsg, levelColor, resetAt, resetIn, useStore } from '../store'

const AUTH_LABEL: Record<AuthKind, string> = {
  subscription: 'Abonament',
  apiKey: 'Cheie API',
  endpoint: 'Endpoint compatibil',
  existing: 'Configurația existentă'
}

const PRESETS = [
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/anthropic', models: 'deepseek-chat', vision: false },
  { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api', models: 'deepseek/deepseek-chat', vision: false },
  { name: 'Kimi (Moonshot)', baseUrl: 'https://api.moonshot.ai/anthropic', models: 'kimi-k2-turbo-preview', vision: false },
  { name: 'GLM (Z.ai)', baseUrl: 'https://api.z.ai/api/anthropic', models: 'glm-4.6', vision: false },
  { name: 'Xiaomi MiMo', baseUrl: 'https://api.xiaomimimo.com/anthropic', models: '', vision: false },
  { name: 'LiteLLM local', baseUrl: 'http://127.0.0.1:4000', models: 'deepseek', vision: false },
  { name: 'Personalizat', baseUrl: '', models: '', vision: false }
]

export function LimitMeters({ profileId, compact }: { profileId: string; compact?: boolean }) {
  const snap = useStore((s) => s.limits[profileId])
  if (!snap) return compact ? null : <div className="faint small">Limitele apar după prima conversație sau la „Actualizează”.</div>
  return (
    <div>
      {snap.windows.map((w) => (
        <div className="meter" key={w.label}>
          <div className="meter-head">
            <span>{w.label}</span>
            <span className="muted meter-time" title={resetIn(w.resetsAt)}>
              <span className="pct" style={{ color: 'var(--white)' }}>{Math.round(w.usedPercent)}%</span>
              <span>Reset: {resetAt(w.resetsAt)}</span>
            </span>
          </div>
          <div className="meter-track" role="meter" aria-valuenow={Math.round(w.usedPercent)} aria-valuemin={0} aria-valuemax={100} aria-label={w.label}>
            <div className="meter-fill" style={{ width: `${Math.min(100, w.usedPercent)}%`, background: levelColor(w.usedPercent) }} />
          </div>
        </div>
      ))}
      {snap.note && <div className="faint small">{snap.note}</div>}
    </div>
  )
}

function ProfileCard({ profile, onEdit }: { profile: Profile; onEdit: () => void }) {
  const [status, setStatus] = useState<AccountStatus>()
  const [busy, setBusy] = useState(false)
  const { toast, loadProfiles, onEvent } = useStore()

  const refresh = async (): Promise<AccountStatus> => {
    const s = await api.profiles.status(profile.id)
    setStatus(s)
    return s
  }
  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.id, profile.hasSecret])

  const login = async (): Promise<void> => {
    setBusy(true)
    try {
      const s = await api.profiles.login(profile.id)
      setStatus(s)
      if (profile.engine === 'claude' && profile.auth === 'subscription' && !s.loggedIn) {
        toast('Termină autentificarea în fereastra care s-a deschis. Verific automat...')
        for (let i = 0; i < 100; i++) {
          await new Promise((r) => setTimeout(r, 3000))
          if ((await refresh()).loggedIn) {
            toast(`${profile.name} e conectat`)
            break
          }
        }
      } else if (s.loggedIn) {
        toast(`${profile.name} e conectat`)
      }
    } catch (err) {
      toast(errMsg(err), true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 12 }}>
        <ProfileDot profile={profile} size={11} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600 }} className="ellipsis">
            {profile.name}
          </div>
          <div className="faint small">
            {ENGINE_LABEL[profile.engine]} · {AUTH_LABEL[profile.auth]}
            {profile.local ? ' · pe PC-ul tău' : ''}
          </div>
        </div>
        <div className="spacer" />
        {status === undefined ? (
          <span className="tag">se verifică...</span>
        ) : status.loggedIn ? (
          <span className="tag good">conectat</span>
        ) : (
          <span className="tag warn">neconectat</span>
        )}
      </div>
      {status?.loggedIn && (status.email || status.plan || status.detail) && (
        <div className="muted small" style={{ marginBottom: 10 }}>
          {[status.email, status.plan && `plan ${status.plan}`, status.detail].filter(Boolean).join(' · ')}
        </div>
      )}
      {status?.error && (
        <div className="small" style={{ color: 'var(--warning)', marginBottom: 10 }}>
          {status.error}
        </div>
      )}
      {profile.auth === 'subscription' && <LimitMeters profileId={profile.id} />}
      <div className="row wrap" style={{ marginTop: 12 }}>
        {profile.auth === 'existing' && <button className="btn small" onClick={() => void refresh()}><RefreshCw size={14} /> Verifică Hermes</button>}
        {!status?.loggedIn && profile.auth !== 'endpoint' && profile.auth !== 'existing' && (
          <button className="btn primary small" disabled={busy} onClick={() => void login()}>
            <LogIn size={14} /> {profile.auth === 'subscription' ? 'Conectează contul' : 'Conectează cheia'}
          </button>
        )}
        {status?.loggedIn && profile.auth === 'subscription' && (
          <button
            className="btn small"
            disabled={busy}
            onClick={async () => {
              try {
                const snap = await api.usage.refreshLimits(profile.id)
                if (snap) onEvent({ type: 'limits', snapshot: snap })
              } catch (err) {
                toast(errMsg(err), true)
              }
            }}
          >
            <RefreshCw size={14} /> Actualizează limitele
          </button>
        )}
        <div className="spacer" />
        <button className="btn ghost small icon" title="Editează" onClick={onEdit}>
          <Pencil size={14} />
        </button>
        {status?.loggedIn && profile.auth === 'subscription' && (
          <button className="btn ghost small icon" title="Deconectează" onClick={async () => setStatus(await api.profiles.logout(profile.id))}>
            <LogOut size={14} />
          </button>
        )}
        {!profile.isDefaultDir || profile.auth !== 'subscription' ? (
          <button
            className="btn ghost small icon danger"
            title="Șterge profilul"
            onClick={async () => {
              if (!confirm(`Ștergi profilul „${profile.name}”? Conversațiile lui din Jolty dispar; cele din Claude Code / Codex rămân.`)) return
              try {
                await api.profiles.remove(profile.id)
                await loadProfiles()
              } catch (err) {
                toast(errMsg(err), true)
              }
            }}
          >
            <Trash2 size={14} />
          </button>
        ) : null}
      </div>
    </div>
  )
}

function ProfileModal({ profile, onClose }: { profile?: Profile; onClose: () => void }) {
  const { loadProfiles, toast } = useStore()
  const [engine, setEngine] = useState<EngineKind>(profile?.engine || 'claude')
  const [auth, setAuth] = useState<AuthKind>(profile?.auth || 'subscription')
  const [name, setName] = useState(profile?.name || '')
  const [secret, setSecret] = useState('')
  const [cookie, setCookie] = useState('')
  const [baseUrl, setBaseUrl] = useState(profile?.baseUrl || '')
  const [preset, setPreset] = useState<string>()
  const [models, setModels] = useState(profile?.models?.join(', ') || '')
  const [vision, setVision] = useState(Boolean(profile?.vision))
  const [price, setPrice] = useState({ input: String(profile?.price?.input ?? ''), output: String(profile?.price?.output ?? ''), cacheRead: String(profile?.price?.cacheRead ?? '') })
  const editing = Boolean(profile)
  const isMiMo = (() => {
    try {
      return new URL(baseUrl).hostname === 'api.xiaomimimo.com'
    } catch {
      return false
    }
  })()

  // $ per 1M tokens; both input and output are needed for a cost, cache is optional
  const parsedPrice = (): ProfileInput['price'] => {
    const n = (s: string): number | undefined => (s.trim() === '' ? undefined : Number(s.replace(',', '.')))
    const input = n(price.input)
    const output = n(price.output)
    const cacheRead = n(price.cacheRead)
    const ok = (v?: number): boolean => v !== undefined && Number.isFinite(v) && v >= 0 && v < 1000
    if (!ok(input) || !ok(output)) return null
    return { input: input!, output: output!, ...(ok(cacheRead) ? { cacheRead } : {}) }
  }

  const save = async (): Promise<void> => {
    const input: ProfileInput = {
      name: name || (auth === 'subscription' ? `${ENGINE_LABEL[engine]} (cont nou)` : `${ENGINE_LABEL[engine]} · ${AUTH_LABEL[auth]}`),
      engine,
      auth,
      baseUrl: auth === 'endpoint' ? baseUrl : undefined,
      models: auth === 'endpoint' ? models.split(',').map((m) => m.trim()).filter(Boolean) : undefined,
      secret: secret || undefined,
      cookie: isMiMo ? cookie || undefined : undefined,
      vision: auth === 'endpoint' ? vision : undefined,
      price: auth === 'endpoint' ? parsedPrice() : undefined
    }
    try {
      if (profile) await api.profiles.update(profile.id, { name: input.name, baseUrl: input.baseUrl, models: input.models, vision: input.vision, price: input.price, ...(secret ? { secret } : {}), ...(isMiMo && cookie ? { cookie } : {}) })
      else await api.profiles.create(input)
      await loadProfiles()
      toast(editing ? 'Profil salvat' : 'Profil adăugat')
      onClose()
    } catch (err) {
      toast(errMsg(err), true)
    }
  }

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h2 className="modal-title">{editing ? 'Editează profilul' : 'Profil nou'}</h2>
        {!editing && (
          <>
            <div className="field">
              <label>Motor</label>
              <div className="segmented">
                {(['claude', 'codex', 'hermes'] as EngineKind[]).map((e) => (
                  <button
                    key={e}
                    className={engine === e ? 'on' : ''}
                    onClick={() => {
                      setEngine(e)
                      if (e === 'hermes') setAuth('existing')
                      else if (auth === 'existing' || (e === 'codex' && auth === 'endpoint')) setAuth('subscription')
                    }}
                  >
                    {ENGINE_LABEL[e]}
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              <label>Autentificare</label>
              <div className="segmented">
                {(['subscription', 'apiKey', 'endpoint', 'existing'] as AuthKind[])
                  .filter((a) => engine === 'hermes' ? a === 'existing' : a !== 'existing' && (engine === 'claude' || a !== 'endpoint'))
                  .map((a) => (
                    <button key={a} className={auth === a ? 'on' : ''} onClick={() => setAuth(a)}>
                      {AUTH_LABEL[a]}
                    </button>
                  ))}
              </div>
              <div className="hint">
                {auth === 'existing' && 'Folosește modelul, cheia, memoria și skill-urile deja configurate în Hermes. Nu trebuie să copiezi cheia aici.'}
                {auth === 'subscription' &&
                  (engine === 'claude'
                    ? 'Te conectezi cu contul tău claude.ai în fereastra oficială Claude Code. Fiecare profil are login-ul lui, deci poți avea mai multe conturi.'
                    : 'Te conectezi cu contul ChatGPT în browser, prin login-ul oficial Codex.')}
                {auth === 'apiKey' && (engine === 'claude' ? 'Cheie din console.anthropic.com. Plătești la token.' : 'Cheie din platform.openai.com. Plătești la token.')}
                {auth === 'endpoint' && 'Orice API compatibil Anthropic (DeepSeek, OpenRouter, Kimi, GLM, LiteLLM). Claude Code rulează cu modelul lor.'}
              </div>
            </div>
          </>
        )}
        <div className="field">
          <label>Nume</label>
          <input className="input" value={name} placeholder="ex. Claude personal, Claude firmă" onChange={(e) => setName(e.target.value)} />
        </div>
        {auth === 'endpoint' && (
          <>
            {!editing && (
              <div className="field">
                <label>Furnizor</label>
                <div className="row wrap" style={{ gap: 6 }}>
                  {PRESETS.map((p) => (
                    <button
                      key={p.name}
                      className={`btn small ${preset === p.name ? 'on' : ''}`}
                      aria-pressed={preset === p.name}
                      onClick={() => {
                        setPreset(p.name)
                        setBaseUrl(p.baseUrl)
                        setModels(p.models)
                        setVision(p.vision)
                        if (!name && p.baseUrl) setName(p.name)
                      }}
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="field">
              <label>Adresa API (base URL)</label>
              <input className="input mono" value={baseUrl} placeholder="https://..." onChange={(e) => setBaseUrl(e.target.value)} />
            </div>
            <div className="field">
              <label>Modele (separate prin virgulă, primul e implicit)</label>
              <input className="input mono" value={models} onChange={(e) => setModels(e.target.value)} />
              <div className="hint">Verifică numele exacte în documentația furnizorului.</div>
            </div>
            <label className="row small" style={{ marginBottom: 14, cursor: 'pointer' }}>
              <input type="checkbox" checked={vision} onChange={(e) => setVision(e.target.checked)} /> Modelul vede imagini (altfel Jolty i le descrie)
            </label>
            {!profile?.local && (
              <div className="field">
                <label>Preț în $ pe 1 milion de tokeni (opțional)</label>
                <div className="row" style={{ gap: 8 }}>
                  {(
                    [
                      ['input', 'Intrare'],
                      ['output', 'Ieșire'],
                      ['cacheRead', 'Din cache']
                    ] as const
                  ).map(([k, label]) => (
                    <input
                      key={k}
                      className="input mono"
                      inputMode="decimal"
                      aria-label={label}
                      placeholder={label}
                      value={price[k]}
                      onChange={(e) => setPrice({ ...price, [k]: e.target.value })}
                    />
                  ))}
                </div>
                <div className="hint">Copiază-le din pagina de prețuri a furnizorului. Fără ele, Jolty arată doar tokenii: estimarea Claude Code folosește prețurile Anthropic și ar fi greșită.</div>
              </div>
            )}
          </>
        )}
        {auth !== 'subscription' && auth !== 'existing' && (
          <div className="field">
            <label>
              <KeyRound size={12} /> Cheie API {editing && profile?.hasSecret ? '(lasă gol ca s-o păstrezi)' : ''}
            </label>
            <input className="input mono" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="sk-..." />
            <div className="hint">Se păstrează criptată cu protecția Windows a contului tău.</div>
          </div>
        )}
        {auth === 'endpoint' && isMiMo && (
          <div className="field">
            <label>
              <KeyRound size={12} /> Cookie platform.xiaomimimo.com {editing && profile?.hasCookie ? '(lasă gol ca să-l păstrezi)' : ''}
            </label>
            <input className="input mono" type="password" value={cookie} onChange={(e) => setCookie(e.target.value)} placeholder="api-platform_serviceToken=...; userId=..." />
            <div className="hint">Soldul MiMo se citește doar cu cookie-urile consolei, nu cu cheia API. Autentifică-te pe platform.xiaomimimo.com, apoi copiază header-ul Cookie dintr-un request. Expiră în ~24 h.</div>
          </div>
        )}
        <div className="row">
          <div className="spacer" />
          <button className="btn ghost" onClick={onClose}>
            Renunță
          </button>
          <button className="btn primary" onClick={() => void save()}>
            {editing ? 'Salvează' : 'Adaugă profilul'}
          </button>
        </div>
      </div>
    </div>
  )
}

export function AccountsPage() {
  const profiles = useStore((s) => s.profiles)
  const [modal, setModal] = useState<{ profile?: Profile } | null>(null)
  return (
    <div className="page">
      <div className="page-inner">
        <div className="row">
          <h1 className="page-title">Conturi și chei</h1>
          <div className="spacer" />
          <button className="btn primary" onClick={() => setModal({})}>
            <Plus size={16} /> Adaugă profil
          </button>
        </div>
        <p className="lead">
          Fiecare abonament are profilul lui, cu login-ul oficial Anthropic sau OpenAI. Comuți tu între ele din conversație; Jolty nu le folosește prin rotație automată. Pentru al doilea cont Claude: Adaugă profil → Claude Code → Abonament.
        </p>
        <div className="grid two">
          {profiles.map((p) => (
            <ProfileCard key={p.id} profile={p} onEdit={() => setModal({ profile: p })} />
          ))}
        </div>
      </div>
      {modal && <ProfileModal profile={modal.profile} onClose={() => setModal(null)} />}
    </div>
  )
}
