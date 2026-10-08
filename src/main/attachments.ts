import { randomUUID } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Attachment } from '@shared/types'
import { tr } from '@shared/i18n'

export interface PreparedAttachments {
  images: Attachment[]
  files: { name: string; mime: string; path: string }[]
}

/** Keep large chosen files on disk; only clipboard files arrive as bytes. */
export function prepareAttachments(input: Attachment[]): PreparedAttachments {
  if (!Array.isArray(input) || input.length > 8) throw new Error(tr("Maximum 8 fișiere per mesaj."))
  const images: Attachment[] = []
  const files: PreparedAttachments['files'] = []
  for (const item of input) {
    if (!item || typeof item !== 'object') throw new Error(tr("Atașament invalid."))
    const name = path.basename(String(item.name || tr("fișier")).replace(/[\u0000-\u001f]/g, '')).slice(0, 200)
    const mime = typeof item.mime === 'string' && item.mime.length < 200 ? item.mime : 'application/octet-stream'
    if (mime.startsWith('image/') && typeof item.data === 'string') {
      if (item.data.length > 12 * 1024 * 1024 || !/^[a-zA-Z0-9+/]*={0,2}$/.test(item.data)) throw new Error(tr("{name}: imagine prea mare sau invalidă.", { name }))
      images.push({ id: item.id, name, mime, data: item.data })
      continue
    }
    let file: string
    if (typeof item.path === 'string') {
      if (!path.isAbsolute(item.path)) throw new Error(tr("{name}: calea nu este absolută.", { name }))
      file = fs.realpathSync(item.path)
      if (!fs.statSync(file).isFile()) throw new Error(tr("{name}: nu este un fișier obișnuit.", { name }))
    } else if (typeof item.data === 'string' && item.data.length <= 24 * 1024 * 1024 && /^[a-zA-Z0-9+/]*={0,2}$/.test(item.data)) {
      const dir = path.join(os.tmpdir(), 'jolty-attachments')
      fs.mkdirSync(dir, { recursive: true })
      file = path.join(dir, `${randomUUID()}-${name}`)
      fs.writeFileSync(file, Buffer.from(item.data, 'base64'), { flag: 'wx' })
    } else {
      throw new Error(tr("{name}: alege fișierul de pe disc sau lipește unul sub 16 MB.", { name }))
    }
    files.push({ name, mime, path: file })
  }
  return { images, files }
}

export function filePrompt(files: PreparedAttachments['files']): string {
  if (!files.length) return ''
  const refs = files.map((f) => `- ${JSON.stringify(f.path)} (${f.mime})`).join('\n')
  // for the model: English whatever the interface language
  return `Files attached by the user, available locally:\n${refs}\nInspect the relevant files with your tools. For video, check the duration and extract frames/audio when local tools allow it; do not assume you have seen the content from the file name alone.`
}
