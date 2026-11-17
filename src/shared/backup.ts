// Backup of the whole personalization to a storage the user owns (main/backup/*). The interface shows what is here;
// the providers themselves (Google Drive, Dropbox, OneDrive, Box, GitHub, WebDAV, S3, a folder) live in main.

export type ProviderId = 'google' | 'dropbox' | 'onedrive' | 'box' | 'github' | 'webdav' | 's3' | 'folder'

export interface ProviderField {
  key: string
  label: string
  /** kept in the OS keychain, never sent back to the page */
  secret?: boolean
  placeholder?: string
  optional?: boolean
}

/** What the page needs to draw one storage: words come from main already in the language of the interface. */
export interface ProviderInfo {
  id: ProviderId
  name: string
  /** oauth: the browser signs in; credentials: the fields below are the sign-in */
  kind: 'oauth' | 'credentials'
  /** filled once before Connect (an OAuth client id, an address and keys, a folder) */
  fields: ProviderField[]
  /** where to get those values, one or two sentences */
  help: string
}

export interface BackupStatus {
  id: ProviderId
  /** every required field is filled */
  configured: boolean
  connected: boolean
  /** who is connected: an e-mail, a user name, a folder */
  label?: string
  name?: string
  /** the account's picture as a data: URL */
  picture?: string
  /** a backup password is saved on this PC for the connected account */
  hasPassword: boolean
  lastBackupAt?: number
  lastBackupBytes?: number
  lastBackupItems?: number
  /** back up by itself after changes (on unless the user turned it off) */
  autoUpdate: boolean
  /** a backup of this storage is running now */
  running?: boolean
  /** the last automatic or manual run failed: shown calmly, retried with a growing pause */
  lastError?: string
  lastErrorAt?: number
  /** everything the backup keeps in the storage (all kept versions) */
  usedBytes?: number
  /** bytes the last run sent */
  lastUploadBytes?: number
  /** the storage holds a backup from another PC and this PC has not chosen yet: no automatic run until it does */
  waitingFor?: { host: string; at: number }
}

/** One storage as the Account tab shows it. `values` holds the fields that are not secret. */
export interface BackupEntry {
  info: ProviderInfo
  status: BackupStatus
  values: Record<string, string>
  /** secret fields that already have a value */
  saved: string[]
}

/** What the storage of the connected account holds: nothing when there is no backup yet. */
export interface RemoteBackup {
  modifiedAt: number
  bytes: number
}

export interface BackupResult {
  at: number
  items: number
  bytes: number
  /** files left out (a program over 20 MB, for example) */
  skipped: number
  /** nothing changed since the last version: nothing was sent */
  unchanged?: boolean
  /** everything the backup keeps in the storage */
  used?: number
}

/** One kept version of an incremental backup. */
export interface BackupVersion {
  name: string
  at: number
  /** the PC it was made on */
  host: string
  files: number
  /** plain size of everything in it */
  raw: number
}

/** What a restore would bring back, shown before anything changes. */
export interface RestoreInfo {
  /** newest first */
  versions: BackupVersion[]
  /** details of the newest version */
  chats: number
  profiles: number
  /** skills, commands, instructions or MCP servers are in it */
  personal: boolean
  app?: string
  /** a backup made before incremental backups (one file, restored through the import review) */
  legacy?: RemoteBackup
  used: number
}

export interface RestoreProgress {
  id: ProviderId
  phase: 'download' | 'ready' | 'error'
  done: number
  total: number
  error?: string
}

/** What the last restore did, shown once after Jolty restarts. */
export interface RestoreReport {
  at: number
  versionAt: number
  host: string
  files: number
  previous?: string
  missing: string[]
  /** skills and the rest outside the data folder that were put back */
  personal?: number
}

/** The set of numbers on the Account tab. Times are milliseconds. */
export interface UseStats {
  /** time at least one chat was working */
  aiMs: number
  /** time Jolty was in front */
  appMs: number
  /** the history before counting began is estimated for aiMs from the saved turns */
  estimatedMs: number
  /** when counting began */
  since: number
  turns: number
  tokens: number
  chats: number
  activeDays: number
}
