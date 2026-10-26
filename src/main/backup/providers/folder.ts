// A folder on this PC. Pointed at iCloud Drive, OneDrive, Dropbox or Google Drive for desktop, a NAS share or a USB
// drive, it backs up there through whatever syncs or holds that folder.
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { tr } from '@shared/i18n'
import { BackupError, FILE, type Config, type Provider } from '../types'

/** Runs a filesystem step; anything that is not already ours becomes a message the user can read. */
async function io<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step()
  } catch (e) {
    if (e instanceof BackupError) throw e
    throw new BackupError(tr("Nu pot folosi folderul ({code}).", { code: (e as NodeJS.ErrnoException).code ?? 'ERR' }))
  }
}

async function folderOf(cfg: Config): Promise<string> {
  const p = (cfg.path ?? '').trim()
  if (!p) throw new BackupError(tr("Completează mai întâi câmpurile de conectare."))
  if (!path.isAbsolute(p)) throw new BackupError(tr("Calea trebuie să fie completă, începând de la discul sau rădăcina ei."))
  const dir = path.resolve(p)
  if (path.parse(dir).root === dir) throw new BackupError(tr("Alege un folder, nu rădăcina unui disc."))
  const st = await fs.stat(dir).catch(() => null)
  if (!st?.isDirectory()) throw new BackupError(tr("Folderul nu există."))
  return dir
}

/** The backup file itself, which must be a plain file: a link or a folder with that name is not ours to follow. */
async function plainFile(file: string): Promise<boolean> {
  const st = await fs.lstat(file).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return null
    throw e
  })
  if (st && !st.isFile()) throw new BackupError(tr("«{file}» din folder nu e un fișier obișnuit.", { file: FILE }))
  return st !== null
}

export const folder: Provider = {
  id: 'folder',
  info: () => ({
    id: 'folder',
    name: 'Folder',
    kind: 'credentials',
    fields: [{ key: 'path', label: 'Folder path', placeholder: 'C:\\Users\\you\\iCloudDrive\\Jolty' }],
    help: tr("Calea completă a unui folder existent. Alege unul din iCloud Drive, OneDrive, Dropbox sau Google Drive pentru desktop, de pe un NAS sau de pe un stick USB, iar backup-ul ajunge acolo prin sincronizarea lor. Exemplu: C:\\Users\\tu\\iCloudDrive\\Jolty")
  }),

  connect: (cfg) =>
    io(async () => {
      const dir = await folderOf(cfg)
      const probe = path.join(dir, `.jolty-probe-${randomBytes(6).toString('hex')}`)
      await fs.writeFile(probe, 'ok', { flag: 'wx' })
      await fs.unlink(probe)
      return { sub: process.platform === 'win32' ? dir.toLowerCase() : dir, label: dir }
    }),

  find: (cfg) =>
    io(async () => {
      const file = path.join(await folderOf(cfg), FILE)
      if (!(await plainFile(file))) return null
      const st = await fs.stat(file)
      return { modifiedAt: st.mtimeMs, bytes: st.size }
    }),

  /** Written beside the target and renamed over it, so a crash or a full disk never leaves half a backup. */
  put: (cfg, data) =>
    io(async () => {
      const file = path.join(await folderOf(cfg), FILE)
      await plainFile(file)
      const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
      try {
        const fh = await fs.open(tmp, 'wx')
        try {
          await fh.writeFile(data)
          await fh.sync()
        } finally {
          await fh.close()
        }
        await fs.rename(tmp, file)
      } catch (e) {
        await fs.unlink(tmp).catch(() => undefined)
        throw e
      }
    }),

  get: (cfg) =>
    io(async () => {
      const file = path.join(await folderOf(cfg), FILE)
      if (!(await plainFile(file))) throw new BackupError(tr("Nu există niciun backup în acest loc."))
      return fs.readFile(file)
    })
}
