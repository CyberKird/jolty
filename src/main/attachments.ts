import { randomUUID } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Attachment } from '@shared/types'

export interface PreparedAttachments {
  images: Attachment[]
  files: { name: string; mime: string; path: string }[]
}

/** Keep large chosen files on disk; only clipboard files arrive as bytes. */
export function prepareAttachments(input: Attachment[]): PreparedAttachments {
  if (!Array.isArray(input) || input.length > 8) throw new Error('Maximum 8 fișiere per mesaj.')
  const images: Attachment[] = []
  const files: PreparedAttachments['files'] = []
  for (const item of input) {
    if (!item || typeof item !== 'object') throw new Error('Atașament invalid.')
    const name = path.basename(String(item.name || 'fișier').replace(/[\u0000-\u001f]/g, '')).slice(0, 200)
    const mime = typeof item.mime === 'string' && item.mime.length < 200 ? item.mime : 'application/octet-stream'
    if (mime.startsWith('image/') && typeof item.data === 'string') {
      if (item.data.length > 12 * 1024 * 1024 || !/^[a-zA-Z0-9+/]*={0,2}$/.test(item.data)) throw new Error(`${name}: imagine prea mare sau invalidă.`)
      images.push({ id: item.id, name, mime, data: item.data })
      continue
    }
    let file: string
    if (typeof item.path === 'string') {
      if (!path.isAbsolute(item.path)) throw new Error(`${name}: calea nu este absolută.`)
      file = fs.realpathSync(item.path)
      if (!fs.statSync(file).isFile()) throw new Error(`${name}: nu este un fișier obișnuit.`)
    } else if (typeof item.data === 'string' && item.data.length <= 24 * 1024 * 1024 && /^[a-zA-Z0-9+/]*={0,2}$/.test(item.data)) {
      const dir = path.join(os.tmpdir(), 'jolty-attachments')
      fs.mkdirSync(dir, { recursive: true })
      file = path.join(dir, `${randomUUID()}-${name}`)
      fs.writeFileSync(file, Buffer.from(item.data, 'base64'), { flag: 'wx' })
    } else {
      throw new Error(`${name}: alege fișierul de pe disc sau lipește unul sub 16 MB.`)
    }
    files.push({ name, mime, path: file })
  }
  return { images, files }
}

export function filePrompt(files: PreparedAttachments['files']): string {
  if (!files.length) return ''
  const refs = files.map((f) => `- ${JSON.stringify(f.path)} (${f.mime})`).join('\n')
  return `Fișiere atașate de utilizator, disponibile local:\n${refs}\nInspectează fișierele relevante cu uneltele tale. Pentru video, verifică durata și extrage cadre/audio când uneltele locale permit; nu presupune că ai văzut conținutul numai din numele fișierului.`
}
