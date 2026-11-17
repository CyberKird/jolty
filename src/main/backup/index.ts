// Backup of the whole personalization to a storage the user owns (Google Drive, OneDrive, Dropbox, Box, GitHub,
// WebDAV, S3, a folder). Several can be connected at once; each keeps one account at a time and its own backup, so
// nothing mixes between accounts. Backups are incremental (vault*.ts): chats, settings, profiles, schedules, notes,
// the engines' history and the pack of skills, commands, instructions and MCP servers, encrypted here with a
// password, so the storage only ever holds ciphertext, and only what changed travels. A run starts by itself after
// changes (auto.ts) unless the user turned that off. Restore brings a new PC back to where the old one stopped
// (vault-ops.ts). A backup made by older versions (one file, the pack alone) still opens in the import review.
import { shell } from 'electron'
import type { BackupEntry, BackupResult, BackupStatus, RemoteBackup } from '@shared/backup'
import type { ImportPreview } from '@shared/skills'
import { tr } from '@shared/i18n'
import { getSecret, loadBackupAccounts, loadBackupConfig, saveBackupAccounts, saveBackupConfig, setSecret } from '../store'
import { discard, openPackBuffer } from '../share-pack'
import { mergeTime, takeTime } from '../use-time'
import { decryptBackup, encryptBackup } from './crypto'
import { PROVIDERS } from './providers'
import { BackupError, FILE, type Opener, type Provider } from './types'
import { account, config, passKey, patchMeta, pick, secretKey } from './common'
import { kick } from './auto'
import { forgetCache, forgetKeys, storeOf } from './vault'
import { HEAD } from './vault-format'
import { running, runVault } from './vault-ops'

export { decryptBackup, encryptBackup }
export { BackupError }
export { compactNow as compact, dismissReport, finishRestore, inspect, report, restoreAll, restoreProgress as progress } from './vault-ops'
export { finalRun, startAuto } from './auto'

const PASSWORD_MIN = 8
const FIELD_MAX = 2000

const configured = (p: Provider): boolean => {
  const cfg = config(p)
  return p.info().fields.every((f) => f.optional || cfg[f.key]?.trim())
}

function statusOf(p: Provider): BackupStatus {
  const m = loadBackupAccounts()[p.id]
  return {
    id: p.id,
    configured: configured(p),
    connected: !!m,
    hasPassword: !!m && !!getSecret(passKey(p.id, m.sub)),
    autoUpdate: !!m && m.autoUpdate !== false,
    ...(running() === p.id ? { running: true } : {}),
    ...(m
      ? {
          label: m.label,
          name: m.name,
          picture: m.picture,
          lastBackupAt: m.lastBackupAt,
          lastBackupBytes: m.lastBackupBytes,
          lastBackupItems: m.lastBackupItems,
          lastError: m.lastError,
          lastErrorAt: m.lastErrorAt,
          usedBytes: m.usedBytes,
          lastUploadBytes: m.lastUploadBytes,
          waitingFor: m.waitingFor
        }
      : {})
  }
}

export const status = (id: string): BackupStatus => statusOf(pick(id))

/** Every provider with its fields, the values that are not secret and which secrets are already saved. */
export function list(): BackupEntry[] {
  return PROVIDERS.map((p) => {
    const info = p.info()
    const saved = loadBackupConfig()[p.id] ?? {}
    return {
      info,
      status: statusOf(p),
      values: Object.fromEntries(info.fields.filter((f) => !f.secret).map((f) => [f.key, saved[f.key] ?? ''])),
      saved: info.fields.filter((f) => f.secret && getSecret(secretKey(p.id, f.key))).map((f) => f.key)
    }
  })
}

/** A field that is not in `values` keeps what it has; an empty string clears it. */
export function setConfig(id: string, values: Record<string, string>): BackupStatus {
  const p = pick(id)
  const fields = p.info().fields
  const all = loadBackupConfig()
  const next = { ...(all[p.id] ?? {}) }
  for (const f of fields) {
    const v = values?.[f.key]
    if (v === undefined) continue
    if (typeof v !== 'string' || v.length > FIELD_MAX) throw new BackupError(tr("Câmpul {field} nu e valid.", { field: f.label }))
    if (f.secret) setSecret(secretKey(p.id, f.key), v.trim() || undefined)
    else next[f.key] = v.trim()
  }
  all[p.id] = next
  saveBackupConfig(all)
  return statusOf(p)
}

/** Signs in (the browser opens for OAuth providers) or checks the credentials; `open` is how a page gets opened (tests pass their own). */
export async function connect(id: string, open: Opener = (u) => shell.openExternal(u)): Promise<BackupStatus> {
  const p = pick(id)
  if (!configured(p)) throw new BackupError(tr("Completează mai întâi câmpurile de conectare."))
  const who = await p.connect(config(p), open)
  const all = loadBackupAccounts()
  const prev = all[p.id]
  // another account: nothing of the first one stays here (its backup stays in its own storage)
  if (prev && prev.sub !== who.sub) {
    setSecret(passKey(p.id, prev.sub), undefined)
    forgetCache(p.id)
  }
  // a new connection backs up by itself from now on (the user can turn that off)
  all[p.id] =
    prev?.sub === who.sub
      ? { ...prev, label: who.label, name: who.name, picture: who.picture }
      : { sub: who.sub, label: who.label, name: who.name, picture: who.picture, autoUpdate: true }
  saveBackupAccounts(all)
  if (getSecret(passKey(p.id, who.sub))) kick(p.id)
  return statusOf(p)
}

const pictureTried = new Set<string>()

/** An account connected before pictures were kept gets its picture now, once per run; true when one was added. */
export async function fillPictures(): Promise<boolean> {
  const all = loadBackupAccounts()
  let changed = false
  for (const p of PROVIDERS) {
    const m = all[p.id]
    if (!m || m.picture || !p.identity || pictureTried.has(p.id)) continue
    pictureTried.add(p.id)
    try {
      const who = await p.identity(config(p))
      if (who.sub === m.sub && who.picture) {
        all[p.id] = { ...m, picture: who.picture }
        changed = true
      }
    } catch {
      // offline or signed out: the letter stays
    }
  }
  if (changed) saveBackupAccounts(all)
  return changed
}

/** Forgets the account on this PC: tokens, password and notes. The backup stays where it is; the password opens it again. */
export async function disconnect(id: string): Promise<BackupStatus> {
  const p = pick(id)
  const all = loadBackupAccounts()
  const m = all[p.id]
  await p.disconnect?.(config(p)).catch(() => undefined)
  if (m) {
    setSecret(passKey(p.id, m.sub), undefined)
    forgetKeys(`${p.id}:${m.sub}`)
  }
  forgetCache(p.id)
  delete all[p.id]
  saveBackupAccounts(all)
  return statusOf(p)
}

export function setPassword(id: string, password: string): BackupStatus {
  const p = pick(id)
  const m = account(p)
  if (typeof password !== 'string' || password.length < PASSWORD_MIN || password.length > 200) throw new BackupError(tr("Parola de backup are cel puțin {n} caractere.", { n: PASSWORD_MIN }))
  setSecret(passKey(p.id, m.sub), password)
  forgetKeys(`${p.id}:${m.sub}`)
  // the first backup starts now (it waits if the storage already holds another PC's backup)
  if (m.autoUpdate !== false) kick(p.id)
  return statusOf(p)
}

/** The "Update automatically" switch of one storage. */
export function setAuto(id: string, on: boolean): BackupStatus {
  const p = pick(id)
  const m = account(p)
  patchMeta(p.id, m.sub, { autoUpdate: on === true })
  if (on === true) kick(p.id)
  return statusOf(p)
}

/** What the storage holds: the time of the newest incremental version (or of an old single-file backup). */
export async function remote(id: string): Promise<RemoteBackup | null> {
  const p = pick(id)
  const m = account(p)
  const store = storeOf(p, config(p))
  const head = await store.find(HEAD)
  if (head) return { modifiedAt: head.modifiedAt, bytes: m.usedBytes ?? head.bytes }
  return store.find(FILE)
}

/** A backup by hand: also the way to start backing up this PC into a storage that holds another PC's backup. */
export async function run(id: string): Promise<BackupResult> {
  return (await runVault(id, false))!
}

/**
 * An old single-file backup: downloads it, decrypts it with `password` (the saved one when none is given) and opens
 * it for review, like an imported pack. A backup made by another account is refused, whatever its password.
 */
export async function restore(id: string, password?: string): Promise<ImportPreview> {
  const p = pick(id)
  const m = account(p)
  const pass = password || getSecret(passKey(p.id, m.sub))
  if (!pass) throw new BackupError(tr("Scrie parola de backup."))
  const cfg = config(p)
  if (!(await p.find(cfg))) throw new BackupError(tr("Nu există niciun backup în acest loc."))
  const { pack, time } = takeTime(decryptBackup(await p.get(cfg), pass))
  const preview = openPackBuffer(pack, true)
  if (preview.note !== m.sub) {
    await discard(preview.previewId)
    throw new BackupError(tr("Backup-ul e al altui cont."))
  }
  mergeTime(time)
  // a password typed here (new PC) is kept for the next backups
  if (password) setSecret(passKey(p.id, m.sub), password)
  return preview
}
