// What every backup storage provides (Google Drive, Dropbox, OneDrive, Box, GitHub, WebDAV, S3, a folder). The
// orchestrator (index.ts) encrypts the backup before it gets here, so a provider only moves opaque bytes.
import type { ProviderId, ProviderInfo, RemoteBackup } from '@shared/backup'

export class BackupError extends Error {}

/** How the sign-in page gets opened (tests pass their own instead of the system browser). */
export type Opener = (url: string) => unknown
/** The fields of a provider with their values; secret fields are filled in from the keychain. */
export type Config = Record<string, string>
/** Whose storage it is: `sub` is stable and different for every account. */
export interface Who {
  sub: string
  label: string
  name?: string
  /** the account's picture as a data: URL, so the page shows it without any remote request */
  picture?: string
}

/** A small profile picture as a data: URL; any failure just means no picture. */
export async function fetchPicture(url: unknown, init: RequestInit = {}): Promise<string | undefined> {
  try {
    if (typeof url !== 'string' || !/^https:\/\//i.test(url)) return undefined
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) })
    const type = res.headers.get('content-type') || ''
    if (!res.ok || !/^image\/(png|jpe?g|webp|gif)/i.test(type)) return undefined
    const bytes = Buffer.from(await res.arrayBuffer())
    return bytes.length > 0 && bytes.length <= 300_000 ? `data:${type.split(';')[0]};base64,${bytes.toString('base64')}` : undefined
  } catch {
    return undefined
  }
}

/** The one file every provider kept before incremental backups (still read, never written by them). */
export const FILE = 'jolty-backup.enc'

/** Names of the objects a provider may store: the old single file and the incremental ones (jolty2-...). */
export const NAME_RE = /^(jolty-backup\.enc|jolty2-[a-z0-9-]{1,80})$/

/** The object's name, checked: a provider never builds a path or a query from anything else. */
export function objectName(name?: string): string {
  const n = name ?? FILE
  if (!NAME_RE.test(n)) throw new BackupError('bad object name')
  return n
}

/** JOLTY_BACKUP_MOCK points the providers that have a fixed address at a local test server. */
export const mockBase = (): string | undefined => process.env.JOLTY_BACKUP_MOCK

export interface Provider {
  id: ProviderId
  /** texts in the language of the interface at the time of the call */
  info(): ProviderInfo
  /** signs in (OAuth providers open the browser) or checks the credentials, and says whose storage it is */
  connect(cfg: Config, open: Opener): Promise<Who>
  /** best effort at the provider's side (revoking a token); the caller removes what is kept here */
  disconnect?(cfg: Config): Promise<void>
  /** whose storage it is, from the tokens already kept (no sign-in); lets an account connected earlier get its picture */
  identity?(cfg: Config): Promise<Who>
  /** `name` is one object of the storage (objectName); without it, the old single backup file */
  find(cfg: Config, name?: string): Promise<RemoteBackup | null>
  put(cfg: Config, data: Buffer, name?: string): Promise<void>
  get(cfg: Config, name?: string): Promise<Buffer>
  /** deletes one object; a missing one is not an error */
  remove(cfg: Config, name: string): Promise<void>
}

/** `{ picture }` for a spread into the account, or nothing. */
export async function pictureOf(url: unknown, init: RequestInit = {}): Promise<{ picture?: string }> {
  const picture = await fetchPicture(url, init)
  return picture ? { picture } : {}
}
