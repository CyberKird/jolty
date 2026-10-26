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
}

/** The one file every provider keeps, in an app folder or the place the user chose. */
export const FILE = 'jolty-backup.enc'

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
  find(cfg: Config): Promise<RemoteBackup | null>
  put(cfg: Config, data: Buffer): Promise<void>
  get(cfg: Config): Promise<Buffer>
}
