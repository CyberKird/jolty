// AES-256-GCM with a key from the password (scrypt, a salt of its own per backup).
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto'
import { tr } from '@shared/i18n'
import { BackupError } from './types'

const MAGIC = Buffer.from('JOLTYBAK1\n')
const key = (password: string, salt: Buffer): Buffer => scryptSync(password, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 })

export function encryptBackup(data: Buffer, password: string): Buffer {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(password, salt), iv)
  const body = Buffer.concat([cipher.update(data), cipher.final()])
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), body])
}

export function decryptBackup(blob: Buffer, password: string): Buffer {
  const head = MAGIC.length + 16 + 12 + 16
  if (blob.length < head || !blob.subarray(0, MAGIC.length).equals(MAGIC)) throw new BackupError(tr("Fișierul găsit nu e un backup Jolty."))
  const decipher = createDecipheriv('aes-256-gcm', key(password, blob.subarray(MAGIC.length, MAGIC.length + 16)), blob.subarray(MAGIC.length + 16, MAGIC.length + 28))
  decipher.setAuthTag(blob.subarray(MAGIC.length + 28, head))
  try {
    return Buffer.concat([decipher.update(blob.subarray(head)), decipher.final()])
  } catch {
    throw new BackupError(tr("Parola de backup nu e cea bună."))
  }
}
