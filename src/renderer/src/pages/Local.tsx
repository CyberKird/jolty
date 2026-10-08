import { Cpu, Download, Eye, Gauge, HardDrive, Loader2, MemoryStick, Plus, RefreshCw, Trash2, Wrench } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { CatalogModel, HardwareInfo, OllamaStatus } from '@shared/types'
import { api, errMsg, useStore } from '../store'
import { tr } from '@shared/i18n'
import { Trans } from '../components/Trans'

const FIT: Record<CatalogModel['fit'], { label: string; cls: string }> = {
  gpu: { label: tr("Rulează pe placa video · rapid"), cls: 'good' },
  cpu: { label: tr("Doar pe procesor · lent"), cls: 'warn' },
  no: { label: tr("Prea mare pentru PC-ul tău"), cls: 'bad' }
}

function PullBar({ tag }: { tag: string }) {
  const pull = useStore((s) => s.pulls[tag])
  if (!pull || pull.done) return null
  const pct = pull.total ? Math.round(((pull.completed || 0) / pull.total) * 100) : 0
  return (
    <div style={{ marginTop: 10 }}>
      <div className="row small muted" style={{ marginBottom: 4 }}>
        <span className="ellipsis">{pull.status}</span>
        <div className="spacer" />
        {pull.total ? `${pct}% · ${((pull.completed || 0) / 1024 ** 3).toFixed(1)} / ${(pull.total / 1024 ** 3).toFixed(1)} GB` : ''}
      </div>
      <div className="progress">
        <div style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

export function LocalPage() {
  const { toast, loadProfiles } = useStore()
  const [hw, setHw] = useState<HardwareInfo>()
  const [ollama, setOllama] = useState<OllamaStatus>()
  const [catalog, setCatalog] = useState<CatalogModel[]>()
  const [busy, setBusy] = useState<string>()

  const refresh = useCallback(async () => {
    const [h, o, c] = await Promise.all([api.local.hardware(), api.local.status(), api.local.catalog()])
    setHw(h)
    setOllama(o)
    setCatalog(c)
  }, [])
  useEffect(() => {
    void refresh()
  }, [refresh])

  const pull = async (tag: string): Promise<void> => {
    setBusy(tag)
    try {
      await api.local.pull(tag)
      toast(tr("{tag} a fost descărcat", { tag }))
      await refresh()
    } catch (err) {
      toast(errMsg(err), true)
    } finally {
      setBusy(undefined)
    }
  }

  const makeProfile = async (tag: string): Promise<void> => {
    setBusy(tag)
    try {
      const p = await api.local.createProfile(tag)
      await loadProfiles()
      toast(tr("Profilul „{name}” e gata: îl alegi din conversație", { name: p.name }))
    } catch (err) {
      toast(errMsg(err), true)
    } finally {
      setBusy(undefined)
    }
  }

  const budget = hw ? (hw.bestVramGb > 0 ? hw.bestVramGb : hw.ramGb * 0.7) : 0
  return (
    <div className="page">
      <div className="page-inner">
        <div className="row">
          <h1 className="page-title">{tr("Modele locale")}</h1>
          <div className="spacer" />
          <button className="btn small" onClick={() => void refresh()}>
            <RefreshCw size={14} /> {tr("Reîmprospătează")}
          </button>
        </div>
        <p className="lead">
          {tr("Pentru când se termină abonamentele sau lucrezi fără internet. Modelele rulează pe PC-ul tău prin Ollama, iar Claude Code le folosește exact ca pe Claude. Sunt mult mai slabe decât Opus și Sonnet la sarcini complexe; echivalențele de mai jos sunt estimări orientative, nu rezultate de benchmark.")}
        </p>

        <div className="grid three" style={{ marginBottom: 16 }}>
          <div className="card">
            <div className="row faint small" style={{ marginBottom: 6 }}>
              <Gauge size={14} /> {tr("Placa video")}
            </div>
            {hw ? (
              hw.gpus.length ? (
                hw.gpus.map((g) => (
                  <div key={g.name}>
                    <b>{g.name}</b> <span className="muted">· {g.vramGb} {tr("GB VRAM")}</span>
                  </div>
                ))
              ) : (
                <span className="muted">{tr("Nicio placă video dedicată detectată")}</span>
              )
            ) : (
              <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} />
            )}
          </div>
          <div className="card">
            <div className="row faint small" style={{ marginBottom: 6 }}>
              <MemoryStick size={14} /> {tr("Memorie și procesor")}
            </div>
            {hw && (
              <>
                <b>{hw.ramGb} {tr("GB RAM")}</b>
                <div className="muted small ellipsis">
                  {hw.cpu} · {hw.cores} {tr("fire")}
                </div>
              </>
            )}
          </div>
          <div className="card">
            <div className="row faint small" style={{ marginBottom: 6 }}>
              <HardDrive size={14} /> Ollama
            </div>
            {!ollama ? (
              <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} />
            ) : ollama.running ? (
              <>
                <b>{tr("Pornit")}</b> <span className="muted">{tr("· versiunea {version}", { version: ollama.version })}</span>
                <div className="muted small">{tr("{n} modele instalate", { n: ollama.models.length })}</div>
              </>
            ) : ollama.installed ? (
              <div className="muted">{tr("Instalat, dar oprit. Pornește aplicația Ollama din meniul Start.")}</div>
            ) : (
              <>
                <div className="muted small" style={{ marginBottom: 8 }}>
                  {tr("Nu e instalat. Se instalează gratuit, într-un minut.")}
                </div>
                <button
                  className="btn primary small"
                  onClick={async () => {
                    try {
                      await api.local.installOllama()
                      toast(tr("Instalarea a pornit în fereastra nouă. Apasă „Reîmprospătează” după ce termină."))
                    } catch (err) {
                      toast(errMsg(err), true)
                    }
                  }}
                >
                  <Download size={14} /> {tr("Instalează Ollama")}
                </button>
              </>
            )}
          </div>
        </div>

        {hw && (
          <div className="muted small" style={{ marginBottom: 12 }}>
            <Trans
              text={hw.bestVramGb > 0 ? tr("Pe PC-ul tău încap confortabil modele de până la {size} pe placa video.") : tr("Pe PC-ul tău încap confortabil modele de până la {size} (fără placă video dedicată rulează pe procesor, mult mai lent).")}
              values={{ size: <b style={{ color: 'var(--white)' }}>~{Math.floor(budget)} GB</b> }}
            />
          </div>
        )}

        <div className="grid two">
          {catalog?.map((m) => {
            const fit = FIT[m.fit]
            const installedTag = ollama?.models.find((x) => x.tag === m.tag || x.tag === `${m.tag}:latest` || x.tag.startsWith(`${m.tag.replace(/:/g, '-')}-jolty`))
            return (
              <div className="card" key={m.tag}>
                <div className="row" style={{ marginBottom: 6 }}>
                  <b>{m.title}</b>
                  <span className="mono faint">{m.tag}</span>
                  <div className="spacer" />
                  {m.installed && <span className="tag good">{tr("instalat")}</span>}
                </div>
                <div className="row wrap" style={{ gap: 6, marginBottom: 10 }}>
                  <span className="tag volt" title={tr("Estimare orientativă față de modelele Claude")}>
                    ≈ {m.equivalent}
                  </span>
                  {m.unrestricted && (
                    <span className="tag warn" title={tr("Refuzurile au fost scoase din model. Tu răspunzi de ce generezi cu el.")}>
                      {tr("fără restricții")}
                    </span>
                  )}
                  <span className={`tag ${fit.cls}`}>{fit.label}</span>
                  <span className="tag">~{m.vramGb} {tr("GB")}</span>
                  {m.vision && (
                    <span className="tag">
                      <Eye size={11} /> {tr("vede imagini")}
                    </span>
                  )}
                </div>
                <div className="muted small" style={{ minHeight: 38 }}>
                  {m.notes}
                </div>
                <PullBar tag={m.tag} />
                <div className="row" style={{ marginTop: 12 }}>
                  {!m.installed ? (
                    <button className="btn small" disabled={!ollama?.running || busy === m.tag} onClick={() => void pull(m.tag)} title={ollama?.running ? '' : tr("Pornește întâi Ollama")}>
                      {busy === m.tag ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Download size={14} />} {tr("Descarcă")}
                    </button>
                  ) : (
                    <button className="btn primary small" disabled={busy === m.tag} onClick={() => void makeProfile(installedTag?.tag || m.tag)}>
                      <Plus size={14} /> {tr("Folosește în Jolty")}
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        {ollama?.running && ollama.models.length > 0 && (
          <div className="card" style={{ marginTop: 16 }}>
            <div className="row" style={{ marginBottom: 8 }}>
              <Cpu size={16} />
              <b>{tr("Instalate în Ollama")}</b>
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th>{tr("Model")}</th>
                  <th>{tr("Poate")}</th>
                  <th className="num">{tr("Mărime")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {ollama.models.map((m) => (
                  <tr key={m.tag}>
                    <td className="mono">{m.tag}</td>
                    <td>
                      <div className="row" style={{ gap: 5 }}>
                        {m.tools ? (
                          <span className="tag good">
                            <Wrench size={11} /> {tr("unelte")}
                          </span>
                        ) : (
                          <span className="tag bad">{tr("fără unelte")}</span>
                        )}
                        {m.vision && (
                          <span className="tag">
                            <Eye size={11} /> {tr("imagini")}
                          </span>
                        )}
                        {m.thinking && <span className="tag">{tr("gândire")}</span>}
                      </div>
                    </td>
                    <td className="num">{m.sizeGb} {tr("GB")}</td>
                    <td style={{ textAlign: 'right' }}>
                      <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
                        {m.tools && !m.tag.includes('-jolty') && (
                          <button className="btn small" disabled={busy === m.tag} onClick={() => void makeProfile(m.tag)}>
                            <Plus size={13} /> {tr("Folosește")}
                          </button>
                        )}
                        <button
                          className="btn ghost small icon danger"
                          title={tr("Șterge modelul de pe disc")}
                          onClick={async () => {
                            if (!confirm(tr("Ștergi {tag} de pe disc?", { tag: m.tag }))) return
                            try {
                              await api.local.remove(m.tag)
                              await refresh()
                            } catch (err) {
                              toast(errMsg(err), true)
                            }
                          }}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
