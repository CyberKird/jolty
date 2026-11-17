import { ChevronDown, ChevronRight, CloudDownload, CloudUpload, Link2, Loader2, LogOut, Minimize2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { BackupEntry, BackupStatus } from '@shared/backup'
import type { ImportPreview } from '@shared/skills'
import { tr } from '@shared/i18n'
import { api, errMsg, useStore } from '../store'
import { fmtSize } from './PackExport'
import { PackImport } from './PackImport'
import { ago, RestorePanel, RestoreReportCard } from './BackupRestore'
import { useShallow } from 'zustand/shallow'

/** One calm line: running, the last update and the space used, or the last failure (retried by itself). */
function StatusLine({ status }: { status: BackupStatus }) {
  const failed = !!status.lastErrorAt && (!status.lastBackupAt || status.lastErrorAt > status.lastBackupAt)
  if (status.running)
    return (
      <span className="backup-status small" role="status">
        <Loader2 size={13} className="spin" /> {tr("Se actualizează backup-ul...")}
      </span>
    )
  const used = status.usedBytes ? ` · ${tr("{size} folosiți", { size: fmtSize(status.usedBytes) })}` : ''
  return (
    <div className="stack" style={{ gap: 4 }}>
      <span className="backup-status small">
        <span className={`dot ${status.lastBackupAt ? 'good' : ''}`} />
        {status.lastBackupAt ? `${tr("Ultima actualizare: {when}", { when: ago(status.lastBackupAt) })}${used}` : tr("Încă nu ai făcut backup de pe acest PC.")}
      </span>
      {failed && (
        <span className="backup-status small faint">
          <span className="dot warn" />
          {tr("Ultima încercare ({when}) n-a mers: {error} Reîncerc singur.", { when: ago(status.lastErrorAt!), error: status.lastError ?? '' })}
        </span>
      )}
    </div>
  )
}

/** One storage: the fields to fill, the sign-in, and once connected the automatic backup, the status and the restore. */
function ProviderCard({ entry, reload }: { entry: BackupEntry; reload: () => Promise<void> }) {
  const { toast } = useStore(useShallow(({ toast }) => ({ toast })))
  const { info, status } = entry
  const [open, setOpen] = useState(status.connected)
  const [values, setValues] = useState<Record<string, string>>(entry.values)
  const [busy, setBusy] = useState<'connect' | 'backup' | 'password' | 'compact' | 'auto'>()
  const [password, setPassword] = useState('')
  const [restoring, setRestoring] = useState(false)
  const [preview, setPreview] = useState<ImportPreview>()
  const connected = status.connected

  const run = async (kind: NonNullable<typeof busy>, fn: () => Promise<void>): Promise<void> => {
    setBusy(kind)
    try {
      await fn()
    } catch (e) {
      toast(errMsg(e), true)
    } finally {
      setBusy(undefined)
      await reload().catch(() => undefined)
    }
  }
  const filled = info.fields.every((f) => f.optional || values[f.key]?.trim() || entry.saved.includes(f.key))

  return (
    <div className="card" style={{ marginBottom: 10 }}>
      <button className="row backup-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <b>{info.name}</b>
        <span className="spacer" />
        {connected ? <span className="tag good ellipsis">{status.name || status.label}</span> : <span className="faint small">{tr("Neconectat")}</span>}
      </button>
      {open && (
        <div className="stack" style={{ gap: 12, marginTop: 10 }}>
          {!connected && (
            <div className="stack" style={{ gap: 8 }}>
              <p className="muted small" style={{ margin: 0 }}>
                {info.help}
              </p>
              {info.fields.map((f) => (
                <input
                  key={f.key}
                  className="input"
                  type={f.secret ? 'password' : 'text'}
                  value={values[f.key] ?? ''}
                  placeholder={`${f.label}${f.optional ? ` (${tr("opțional")})` : ''}${f.secret && entry.saved.includes(f.key) ? ` (${tr("salvat")})` : f.placeholder ? `, ${f.placeholder}` : ''}`}
                  onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                />
              ))}
              <div className="row">
                <button
                  className="btn primary"
                  disabled={!filled || busy === 'connect'}
                  onClick={() =>
                    void run('connect', async () => {
                      await api.backup.setConfig(info.id, values)
                      await api.backup.connect(info.id)
                    })
                  }
                >
                  {busy === 'connect' ? <Loader2 size={14} className="spin" /> : <Link2 size={14} />} {tr("Conectează")}
                </button>
                {busy === 'connect' && info.kind === 'oauth' && <span className="faint small">{tr("Continuă în browser, apoi întoarce-te aici.")}</span>}
              </div>
            </div>
          )}

          {connected && (
            <>
              <div className="row">
                {status.picture ? (
                  <img className="account-avatar big" src={status.picture} alt="" referrerPolicy="no-referrer" />
                ) : (
                  <span className="account-avatar big">{((status.name || status.label || info.name)[0] || 'G').toUpperCase()}</span>
                )}
                <div className="account-text">
                  <span className="ellipsis">{status.name || status.label}</span>
                  {status.name && <span className="faint small ellipsis">{status.label}</span>}
                </div>
                <div className="spacer" />
                <button
                  className="btn ghost small disconnect"
                  title={tr("Uită contul pe acest PC. Backup-ul rămâne în loc.")}
                  onClick={() =>
                    void run('connect', async () => {
                      await api.backup.disconnect(info.id)
                      setPreview(undefined)
                      setRestoring(false)
                    })
                  }
                >
                  <LogOut size={14} /> {tr("Deconectează")}
                </button>
              </div>

              {!status.hasPassword && (
                <div className="stack" style={{ gap: 8 }}>
                  <p className="small" style={{ margin: 0 }}>
                    {tr("Alege o parolă de backup (minimum 8 caractere). Fără ea backup-ul nu se poate citi și nu o poți recupera. Pe un PC nou scrie parola pe care ai ales-o deja.")}
                  </p>
                  <div className="row">
                    <input className="input" type="password" value={password} placeholder={tr("Parola de backup")} onChange={(e) => setPassword(e.target.value)} />
                    <button
                      className="btn primary"
                      disabled={password.length < 8 || busy === 'password'}
                      onClick={() =>
                        void run('password', async () => {
                          await api.backup.setPassword(info.id, password)
                          setPassword('')
                        })
                      }
                    >
                      {tr("Salvează parola")}
                    </button>
                  </div>
                </div>
              )}

              <label className="backup-auto">
                <input
                  type="checkbox"
                  checked={status.autoUpdate}
                  disabled={busy === 'auto'}
                  onChange={(e) => void run('auto', async () => void (await api.backup.setAuto(info.id, e.target.checked)))}
                />
                <span className="stack" style={{ gap: 2 }}>
                  <span>{tr("Actualizează automat")}</span>
                  <span className="faint small">{tr("După ce schimbi ceva, cel mult o dată la 10 minute și la închidere. Se trimite doar ce s-a schimbat, criptat.")}</span>
                </span>
              </label>

              {status.hasPassword && <StatusLine status={status} />}

              {status.waitingFor && !restoring && (
                <div className="backup-note small">
                  {tr("În {place} e deja backup-ul de pe {host}, făcut {when}. Restaurează-l pe acest PC sau pornește backup-ul acestui PC alături de el; până alegi, actualizarea automată așteaptă.", {
                    place: info.name,
                    host: status.waitingFor.host,
                    when: ago(status.waitingFor.at)
                  })}
                </div>
              )}

              {preview ? (
                <PackImport initial={preview} onImported={() => undefined} onClose={() => setPreview(undefined)} />
              ) : restoring ? (
                <RestorePanel
                  entry={entry}
                  onClose={() => setRestoring(false)}
                  onLegacy={(p) => {
                    setRestoring(false)
                    setPreview(p)
                  }}
                />
              ) : (
                <div className="row" style={{ flexWrap: 'wrap' }}>
                  <button
                    className="btn primary"
                    disabled={!status.hasPassword || !!busy || status.running}
                    onClick={() =>
                      void run('backup', async () => {
                        const r = await api.backup.run(info.id)
                        toast(r.unchanged ? tr("Nimic nou de trimis: backup-ul e la zi.") : tr("Backup actualizat: {size} trimiși.", { size: fmtSize(r.bytes) }))
                      })
                    }
                  >
                    {busy === 'backup' ? <Loader2 size={14} className="spin" /> : <CloudUpload size={14} />} {tr("Fă backup acum")}
                  </button>
                  <button className="btn" disabled={!!busy || status.running} onClick={() => setRestoring(true)}>
                    <CloudDownload size={14} /> {tr("Restaurează pe acest PC")}
                  </button>
                  {!!status.usedBytes && (
                    <button
                      className="btn ghost"
                      title={tr("Rescrie pachetele care conțin mai ales date vechi. Descarcă și reîncarcă doar acele pachete.")}
                      disabled={!!busy || status.running}
                      onClick={() =>
                        void run('compact', async () => {
                          const r = await api.backup.compact(info.id)
                          toast(r.after < r.before ? tr("Compactat: de la {before} la {after}.", { before: fmtSize(r.before), after: fmtSize(r.after) }) : tr("Nu era nimic de compactat."))
                        })
                      }
                    >
                      {busy === 'compact' ? <Loader2 size={14} className="spin" /> : <Minimize2 size={14} />} {tr("Compactează")}
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** Where the personalization is backed up: every storage Jolty knows, several can be connected at once. */
export function BackupSettings() {
  const entries = useStore((s) => s.backups)
  const setBackups = useStore((s) => s.setBackups)
  const { toast } = useStore(useShallow(({ toast }) => ({ toast })))
  const reload = (): Promise<void> => api.backup.list().then(setBackups)
  const running = !!entries?.some((e) => e.status.running)
  useEffect(() => {
    void reload().catch((e) => toast(errMsg(e), true))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // automatic runs happen in main: the status follows them, often while one runs
  useEffect(() => {
    const t = setInterval(() => void reload().catch(() => undefined), running ? 3000 : 30000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running])
  if (!entries) return null
  // connected storages first, in the usual order after them
  const sorted = [...entries].sort((a, b) => Number(b.status.connected) - Number(a.status.connected))
  return (
    <div style={{ marginBottom: 14 }}>
      <RestoreReportCard />
      <div className="stack" style={{ gap: 4, marginBottom: 10 }}>
        <b>{tr("Backup și conturi")}</b>
        <p className="muted small" style={{ margin: 0 }}>
          {tr("Backup complet, criptat cu parola ta, în locul ales de tine: conversațiile cu istoricul lor, setările și temele, profilurile (fără chei), sarcinile programate, notițele, skillurile, comenzile, instrucțiunile și serverele MCP. Pe un PC nou, după restaurare, Jolty e exact unde ai rămas. Cheile API și login-urile nu pleacă de pe acest PC.")}
        </p>
      </div>
      {sorted.map((e) => (
        <ProviderCard key={e.info.id} entry={e} reload={reload} />
      ))}
    </div>
  )
}
