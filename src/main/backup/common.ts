// What the backup modules share: the provider by id, its filled fields, the connected account and its notes.
import type { ProviderId } from '@shared/backup'
import { tr } from '@shared/i18n'
import { getSecret, loadBackupAccounts, loadBackupConfig, saveBackupAccounts, type AccountMeta } from '../store'
import { provider as lookup } from './providers'
import { BackupError, type Config, type Provider } from './types'

export const secretKey = (id: ProviderId, field: string): string => `backup:${id}:field:${field}`
export const passKey = (id: ProviderId, sub: string): string => `backup:${id}:pass:${sub}`

export function pick(id: string): Provider {
  const p = lookup(id)
  if (!p) throw new BackupError(tr("Locul de backup nu există."))
  return p
}

/** The filled fields, secrets included: what a provider works with. */
export function config(p: Provider): Config {
  const saved = loadBackupConfig()[p.id] ?? {}
  const cfg: Config = {}
  for (const f of p.info().fields) cfg[f.key] = (f.secret ? getSecret(secretKey(p.id, f.key)) : saved[f.key]) ?? ''
  return cfg
}

export function account(p: Provider): AccountMeta {
  const m = loadBackupAccounts()[p.id]
  if (!m) throw new BackupError(tr("Contul nu e conectat."))
  return m
}

export const password = (p: Provider, m: AccountMeta): string | undefined => getSecret(passKey(p.id, m.sub))

/** Changes the notes of the connected account, if it is still the same account. */
export function patchMeta(id: ProviderId, sub: string, patch: Partial<AccountMeta>): void {
  const all = loadBackupAccounts()
  const m = all[id]
  if (!m || m.sub !== sub) return
  const next: AccountMeta = { ...m, ...patch }
  for (const k of Object.keys(patch) as (keyof AccountMeta)[]) if (patch[k] === undefined) delete next[k]
  all[id] = next
  saveBackupAccounts(all)
}
