// The incremental backup of one connected storage: its keys, what this PC remembers about it, and the list of files
// (vault-scope.ts) plus one made on the spot: the pack of everything outside the data folder (skills, commands,
// instructions, MCP servers), built by share-pack.ts only when one of those changed.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createHash } from 'crypto'
import { app } from 'electron'
import { dataDir, loadProfiles, loadSessions } from '../store'
import { buildPack } from '../share-pack'
import { localItems } from '../share-pack-local'
import type { Config, Provider } from './types'
import { lockKeys, newKeys, unlockKeys, type VaultKeys } from './vault-crypto'
import { KEY, type Origin, type Store } from './vault-format'
import { listScope } from './vault-scope'
import { writeVersion, type LocalCache, type Source, type WriteResult } from './vault-write'

/** The parts of a share pack that live outside the data folder (the rest is backed up as files). */
const OUTSIDE = new Set(['skills', 'commands', 'instructions', 'mcp'])
export const PACK_PATH = 'pack/personal'

/** The home folder; JOLTY_BACKUP_HOME points UI tests at a fake one (Electron needs the real USERPROFILE to open a window). */
export const homeDir = (): string => process.env.JOLTY_BACKUP_HOME || os.homedir()

export const storeOf = (p: Provider, cfg: Config): Store => ({
  put: (name, data) => p.put(cfg, data, name),
  get: (name) => p.get(cfg, name),
  find: (name) => p.find(cfg, name),
  remove: (name) => p.remove(cfg, name)
})

const stateFile = (id: string): string => path.join(dataDir(), 'backup-state', `${id}.json`)

export function loadCache(id: string): LocalCache {
  try {
    const c = JSON.parse(fs.readFileSync(stateFile(id), 'utf8')) as LocalCache
    if (c && typeof c.files === 'object' && typeof c.blobs === 'object') return c
  } catch {
    // first run on this PC
  }
  return { files: {}, blobs: {} }
}

function saveCache(id: string, c: LocalCache): void {
  const f = stateFile(id)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(c))
  fs.renameSync(`${f}.tmp`, f)
}

export const forgetCache = (id: string): void => fs.rmSync(stateFile(id), { force: true })

// the password is stretched once per storage and run of the app, not on every backup
const unlocked = new Map<string, { pass: string; keys: VaultKeys }>()

/** The vault's keys; `create` makes a new vault when the storage has none. */
export async function keysFor(slot: string, store: Store, password: string, create: boolean): Promise<VaultKeys | null> {
  const hit = unlocked.get(slot)
  if (hit && hit.pass === password) return hit.keys
  let keys: VaultKeys
  if (await store.find(KEY)) keys = await unlockKeys(await store.get(KEY), password)
  else if (create) {
    keys = newKeys()
    await store.put(KEY, await lockKeys(keys, password))
  } else return null
  unlocked.set(slot, { pass: password, keys })
  return keys
}

export const forgetKeys = (slot: string): void => void unlocked.delete(slot)

export function origin(): Origin {
  let version = '0.0.0'
  try {
    version = app?.getVersion?.() || version
  } catch {
    // tests
  }
  return { host: os.hostname(), platform: process.platform, home: homeDir(), data: dataDir(), app: version }
}

/** The pack of skills and the rest outside the data folder; its "time" is a fingerprint of those items. */
function personalPack(): Source | null {
  const items = localItems(true).filter((i) => OUTSIDE.has(i.part))
  if (!items.length) return null
  const h = createHash('sha256')
  for (const i of items) h.update(`${i.key}\0${i.bytes}\0${i.modifiedAt}\n`)
  return {
    p: PACK_PATH,
    size: -1,
    mtime: parseInt(h.digest('hex').slice(0, 12), 16),
    read: async () => buildPack({ keys: items.map((i) => i.key), name: 'Jolty backup' }, true).buf
  }
}

export async function sources(): Promise<Source[]> {
  const profiles = new Map(loadProfiles().map((p) => [p.id, p]))
  const chats = loadSessions().map((s) => ({ engine: s.engine, engineSessionId: s.engineSessionId, defaultDir: !!profiles.get(s.profileId)?.isDefaultDir }))
  const list = await listScope({ data: dataDir(), home: homeDir(), chats })
  let pack: Source | null = null
  try {
    // skills and the rest are read from the real home folder: a test with a fake one leaves them out
    if (!process.env.JOLTY_BACKUP_HOME) pack = personalPack()
  } catch {
    // nothing outside the data folder to add
  }
  return pack ? [...list, pack] : list
}

/** One run for storage `id`: uploads what changed since the last one. */
export async function backupVault(id: string, store: Store, keys: VaultKeys, signal?: AbortSignal): Promise<WriteResult> {
  const cache = loadCache(id)
  try {
    return await writeVersion({ store, keys, sources: await sources(), cache, origin: origin(), signal })
  } finally {
    saveCache(id, cache)
  }
}
