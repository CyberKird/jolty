// Restore, first half: downloads one version of the vault into a staging folder, pack by pack. Every chunk is
// authenticated (GCM) and its id checked against its plain bytes, so a damaged or swapped pack is refused. Packs
// already written are noted in a progress file: a restore cut off by a crash or a lost connection resumes there.
// The second half (vault-apply.ts) moves the staged files in place when Jolty starts again.
import fs from 'fs/promises'
import path from 'path'
import { inflateRaw } from 'zlib'
import { promisify } from 'util'
import { tr } from '@shared/i18n'
import { BackupError } from './types'
import { blobId, openBlob, type VaultKeys } from './vault-crypto'
import { readHead, readSnap, type Origin, type Snapshot, type Store } from './vault-format'

const inflate = promisify(inflateRaw)

export const PROGRESS = '.progress.json'
export const COMPLETE = '.complete.json'

/** What the staging folder holds once a download is complete; vault-apply.ts reads it at the next start. */
export interface Staged {
  v: 2
  snapshot: string
  at: number
  origin: Origin
  files: { p: string; s: number }[]
}

/** The newest version and what is in it, for the restore screen. */
export async function newestVersion(store: Store, keys: VaultKeys): Promise<{ name: string; snap: Snapshot } | null> {
  const head = await readHead(store, keys)
  const info = head?.snaps[head.snaps.length - 1]
  return info ? { name: info.name, snap: await readSnap(store, keys, info.name) } : null
}

/** A path from the vault, made safe to join under the staging folder: no absolute parts, no `..`, known roots only. */
export function stagedPath(root: string, p: string): string {
  const parts = p.split('/')
  if (!['data', 'home', 'pack'].includes(parts[0]) || parts.length < 2 || parts.some((s) => !s || s === '.' || s === '..' || /[\\:\0]/.test(s))) throw new BackupError(tr("Backup-ul e deteriorat."))
  return path.join(root, ...parts)
}

export interface DownloadProgress {
  done: number
  total: number
}

/** Downloads `snap` into `root` (created if missing); resumes from what an earlier attempt already wrote. */
export async function download(store: Store, keys: VaultKeys, name: string, snap: Snapshot, root: string, onProgress?: (p: DownloadProgress) => void, signal?: AbortSignal): Promise<Staged> {
  await fs.mkdir(root, { recursive: true })
  const progFile = path.join(root, PROGRESS)
  let doneSet = new Set<string>()
  try {
    const prog = JSON.parse(await fs.readFile(progFile, 'utf8')) as { snapshot?: string; packs?: string[] }
    // progress of another version is worthless: its files are rewritten from scratch
    if (prog.snapshot === name && Array.isArray(prog.packs)) doneSet = new Set(prog.packs)
  } catch {
    // first attempt
  }

  // where every chunk goes: one chunk can be in several files (or twice in one)
  const uses = new Map<string, { file: string; at: number }[]>()
  const byPack = new Map<string, string[]>()
  for (const f of snap.files) {
    const file = stagedPath(root, f.p)
    let at = 0
    for (const id of f.b) {
      const loc = snap.blobs[id]
      if (!loc) throw new BackupError(tr("Backup-ul e deteriorat."))
      if (!uses.has(id)) {
        uses.set(id, [])
        byPack.set(loc[0], [...(byPack.get(loc[0]) ?? []), id])
      }
      uses.get(id)!.push({ file, at })
      at += loc[3]
    }
  }
  // every file exists with its final size from the start (an empty file too), so chunks are written at their place
  for (const f of snap.files) {
    const file = stagedPath(root, f.p)
    const st = await fs.lstat(file).catch(() => null)
    if (st?.isFile() && st.size === f.s) continue
    if (st && !st.isFile()) throw new BackupError(tr("Backup-ul e deteriorat."))
    await fs.mkdir(path.dirname(file), { recursive: true })
    const fh = await fs.open(file, 'w')
    await fh.truncate(f.s)
    await fh.close()
    // a file rewritten from zero needs all its packs again
    for (const id of f.b) doneSet.delete(snap.blobs[id][0])
  }

  const packs = [...byPack.keys()]
  const total = packs.length
  let done = packs.filter((p) => doneSet.has(p)).length
  onProgress?.({ done, total })
  for (const pack of packs) {
    if (doneSet.has(pack)) continue
    if (signal?.aborted) throw new BackupError(tr("Restaurarea a fost oprită."))
    const data = await store.get(pack)
    for (const id of byPack.get(pack)!) {
      const [, off, len, raw] = snap.blobs[id]
      if (off + len > data.length) throw new BackupError(tr("Backup-ul e deteriorat."))
      const plain = await inflate(openBlob(keys, id, data.subarray(off, off + len)))
      if (plain.length !== raw || blobId(keys, plain) !== id) throw new BackupError(tr("Backup-ul e deteriorat."))
      for (const u of uses.get(id)!) {
        const fh = await fs.open(u.file, 'r+')
        try {
          await fh.write(plain, 0, plain.length, u.at)
        } finally {
          await fh.close()
        }
      }
    }
    doneSet.add(pack)
    await fs.writeFile(progFile, JSON.stringify({ snapshot: name, packs: [...doneSet] }))
    onProgress?.({ done: ++done, total })
  }

  const staged: Staged = { v: 2, snapshot: name, at: snap.at, origin: snap.origin, files: snap.files.map((f) => ({ p: f.p, s: f.s })) }
  await fs.writeFile(path.join(root, COMPLETE), JSON.stringify(staged))
  await fs.rm(progFile, { force: true })
  return staged
}
