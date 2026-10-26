// Backup of the whole personalization to a storage the user owns (Google Drive, OneDrive, Dropbox, Box, GitHub,
// WebDAV, S3, a folder). Several can be connected at once; each keeps one account at a time and its own backup, so
// nothing mixes between accounts. What goes up is the full pack of share-pack.ts (skills, commands, instructions,
// settings, accounts without keys, schedules, MCP servers), encrypted here with a password: the storage only ever
// holds ciphertext. Restore opens the decrypted pack in the same review screen as an import (share-pack.ts), which
// keeps a copy of what it replaces.
import { shell } from 'electron'
import type { BackupEntry, BackupResult, BackupStatus, ProviderId, RemoteBackup } from '@shared/backup'
import type { ImportPreview } from '@shared/skills'
import { tr } from '@shared/i18n'
import { getSecret, loadBackupAccounts, loadBackupConfig, saveBackupAccounts, saveBackupConfig, setSecret, type AccountMeta } from '../store'
import { backupKeys, buildPack, discard, openPackBuffer } from '../share-pack'
import { mergeTime, takeTime, withTime } from '../use-time'
import { decryptBackup, encryptBackup } from './crypto'
import { PROVIDERS, provider as lookup } from './providers'
import { BackupError, type Config, type Opener, type Provider } from './types'

export { decryptBackup, encryptBackup }
export { BackupError }

const PASSWORD_MIN = 8
const FIELD_MAX = 2000
const secretKey = (id: ProviderId, field: string): string => `backup:${id}:field:${field}`
const passKey = (id: ProviderId, sub: string): string => `backup:${id}:pass:${sub}`

function pick(id: string): Provider {
  const p = lookup(id)
  if (!p) throw new BackupError(tr("Locul de backup nu există."))
  return p
}

/** The filled fields, secrets included: what a provider works with. */
function config(p: Provider): Config {
  const saved = loadBackupConfig()[p.id] ?? {}
  const cfg: Config = {}
  for (const f of p.info().fields) cfg[f.key] = (f.secret ? getSecret(secretKey(p.id, f.key)) : saved[f.key]) ?? ''
  return cfg
}

const configured = (p: Provider): boolean => {
  const cfg = config(p)
  return p.info().fields.every((f) => f.optional || cfg[f.key]?.trim())
}

function account(p: Provider): AccountMeta {
  const m = loadBackupAccounts()[p.id]
  if (!m) throw new BackupError(tr("Contul nu e conectat."))
  return m
}

function statusOf(p: Provider): BackupStatus {
  const m = loadBackupAccounts()[p.id]
  return {
    id: p.id,
    configured: configured(p),
    connected: !!m,
    hasPassword: !!m && !!getSecret(passKey(p.id, m.sub)),
    ...(m ? { label: m.label, name: m.name, lastBackupAt: m.lastBackupAt, lastBackupBytes: m.lastBackupBytes, lastBackupItems: m.lastBackupItems } : {})
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
  if (prev && prev.sub !== who.sub) setSecret(passKey(p.id, prev.sub), undefined)
  all[p.id] = prev?.sub === who.sub ? { ...prev, label: who.label, name: who.name } : { sub: who.sub, label: who.label, name: who.name }
  saveBackupAccounts(all)
  return statusOf(p)
}

/** Forgets the account on this PC: tokens, password and notes. The backup stays where it is; the password opens it again. */
export async function disconnect(id: string): Promise<BackupStatus> {
  const p = pick(id)
  const all = loadBackupAccounts()
  const m = all[p.id]
  await p.disconnect?.(config(p)).catch(() => undefined)
  if (m) setSecret(passKey(p.id, m.sub), undefined)
  delete all[p.id]
  saveBackupAccounts(all)
  return statusOf(p)
}

export function setPassword(id: string, password: string): BackupStatus {
  const p = pick(id)
  const m = account(p)
  if (typeof password !== 'string' || password.length < PASSWORD_MIN || password.length > 200) throw new BackupError(tr("Parola de backup are cel puțin {n} caractere.", { n: PASSWORD_MIN }))
  setSecret(passKey(p.id, m.sub), password)
  return statusOf(p)
}

export async function remote(id: string): Promise<RemoteBackup | null> {
  const p = pick(id)
  account(p)
  return p.find(config(p))
}

export async function run(id: string): Promise<BackupResult> {
  const p = pick(id)
  const m = account(p)
  const password = getSecret(passKey(p.id, m.sub))
  if (!password) throw new BackupError(tr("Alege mai întâi o parolă de backup."))
  const { buf, result } = buildPack({ keys: backupKeys(), name: 'Jolty backup', author: m.label.slice(0, 100), note: m.sub }, true)
  const blob = encryptBackup(withTime(buf), password)
  await p.put(config(p), blob)
  const at = Date.now()
  const all = loadBackupAccounts()
  all[p.id] = { ...m, lastBackupAt: at, lastBackupBytes: blob.length, lastBackupItems: result.items }
  saveBackupAccounts(all)
  return { at, items: result.items, bytes: blob.length, skipped: result.skipped.length }
}

/**
 * Downloads the backup, decrypts it with `password` (the saved one when none is given) and opens it for review, like
 * an imported pack. A backup made by another account is refused, whatever its password.
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
