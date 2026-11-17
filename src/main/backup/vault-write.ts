// One incremental backup run: reads only files whose size or time changed, cuts them into chunks, uploads only the
// chunks the vault does not hold yet (packed, compressed, encrypted), then writes the new version and the head and
// deletes what no kept version needs. A run with nothing changed uploads nothing.
import fs from 'fs/promises'
import { createHash } from 'crypto'
import { deflateRaw } from 'zlib'
import { promisify } from 'util'
import { blobId, sealBlob, type VaultKeys } from './vault-crypto'
import {
  CHUNK,
  deadPacks,
  emptyHead,
  encodeObject,
  HEAD,
  newRev,
  PACK_TARGET,
  packName,
  readHead,
  readSnap,
  retain,
  snapName,
  usedBytes,
  type BlobLoc,
  type FileRec,
  type Head,
  type Origin,
  type Snapshot,
  type Store
} from './vault-format'

const deflate = promisify(deflateRaw)
const breathe = (): Promise<void> => new Promise((r) => setImmediate(r))

/** A file to back up: on disk (`abs`) or made on the spot (`read`, e.g. the pack of skills). */
export interface Source {
  p: string
  abs?: string
  size: number
  mtime: number
  read?: () => Promise<Buffer>
}

/** What this PC remembers about the vault between runs (backup-state/<provider>.json). */
export interface LocalCache {
  repo?: string
  rev?: string
  /** fingerprint of the newest version's file list */
  sig?: string
  files: Record<string, { s: number; m: number; b: string[] }>
  /** the chunks the newest version references: anything here need not be uploaded again */
  blobs: Record<string, BlobLoc>
}

export interface WriteResult {
  at: number
  /** nothing changed since the last version: nothing was uploaded */
  unchanged: boolean
  files: number
  raw: number
  /** bytes sent to the storage in this run */
  uploaded: number
  newChunks: number
  /** everything the vault keeps now */
  used: number
  snapshot?: string
}

export interface WriteOptions {
  store: Store
  keys: VaultKeys
  sources: Source[]
  cache: LocalCache
  origin: Origin
  keep?: number
  packTarget?: number
  signal?: AbortSignal
}

const sigOf = (files: FileRec[]): string => {
  const h = createHash('sha256')
  for (const f of [...files].sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0))) h.update(`${f.p}\0${f.b.join(',')}\n`)
  return h.digest('hex')
}

/** Reads a file chunk by chunk; the size is what was actually there (a file may grow while it is read). */
async function* chunksOf(src: Source): AsyncGenerator<Buffer> {
  if (src.read) {
    const all = await src.read()
    for (let o = 0; o < all.length; o += CHUNK) yield all.subarray(o, o + CHUNK)
    return
  }
  const fh = await fs.open(src.abs!, 'r')
  try {
    for (let pos = 0; pos < src.size; ) {
      const buf = Buffer.alloc(Math.min(CHUNK, src.size - pos))
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos)
      if (!bytesRead) break
      pos += bytesRead
      yield bytesRead === buf.length ? buf : buf.subarray(0, bytesRead)
    }
  } finally {
    await fh.close()
  }
}

export async function writeVersion(o: WriteOptions): Promise<WriteResult> {
  const { store, keys, cache } = o
  const target = o.packTarget ?? PACK_TARGET
  const head0 = (await readHead(store, keys)) ?? emptyHead(keys.repo)
  // another PC wrote since our last run (or this PC never ran): our memory of the vault is rebuilt from the newest version
  if (cache.repo !== keys.repo || cache.rev !== head0.rev) {
    cache.repo = keys.repo
    cache.files = {}
    cache.blobs = {}
    cache.sig = undefined
    const newest = head0.snaps[head0.snaps.length - 1]
    if (newest) {
      const snap = await readSnap(store, keys, newest.name)
      cache.blobs = snap.blobs
      cache.sig = sigOf(snap.files)
    }
    cache.rev = head0.rev
  }

  const locs: Record<string, BlobLoc> = { ...cache.blobs }
  const newPacks: Record<string, { bytes: number }> = {}
  let parts: Buffer[] = []
  let entries: [string, number, number, number][] = []
  let packBytes = 0
  let uploaded = 0
  let newChunks = 0

  const flush = async (): Promise<void> => {
    if (!parts.length) return
    const name = packName()
    const data = Buffer.concat(parts)
    await store.put(name, data)
    for (const [id, off, len, raw] of entries) locs[id] = [name, off, len, raw]
    newPacks[name] = { bytes: data.length }
    uploaded += data.length
    parts = []
    entries = []
    packBytes = 0
  }
  const pending = new Set<string>()
  const add = async (chunk: Buffer): Promise<string> => {
    const id = blobId(keys, chunk)
    if (locs[id] || pending.has(id)) return id
    const box = sealBlob(keys, id, await deflate(chunk, { level: 6 }))
    entries.push([id, packBytes, box.length, chunk.length])
    parts.push(box)
    pending.add(id)
    packBytes += box.length
    newChunks++
    if (packBytes >= target) {
      await flush()
      pending.clear()
    }
    return id
  }

  const files: FileRec[] = []
  const nextCache: LocalCache['files'] = {}
  let raw = 0
  for (const src of o.sources) {
    if (o.signal?.aborted) throw new Error('aborted')
    const was = cache.files[src.p]
    let rec: FileRec
    // a file made on the spot has no size before it is built (-1): its time is a fingerprint of what goes in it
    if (was && (src.size < 0 || was.s === src.size) && was.m === src.mtime && was.b.every((id) => locs[id])) {
      rec = { p: src.p, s: was.s, m: was.m, b: was.b }
    } else {
      const ids: string[] = []
      let size = 0
      try {
        for await (const chunk of chunksOf(src)) {
          size += chunk.length
          ids.push(await add(chunk))
          await breathe()
        }
      } catch (e) {
        // a file that vanished or got locked between the listing and the read is left for the next run
        if (o.signal?.aborted) throw e
        continue
      }
      rec = { p: src.p, s: size, m: src.mtime, b: ids }
    }
    files.push(rec)
    nextCache[src.p] = { s: rec.s, m: rec.m, b: rec.b }
    raw += rec.s
  }

  const sig = sigOf(files)
  if (sig === cache.sig && head0.snaps.length && !parts.length && !Object.keys(newPacks).length) {
    cache.files = nextCache
    return { at: Date.now(), unchanged: true, files: files.length, raw, uploaded: 0, newChunks: 0, used: usedBytes(head0) }
  }
  await flush()

  const at = Date.now()
  const blobs: Record<string, BlobLoc> = {}
  for (const f of files) for (const id of f.b) blobs[id] = locs[id]
  const snap: Snapshot = { v: 2, at, origin: o.origin, files, blobs }
  const name = snapName(at)
  const body = encodeObject(keys, name, snap)
  await store.put(name, body)
  uploaded += body.length

  // the head is read again right before it is written, so a version another PC wrote meanwhile is kept
  const fresh = (await readHead(store, keys)) ?? emptyHead(keys.repo)
  const packs = { ...fresh.packs, ...newPacks }
  const needs = [...new Set(Object.values(blobs).map((l) => l[0]))]
  if (needs.some((p) => !packs[p])) {
    // another PC pruned a pack this version relies on while we ran: forget what we knew, the next run uploads it again
    await store.remove(name).catch(() => undefined)
    cache.rev = undefined
    throw new Error('vault changed during the run')
  }
  const merged: Head = { ...fresh, packs, snaps: [...fresh.snaps, { name, at, host: o.origin.host, files: files.length, raw, bytes: body.length, packs: needs }] }
  const { kept, dropped } = retain(merged.snaps, o.keep)
  const dead = deadPacks(merged, kept)
  const next: Head = { ...merged, rev: newRev(), snaps: kept, packs: Object.fromEntries(Object.entries(merged.packs).filter(([p]) => !dead.includes(p))) }
  const headBody = encodeObject(keys, HEAD, next)
  await store.put(HEAD, headBody)
  uploaded += headBody.length

  // deletes only after the head no longer names them: a crash here leaves stray objects, never a broken version
  for (const s of dropped) await store.remove(s.name).catch(() => undefined)
  for (const p of dead) await store.remove(p).catch(() => undefined)

  cache.rev = next.rev
  cache.sig = sig
  cache.files = nextCache
  cache.blobs = blobs
  return { at, unchanged: false, files: files.length, raw, uploaded, newChunks, used: usedBytes(next), snapshot: name }
}
