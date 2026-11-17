// Keys of an incremental backup (the "vault"). A random master key is made once per vault and kept in the storage
// encrypted with a key from the backup password (scrypt), so the password is stretched once per run, not per object.
// Every object and every blob is AES-256-GCM with its own nonce; its name is the associated data, so the storage
// cannot swap one object or blob for another. Blob ids are an HMAC of the plain bytes: equal chunks dedupe, but the
// storage learns nothing from the ids.
import { createCipheriv, createDecipheriv, createHmac, randomBytes, scrypt } from 'crypto'
import { tr } from '@shared/i18n'
import { BackupError } from './types'

export interface VaultKeys {
  /** random id of the vault, written in every head so a key from another vault is noticed */
  repo: string
  enc: Buffer
  mac: Buffer
}

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }
const OBJ_MAGIC = Buffer.from('JV2O')

function stretch(password: string, salt: Buffer): Promise<Buffer> {
  // async: scrypt runs on the thread pool, the window stays responsive
  return new Promise((resolve, reject) => scrypt(password, salt, 32, SCRYPT, (e, k) => (e ? reject(e) : resolve(k))))
}

export function newKeys(): VaultKeys {
  return { repo: randomBytes(12).toString('hex'), enc: randomBytes(32), mac: randomBytes(32) }
}

function seal(key: Buffer, plain: Buffer, ad: string): Buffer {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  c.setAAD(Buffer.from(ad))
  const body = Buffer.concat([c.update(plain), c.final()])
  return Buffer.concat([iv, c.getAuthTag(), body])
}

function unseal(key: Buffer, box: Buffer, ad: string): Buffer {
  if (box.length < 28) throw new BackupError(tr("Backup-ul e deteriorat."))
  const d = createDecipheriv('aes-256-gcm', key, box.subarray(0, 12))
  d.setAAD(Buffer.from(ad))
  d.setAuthTag(box.subarray(12, 28))
  return Buffer.concat([d.update(box.subarray(28)), d.final()])
}

/** The key object: the master keys under the password. Plain JSON around the ciphertext. */
export async function lockKeys(keys: VaultKeys, password: string): Promise<Buffer> {
  const salt = randomBytes(16)
  const box = seal(await stretch(password, salt), Buffer.concat([keys.enc, keys.mac]), `jolty2-key:${keys.repo}`)
  return Buffer.from(JSON.stringify({ v: 2, repo: keys.repo, kdf: 'scrypt', n: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString('base64'), box: box.toString('base64') }))
}

export async function unlockKeys(raw: Buffer, password: string): Promise<VaultKeys> {
  let k: { v?: number; repo?: string; salt?: string; box?: string; n?: number }
  try {
    k = JSON.parse(raw.toString('utf8'))
  } catch {
    throw new BackupError(tr("Fișierul găsit nu e un backup Jolty."))
  }
  if (k.v !== 2 || typeof k.repo !== 'string' || typeof k.salt !== 'string' || typeof k.box !== 'string' || k.n !== SCRYPT.N) throw new BackupError(tr("Fișierul găsit nu e un backup Jolty."))
  let both: Buffer
  try {
    both = unseal(await stretch(password, Buffer.from(k.salt, 'base64')), Buffer.from(k.box, 'base64'), `jolty2-key:${k.repo}`)
  } catch {
    throw new BackupError(tr("Parola de backup nu e cea bună."))
  }
  if (both.length !== 64) throw new BackupError(tr("Backup-ul e deteriorat."))
  return { repo: k.repo, enc: both.subarray(0, 32), mac: both.subarray(32) }
}

/** A whole object of the storage (head, snapshot). */
export const sealObject = (keys: VaultKeys, name: string, plain: Buffer): Buffer => Buffer.concat([OBJ_MAGIC, seal(keys.enc, plain, `${keys.repo}/${name}`)])

export function openObject(keys: VaultKeys, name: string, data: Buffer): Buffer {
  if (!data.subarray(0, 4).equals(OBJ_MAGIC)) throw new BackupError(tr("Backup-ul e deteriorat."))
  try {
    return unseal(keys.enc, data.subarray(4), `${keys.repo}/${name}`)
  } catch {
    throw new BackupError(tr("Backup-ul e deteriorat."))
  }
}

/** 128-bit id of a chunk: same bytes, same id, inside one vault only. */
export const blobId = (keys: VaultKeys, plain: Buffer): string => createHmac('sha256', keys.mac).update(plain).digest('hex').slice(0, 32)

export const sealBlob = (keys: VaultKeys, id: string, packed: Buffer): Buffer => seal(keys.enc, packed, id)

export function openBlob(keys: VaultKeys, id: string, box: Buffer): Buffer {
  try {
    return unseal(keys.enc, box, id)
  } catch {
    throw new BackupError(tr("Backup-ul e deteriorat."))
  }
}
