// "Compact now": packs where most chunks belong to versions that were dropped still take their full size. Their
// live chunks are copied (still sealed, never decrypted) into new packs, the kept versions are pointed at them, and
// the old packs are deleted once the head no longer names them.
import { encodeObject, HEAD, newRev, PACK_TARGET, packName, readHead, readSnap, usedBytes, type BlobLoc, type Snapshot, type Store } from './vault-format'
import type { VaultKeys } from './vault-crypto'

export interface CompactResult {
  before: number
  after: number
  /** packs rewritten or deleted */
  packs: number
}

/** Rewrites packs whose live share is under `threshold`; `onlyMeasure` returns what it would free without changing anything. */
export async function compact(store: Store, keys: VaultKeys, threshold = 0.5, onlyMeasure = false): Promise<CompactResult & { waste: number }> {
  const head = await readHead(store, keys)
  if (!head) return { before: 0, after: 0, packs: 0, waste: 0 }
  const before = usedBytes(head)
  const snaps = new Map<string, Snapshot>()
  for (const s of head.snaps) snaps.set(s.name, await readSnap(store, keys, s.name))
  // the live chunks of every pack, once each
  const live = new Map<string, Map<string, BlobLoc>>()
  for (const snap of snaps.values())
    for (const [id, loc] of Object.entries(snap.blobs)) {
      if (!live.has(loc[0])) live.set(loc[0], new Map())
      live.get(loc[0])!.set(id, loc)
    }
  const liveBytes = (p: string): number => [...(live.get(p)?.values() ?? [])].reduce((a, l) => a + l[2], 0)
  const dead = Object.keys(head.packs).filter((p) => !live.has(p))
  const sparse = Object.keys(head.packs).filter((p) => live.has(p) && liveBytes(p) < head.packs[p].bytes * threshold)
  const waste = Object.entries(head.packs).reduce((a, [p, v]) => a + v.bytes - liveBytes(p), 0)
  if (onlyMeasure || (!dead.length && !sparse.length)) return { before, after: before, packs: 0, waste }

  const moved = new Map<string, BlobLoc>()
  const packs = { ...head.packs }
  let parts: Buffer[] = []
  let entries: [string, number, number, number][] = []
  let size = 0
  const flush = async (): Promise<void> => {
    if (!parts.length) return
    const name = packName()
    const data = Buffer.concat(parts)
    await store.put(name, data)
    for (const [id, off, len, raw] of entries) moved.set(id, [name, off, len, raw])
    packs[name] = { bytes: data.length }
    parts = []
    entries = []
    size = 0
  }
  for (const p of sparse) {
    const data = await store.get(p)
    for (const [id, [, off, len, raw]] of live.get(p)!) {
      entries.push([id, size, len, raw])
      parts.push(data.subarray(off, off + len))
      size += len
      if (size >= PACK_TARGET) await flush()
    }
  }
  await flush()

  // the kept versions point at the new packs before the head stops naming the old ones
  const infos = head.snaps.map((s) => ({ ...s }))
  for (const info of infos) {
    const snap = snaps.get(info.name)!
    let changed = false
    for (const id of Object.keys(snap.blobs)) {
      const to = moved.get(id)
      if (to) {
        snap.blobs[id] = to
        changed = true
      }
    }
    if (!changed) continue
    const body = encodeObject(keys, info.name, snap)
    await store.put(info.name, body)
    info.bytes = body.length
    info.packs = [...new Set(Object.values(snap.blobs).map((l) => l[0]))]
  }
  for (const p of [...dead, ...sparse]) delete packs[p]
  const next = { ...head, rev: newRev(), snaps: infos, packs }
  await store.put(HEAD, encodeObject(keys, HEAD, next))
  for (const p of [...dead, ...sparse]) await store.remove(p).catch(() => undefined)
  return { before, after: usedBytes(next), packs: dead.length + sparse.length, waste: 0 }
}
