import { ChevronDown, ChevronRight, CloudDownload, CloudUpload, Link2, Loader2, LogOut } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { BackupEntry, RemoteBackup } from '@shared/backup'
import type { ImportPreview } from '@shared/skills'
import { tr } from '@shared/i18n'
import { api, errMsg, timeAgo, useStore } from '../store'
import { fmtSize } from './PackExport'
import { PackImport } from './PackImport'

/** One storage: the fields to fill, the sign-in, and once connected the backup and the restore. */
function ProviderCard({ entry, reload }: { entry: BackupEntry; reload: () => Promise<void> }) {
  const { toast } = useStore()
  const { info, status } = entry
  const [open, setOpen] = useState(status.connected)
  const [values, setValues] = useState<Record<string, string>>(entry.values)
  const [busy, setBusy] = useState<'connect' | 'backup' | 'restore' | 'password'>()
  const [remote, setRemote] = useState<RemoteBackup | null>()
  const [password, setPassword] = useState('')
  const [restorePass, setRestorePass] = useState('')
  const [askPass, setAskPass] = useState(false)
  const [preview, setPreview] = useState<ImportPreview>()
  const connected = status.connected

  useEffect(() => {
    setRemote(undefined)
    if (connected) void api.backup.remote(info.id).then(setRemote).catch(() => setRemote(null))
  }, [connected, info.id, status.lastBackupAt])

  const run = async (kind: NonNullable<typeof busy>, fn: () => Promise<void>): Promise<void> => {
    setBusy(kind)
    try {
      await fn()
    } catch (e) {
      toast(errMsg(e), true)
      if (kind === 'restore') setAskPass(true)
    } finally {
      setBusy(undefined)
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
                      await reload()
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
                      await reload()
                    })
                  }
                >
                  <LogOut size={14} /> {tr("Deconectează")}
                </button>
              </div>

              {!status.hasPassword ? (
                <div className="stack" style={{ gap: 8 }}>
                  <p className="small" style={{ margin: 0 }}>
                    {tr("Alege o parolă de backup (minimum 8 caractere). Fără ea backup-ul nu se poate citi și nu o poți recupera.")}
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
                          await reload()
                        })
                      }
                    >
                      {tr("Salvează parola")}
                    </button>
                  </div>
                </div>
              ) : (
                <span className="faint small">{tr("Parola de backup e salvată pe acest PC.")}</span>
              )}

              <div className="faint small">
                {status.lastBackupAt
                  ? tr("Ultimul backup de pe acest PC: {when}, {n} elemente, {size}.", { when: timeAgo(status.lastBackupAt), n: status.lastBackupItems ?? 0, size: fmtSize(status.lastBackupBytes ?? 0) })
                  : tr("Încă nu ai făcut backup de pe acest PC.")}
                <br />
                {remote === undefined ? '' : remote ? tr("În {place}: {when}, {size}.", { place: info.name, when: timeAgo(remote.modifiedAt), size: fmtSize(remote.bytes) }) : tr("În {place} nu e încă niciun backup.", { place: info.name })}
              </div>

              {preview ? (
                <PackImport initial={preview} onImported={() => undefined} onClose={() => setPreview(undefined)} />
              ) : (
                <>
                  <div className="row" style={{ flexWrap: 'wrap' }}>
                    <button
                      className="btn primary"
                      disabled={!status.hasPassword || !!busy}
                      onClick={() =>
                        void run('backup', async () => {
                          const r = await api.backup.run(info.id)
                          await reload()
                          toast(r.skipped ? tr("Backup făcut: {n} elemente. {s} fișiere prea mari au rămas pe loc.", { n: r.items, s: r.skipped }) : tr("Backup făcut: {n} elemente.", { n: r.items }))
                        })
                      }
                    >
                      {busy === 'backup' ? <Loader2 size={14} className="spin" /> : <CloudUpload size={14} />} {tr("Fă backup acum")}
                    </button>
                    <button
                      className="btn"
                      disabled={!!busy || remote === null || (!status.hasPassword && !restorePass)}
                      onClick={() =>
                        void run('restore', async () => {
                          setPreview(await api.backup.restore(info.id, restorePass || undefined))
                          await reload()
                        })
                      }
                    >
                      {busy === 'restore' ? <Loader2 size={14} className="spin" /> : <CloudDownload size={14} />} {tr("Restaurează din {place}", { place: info.name })}
                    </button>
                  </div>
                  {(askPass || !status.hasPassword) && (
                    <input className="input" type="password" value={restorePass} placeholder={tr("Parola backup-ului salvat")} onChange={(e) => setRestorePass(e.target.value)} />
                  )}
                </>
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
  const { toast } = useStore()
  const reload = (): Promise<void> => api.backup.list().then(setBackups)
  useEffect(() => {
    void reload().catch((e) => toast(errMsg(e), true))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  if (!entries) return null
  // connected storages first, in the usual order after them
  const sorted = [...entries].sort((a, b) => Number(b.status.connected) - Number(a.status.connected))
  return (
    <div style={{ marginBottom: 14 }}>
      <div className="stack" style={{ gap: 4, marginBottom: 10 }}>
        <b>{tr("Backup și conturi")}</b>
        <p className="muted small" style={{ margin: 0 }}>
          {tr("Backup complet al personalizării (skilluri, comenzi, instrucțiuni, setări, conturi fără chei, sarcini programate, servere MCP) în locul ales de tine, criptat cu o parolă. Cheile API și login-urile nu se încarcă. Poți conecta mai multe locuri deodată.")}
        </p>
      </div>
      {sorted.map((e) => (
        <ProviderCard key={e.info.id} entry={e} reload={reload} />
      ))}
    </div>
  )
}
