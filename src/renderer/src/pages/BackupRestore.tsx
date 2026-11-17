import { CloudDownload, Loader2, RotateCcw, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { BackupEntry, RestoreInfo, RestoreProgress, RestoreReport } from '@shared/backup'
import type { ImportPreview } from '@shared/skills'
import { getLang, tr } from '@shared/i18n'
import { api, errMsg, timeAgo } from '../store'
import { fmtSize } from './PackExport'
import './backup.css'

/** "acum 3 min" (3 min ago), "chiar acum" under a minute. */
export const ago = (ms: number): string => {
  const t = timeAgo(ms)
  return t === tr("acum") ? tr("chiar acum") : tr("acum {t}", { t })
}

const when = (ms: number): string => new Date(ms).toLocaleString(getLang(), { dateStyle: 'medium', timeStyle: 'short' })

/**
 * Restore on this PC: the password (when this PC has none saved), what the storage holds (versions, from which PC,
 * how much), then the download with its progress and a restart into the restored state. An old single-file backup
 * goes through the import review instead (`onLegacy`).
 */
export function RestorePanel({ entry, onClose, onLegacy }: { entry: BackupEntry; onClose: () => void; onLegacy: (p: ImportPreview) => void }) {
  const { info, status } = entry
  const [pass, setPass] = useState('')
  const [needPass, setNeedPass] = useState(!status.hasPassword)
  const [data, setData] = useState<RestoreInfo>()
  const [version, setVersion] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [progress, setProgress] = useState<RestoreProgress | null>(null)

  const look = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      const d = await api.backup.inspect(info.id, needPass ? pass : undefined)
      setData(d)
      setVersion(d.versions[0]?.name)
    } catch (e) {
      setError(errMsg(e))
      if (/parol|password/i.test(errMsg(e))) setNeedPass(true)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (status.hasPassword) void look()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // the download runs in main; the page only follows it
  useEffect(() => {
    if (!progress || progress.phase !== 'download') return
    const t = setInterval(() => void api.backup.progress().then((p) => p && setProgress(p)), 400)
    return () => clearInterval(t)
  }, [progress?.phase])

  useEffect(() => {
    if (progress?.phase === 'ready') {
      const t = setTimeout(() => void api.backup.relaunch(), 1200)
      return () => clearTimeout(t)
    }
  }, [progress?.phase])

  const start = async (): Promise<void> => {
    setError(undefined)
    setProgress({ id: info.id, phase: 'download', done: 0, total: 0 })
    try {
      await api.backup.restoreAll(info.id, version, needPass ? pass : undefined)
      setProgress((await api.backup.progress()) ?? { id: info.id, phase: 'ready', done: 1, total: 1 })
    } catch (e) {
      setProgress(null)
      setError(errMsg(e))
    }
  }

  const legacy = async (): Promise<void> => {
    setBusy(true)
    try {
      onLegacy(await api.backup.restore(info.id, needPass ? pass : undefined))
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  const chosen = data?.versions.find((v) => v.name === version)
  const pct = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0

  return (
    <div className="restore-panel">
      <div className="row">
        <b>{tr("Restaurează pe acest PC")}</b>
        <span className="spacer" />
        {!progress && (
          <button className="btn ghost small icon" onClick={onClose} aria-label={tr("Închide")} title={tr("Închide")}>
            <X size={14} />
          </button>
        )}
      </div>

      {progress ? (
        <div className="stack" style={{ gap: 8 }} role="status">
          <span className="small">
            {progress.phase === 'ready'
              ? tr("Gata. Jolty repornește și se deschide exact unde ai rămas.")
              : progress.total
                ? tr("Descarc backup-ul: {done} din {total} pachete.", { done: progress.done, total: progress.total })
                : tr("Pregătesc descărcarea...")}
          </span>
          <div className="progress">
            <div style={{ width: `${progress.phase === 'ready' ? 100 : pct}%` }} />
          </div>
          <span className="faint small">{tr("Dacă se întrerupe, continuă de unde a rămas data viitoare.")}</span>
        </div>
      ) : (
        <>
          {needPass && !data && (
            <div className="row">
              <input className="input" type="password" value={pass} autoFocus placeholder={tr("Parola backup-ului salvat")} onChange={(e) => setPass(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && pass && void look()} />
              <button className="btn" disabled={!pass || busy} onClick={() => void look()}>
                {busy ? <Loader2 size={14} className="spin" /> : null} {tr("Deschide")}
              </button>
            </div>
          )}
          {busy && !needPass && !data && (
            <span className="faint small row">
              <Loader2 size={14} className="spin" /> {tr("Citesc ce e în {place}...", { place: info.name })}
            </span>
          )}

          {data && data.versions.length > 0 && (
            <div className="stack" style={{ gap: 10 }}>
              <div className="restore-facts">
                <span>
                  <b>{data.chats}</b> {tr("conversații")}
                </span>
                <span>
                  <b>{data.profiles}</b> {tr("profiluri cu istoricul lor")}
                </span>
                <span>{data.personal ? tr("skilluri, comenzi, instrucțiuni și servere MCP") : tr("fără skilluri")}</span>
              </div>
              <div className="restore-versions" role="radiogroup" aria-label={tr("Versiunea de restaurat")}>
                {data.versions.map((v, i) => (
                  <label key={v.name} className={`restore-version ${v.name === version ? 'on' : ''}`}>
                    <input type="radio" name={`ver-${info.id}`} checked={v.name === version} onChange={() => setVersion(v.name)} />
                    <span className="ellipsis">
                      {when(v.at)}
                      {i === 0 ? ` · ${tr("cea mai nouă")}` : ''}
                    </span>
                    <span className="faint small ellipsis">
                      {tr("de pe {host}", { host: v.host })} · {fmtSize(v.raw)}
                    </span>
                  </label>
                ))}
              </div>
              <p className="faint small" style={{ margin: 0 }}>
                {tr("Ce e acum pe acest PC nu se șterge: fișierele înlocuite se mută într-un folder separat. Cheile API și login-urile nu sunt în backup, te conectezi din nou la conturi.")}
              </p>
              <div className="row">
                <button className="btn primary" disabled={!chosen} onClick={() => void start()}>
                  <RotateCcw size={14} /> {tr("Restaurează și repornește")}
                </button>
                {chosen && <span className="faint small">{tr("cel mult {size} de descărcat", { size: fmtSize(chosen.raw) })}</span>}
              </div>
            </div>
          )}

          {data && !data.versions.length && data.legacy && (
            <div className="stack" style={{ gap: 8 }}>
              <span className="small">{tr("În {place} e un backup făcut de o versiune mai veche de Jolty, {when}. Se deschide pentru verificare, ca un import.", { place: info.name, when: ago(data.legacy.modifiedAt) })}</span>
              <div className="row">
                <button className="btn primary" disabled={busy} onClick={() => void legacy()}>
                  <CloudDownload size={14} /> {tr("Deschide backup-ul vechi")}
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {error && (
        <div className="hint" role="alert" style={{ color: 'var(--warning)' }}>
          {error}
        </div>
      )}
    </div>
  )
}

/** After a restore and the restart: what came back, what is missing on this PC, where the old files went. */
export function RestoreReportCard() {
  const [rep, setRep] = useState<RestoreReport | null>(null)
  useEffect(() => {
    void api.backup.report().then(setRep).catch(() => undefined)
  }, [])
  if (!rep) return null
  const close = (): void => {
    setRep(null)
    void api.backup.dismissReport()
  }
  return (
    <div className="card restore-report" role="status">
      <div className="row">
        <b>{tr("Jolty a fost restaurat din backup")}</b>
        <span className="spacer" />
        <button className="btn ghost small icon" onClick={close} aria-label={tr("Închide")} title={tr("Închide")}>
          <X size={14} />
        </button>
      </div>
      <p className="small" style={{ margin: '6px 0 0' }}>
        {tr("Versiunea din {when} de pe {host}: {n} fișiere.", { when: when(rep.versionAt), host: rep.host, n: rep.files })}
        {rep.personal ? ` ${tr("Au revenit și {n} skilluri, comenzi, instrucțiuni sau servere MCP.", { n: rep.personal })}` : ''}
      </p>
      {rep.missing.length > 0 && (
        <div className="small" style={{ marginTop: 8 }}>
          {tr("Aceste foldere de proiect nu există pe acest PC; conversațiile lor se deschid, dar modelul nu are fișierele:")}
          <ul className="restore-missing">
            {rep.missing.slice(0, 6).map((m) => (
              <li key={m} className="mono ellipsis">
                {m}
              </li>
            ))}
          </ul>
          {rep.missing.length > 6 && <span className="faint">{tr("și încă {n}", { n: rep.missing.length - 6 })}</span>}
        </div>
      )}
      {rep.previous && <p className="faint small" style={{ margin: '8px 0 0' }}>{tr("Ce era înainte pe acest PC e păstrat în {dir}.", { dir: rep.previous })}</p>}
    </div>
  )
}
