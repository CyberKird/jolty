// The incremental backup as the Account tab and the automatic runs use it: one run, the restore screen's facts, the
// restore itself (download now, applied at the next start), compaction, and the report shown after the restart.
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { BackupResult, ProviderId, RestoreInfo, RestoreProgress, RestoreReport } from '@shared/backup'
import { tr } from '@shared/i18n'
import { dataDir, setSecret } from '../store'
import { apply, discard, openPackBuffer } from '../share-pack'
import { account, config, passKey, password as savedPassword, patchMeta, pick } from './common'
import { BackupError, FILE } from './types'
import { compact } from './vault-compact'
import { readHead, readSnap, usedBytes, type Store } from './vault-format'
import { download, newestVersion } from './vault-read'
import { PACK_FILE, REPORT, STAGING } from './vault-apply'
import { backupVault, forgetCache, keysFor, PACK_PATH, storeOf } from './vault'

let runningId: ProviderId | undefined
let progress: RestoreProgress | null = null

export const running = (): ProviderId | undefined => runningId
export const restoreProgress = (): RestoreProgress | null => progress

function open(id: string): { p: ReturnType<typeof pick>; m: ReturnType<typeof account>; store: Store; slot: string } {
  const p = pick(id)
  const m = account(p)
  return { p, m, store: storeOf(p, config(p)), slot: `${p.id}:${m.sub}` }
}

const message = (e: unknown): string => (e instanceof BackupError ? e.message : tr("Locul de backup nu a răspuns. Încerc din nou mai târziu."))

/**
 * One run. `auto` runs never write over a storage that holds another PC's backup until this PC chose (restored from
 * it, or backed up by hand): an empty new PC must not become the newest version.
 */
export async function runVault(id: string, auto = false, signal?: AbortSignal): Promise<BackupResult | null> {
  const { p, m, store, slot } = open(id)
  const pass = savedPassword(p, m)
  if (!pass) throw new BackupError(tr("Alege mai întâi o parolă de backup."))
  if (runningId) {
    if (auto) return null
    throw new BackupError(tr("Un backup e deja în lucru."))
  }
  runningId = p.id
  try {
    const keys = (await keysFor(slot, store, pass, true))!
    if (!m.linked) {
      const head = await readHead(store, keys)
      const other = head?.snaps.filter((s) => s.host !== os.hostname()).pop()
      if (auto && other && !head!.snaps.some((s) => s.host === os.hostname())) {
        patchMeta(p.id, m.sub, { waitingFor: { host: other.host, at: other.at } })
        return null
      }
    }
    const r = await backupVault(p.id, store, keys, signal)
    patchMeta(p.id, m.sub, {
      linked: true,
      waitingFor: undefined,
      lastError: undefined,
      lastErrorAt: undefined,
      usedBytes: r.used,
      ...(r.unchanged ? {} : { lastBackupAt: r.at, lastBackupItems: r.files, lastBackupBytes: r.raw, lastUploadBytes: r.uploaded })
    })
    return { at: r.at, items: r.files, bytes: r.uploaded, skipped: 0, unchanged: r.unchanged, used: r.used }
  } catch (e) {
    patchMeta(p.id, m.sub, { lastError: message(e), lastErrorAt: Date.now() })
    throw e instanceof BackupError ? e : new BackupError(message(e))
  } finally {
    runningId = undefined
  }
}

/** Everything the restore screen shows before anything changes. `pass` when the saved one is not there or not right. */
export async function inspect(id: string, pass?: string): Promise<RestoreInfo> {
  const { p, m, store, slot } = open(id)
  const pw = pass || savedPassword(p, m)
  const legacy = await store.find(FILE).catch(() => null)
  if (!pw) throw new BackupError(tr("Scrie parola de backup."))
  const keys = await keysFor(slot, store, pw, false)
  const head = keys ? await readHead(store, keys) : null
  if (!keys || !head?.snaps.length) {
    if (!legacy) throw new BackupError(tr("Nu există niciun backup în acest loc."))
    return { versions: [], chats: 0, profiles: 0, personal: false, legacy, used: 0 }
  }
  const newest = (await newestVersion(store, keys))!
  const files = newest.snap.files.map((f) => f.p)
  return {
    versions: [...head.snaps].reverse().map((s) => ({ name: s.name, at: s.at, host: s.host, files: s.files, raw: s.raw })),
    chats: files.filter((f) => /^data\/transcripts\/[^/]+\.json$/.test(f)).length,
    profiles: new Set(files.map((f) => /^data\/profiles\/([^/]+)\//.exec(f)?.[1]).filter(Boolean)).size,
    personal: files.includes(PACK_PATH),
    app: newest.snap.origin.app,
    ...(legacy ? { legacy } : {}),
    used: usedBytes(head)
  }
}

/** Downloads a version into the staging folder; Jolty applies it when it starts again (relaunch). */
export async function restoreAll(id: string, version?: string, pass?: string): Promise<void> {
  const { p, m, store, slot } = open(id)
  const pw = pass || savedPassword(p, m)
  if (!pw) throw new BackupError(tr("Scrie parola de backup."))
  if (runningId || progress?.phase === 'download') throw new BackupError(tr("Un backup e deja în lucru."))
  runningId = p.id
  progress = { id: p.id, phase: 'download', done: 0, total: 0 }
  try {
    const keys = await keysFor(slot, store, pw, false)
    const head = keys ? await readHead(store, keys) : null
    const info = head?.snaps.find((s) => s.name === version) ?? head?.snaps[head.snaps.length - 1]
    if (!keys || !info) throw new BackupError(tr("Nu există niciun backup în acest loc."))
    await download(store, keys, info.name, await readSnap(store, keys, info.name), path.join(dataDir(), STAGING), (pr) => (progress = { id: p.id, phase: 'download', ...pr }))
    // this PC now continues that backup: the password is kept and automatic runs may write
    if (pass) setSecret(passKey(p.id, m.sub), pass)
    patchMeta(p.id, m.sub, { linked: true, waitingFor: undefined })
    forgetCache(p.id)
    progress = { ...progress, phase: 'ready' }
  } catch (e) {
    progress = { id: p.id, phase: 'error', done: progress?.done ?? 0, total: progress?.total ?? 0, error: message(e) }
    throw e instanceof BackupError ? e : new BackupError(message(e))
  } finally {
    runningId = undefined
  }
}

export async function compactNow(id: string): Promise<{ before: number; after: number }> {
  const { p, m, store, slot } = open(id)
  const pw = savedPassword(p, m)
  if (!pw) throw new BackupError(tr("Alege mai întâi o parolă de backup."))
  if (runningId) throw new BackupError(tr("Un backup e deja în lucru."))
  runningId = p.id
  try {
    const r = await compact(store, (await keysFor(slot, store, pw, false))!, 0.5)
    patchMeta(p.id, m.sub, { usedBytes: r.after })
    forgetCache(p.id)
    return { before: r.before, after: r.after }
  } finally {
    runningId = undefined
  }
}

/**
 * After a restart that applied a restore: puts back the skills and the rest outside the data folder (each replaced
 * file is kept by the import, which can be undone), and adds that to the report.
 */
export async function finishRestore(): Promise<void> {
  const file = path.join(dataDir(), PACK_FILE)
  if (!fs.existsSync(file)) return
  let applied = 0
  try {
    const preview = openPackBuffer(fs.readFileSync(file), true)
    const outside = preview.items.filter((i) => ['skills', 'commands', 'instructions', 'mcp'].includes(i.part))
    const decisions = Object.fromEntries(preview.items.map((i) => [i.key, outside.includes(i) && i.state !== 'same' ? ('overwrite' as const) : ('skip' as const)]))
    if (outside.some((i) => i.state !== 'same')) applied = (await apply(preview.previewId, decisions)).imported
    else await discard(preview.previewId)
  } catch {
    // a pack that cannot be read is left in place for a manual import from Settings
    return
  }
  fs.rmSync(file, { force: true })
  const rep = report()
  if (rep) fs.writeFileSync(path.join(dataDir(), REPORT), JSON.stringify({ ...rep, personal: applied }, null, 2))
}

export function report(): RestoreReport | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir(), REPORT), 'utf8')) as RestoreReport
  } catch {
    return null
  }
}

export const dismissReport = (): void => fs.rmSync(path.join(dataDir(), REPORT), { force: true })
