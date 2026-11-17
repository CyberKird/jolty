// What an incremental backup (the "vault") keeps in the storage, all flat object names so every provider can hold it:
//   jolty2-key          the master keys under the backup password (vault-crypto.ts)
//   jolty2-head         encrypted list of versions (snapshots) and packs; the only object rewritten in place
//   jolty2-s-<at>-<r>   one version: every file with the ids of its chunks, and where each chunk lives
//   jolty2-p-<hex>      a pack: encrypted, compressed chunks one after the other (about 8 MB)
// A run uploads only chunks the vault does not have yet, so a new message in one chat costs about one chunk.
import { gunzipSync, gzipSync } from 'zlib'
import { randomBytes } from 'crypto'
import type { RemoteBackup } from '@shared/backup'
import { openObject, sealObject, type VaultKeys } from './vault-crypto'

export const KEY = 'jolty2-key'
export const HEAD = 'jolty2-head'
/** fixed-size chunks: an append-only file (a chat) changes only its last chunk */
export const CHUNK = 1024 * 1024
/** packs are uploaded once they reach this size (under every provider's single-request limit) */
export const PACK_TARGET = 8 * 1024 * 1024
/** versions kept (plus the newest of every other PC that writes here) */
export const KEEP = 5

/** Where objects go: a provider with its config, or a map in tests. */
export interface Store {
  put(name: string, data: Buffer): Promise<void>
  get(name: string): Promise<Buffer>
  find(name: string): Promise<RemoteBackup | null>
  remove(name: string): Promise<void>
}

/** One file of a version. `p` is posix: data/... (the data folder), home/... (the home folder), pack/... (virtual). */
export interface FileRec {
  p: string
  /** size and mtime as seen when it was read */
  s: number
  m: number
  /** chunk ids in order */
  b: string[]
}

/** Where a chunk is: pack name, offset and length of the sealed bytes, and the plain length. */
export type BlobLoc = [pack: string, offset: number, length: number, raw: number]

/** The PC a version comes from, so a restore can map its folders onto the new PC. */
export interface Origin {
  host: string
  platform: string
  home: string
  data: string
  app: string
}

export interface Snapshot {
  v: 2
  at: number
  origin: Origin
  files: FileRec[]
  blobs: Record<string, BlobLoc>
}

export interface SnapInfo {
  name: string
  at: number
  host: string
  files: number
  /** sum of the plain sizes of the files */
  raw: number
  /** size of the snapshot object itself */
  bytes: number
  /** the packs this version needs */
  packs: string[]
}

export interface Head {
  v: 2
  repo: string
  /** changes on every write: another PC that wrote in between is noticed */
  rev: string
  snaps: SnapInfo[]
  packs: Record<string, { bytes: number }>
}

export const emptyHead = (repo: string): Head => ({ v: 2, repo, rev: '', snaps: [], packs: {} })
export const newRev = (): string => randomBytes(8).toString('hex')
export const packName = (): string => `jolty2-p-${randomBytes(8).toString('hex')}`
export const snapName = (at: number): string => `jolty2-s-${at.toString(36)}-${randomBytes(3).toString('hex')}`

/** Every byte the vault keeps in the storage (key object left out: under 1 KB). */
export const usedBytes = (h: Head): number => Object.values(h.packs).reduce((a, p) => a + p.bytes, 0) + h.snaps.reduce((a, s) => a + s.bytes, 0)

export const encodeObject = (keys: VaultKeys, name: string, value: unknown): Buffer => sealObject(keys, name, gzipSync(Buffer.from(JSON.stringify(value))))
export const decodeObject = <T>(keys: VaultKeys, name: string, data: Buffer): T => JSON.parse(gunzipSync(openObject(keys, name, data)).toString('utf8')) as T

export async function readHead(store: Store, keys: VaultKeys): Promise<Head | null> {
  if (!(await store.find(HEAD))) return null
  const h = decodeObject<Head>(keys, HEAD, await store.get(HEAD))
  return h.v === 2 && h.repo === keys.repo ? h : null
}

export async function readSnap(store: Store, keys: VaultKeys, name: string): Promise<Snapshot> {
  return decodeObject<Snapshot>(keys, name, await store.get(name))
}

/**
 * Keeps the newest KEEP versions, plus the newest one of every PC that has none among them (so a second PC backing
 * up to the same place never loses its only version to the first one).
 */
export function retain(snaps: SnapInfo[], keep = KEEP): { kept: SnapInfo[]; dropped: SnapInfo[] } {
  const sorted = [...snaps].sort((a, b) => b.at - a.at)
  const kept = sorted.slice(0, keep)
  for (const s of sorted.slice(keep)) if (!kept.some((k) => k.host === s.host)) kept.push(s)
  return { kept: kept.sort((a, b) => a.at - b.at), dropped: sorted.filter((s) => !kept.includes(s)) }
}

/** Packs no kept version needs any more. */
export function deadPacks(head: Head, kept: SnapInfo[]): string[] {
  const live = new Set(kept.flatMap((s) => s.packs))
  return Object.keys(head.packs).filter((p) => !live.has(p))
}
