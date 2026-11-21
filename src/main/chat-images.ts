// Images an answer shows inline, written as Markdown `![alt](src)`. The page's CSP allows only data: images, so the main
// process fetches them: plain https without cookies or referrer, or an image file on this PC. Only real raster images come
// back (the bytes are checked, not the server's word), SVG never: it can carry script and the chat does not need it.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const MAX_BYTES = 12 * 1024 * 1024
const TIMEOUT_MS = 15000
const LOCAL_EXT = /\.(png|jpe?g|gif|webp)$/i

export type ImageKind = 'png' | 'jpeg' | 'gif' | 'webp'

/** The format from the first bytes, or nothing when the file is not an image the chat shows. */
export function sniff(b: Uint8Array): ImageKind | undefined {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg'
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'gif'
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp'
  return undefined
}

/** A local image path from chat text: Windows paths, /E:/... forms and file:// URLs. */
export function localImagePath(src: string): string | undefined {
  let p = src
  try {
    if (/^file:/i.test(p)) p = fileURLToPath(p)
    else p = decodeURIComponent(p)
  } catch {
    // keep the text as written
  }
  p = path.normalize(p.replace(/^\/(?=[a-z]:)/i, ''))
  if (!path.isAbsolute(p) || p.replace(/^[a-z]:/i, '').includes(':') || !LOCAL_EXT.test(p)) return undefined
  return p
}

const toData = (kind: ImageKind, bytes: Uint8Array): string => `data:image/${kind};base64,${Buffer.from(bytes).toString('base64')}`

async function fetchWeb(src: string): Promise<string> {
  const res = await fetch(src, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    headers: { accept: 'image/png,image/jpeg,image/gif,image/webp;q=0.9,*/*;q=0.1' }
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  // every hop of a redirect must stay on https
  if (!/^https:\/\//i.test(res.url || src)) throw new Error('not https')
  const declared = Number(res.headers.get('content-length') || 0)
  if (declared > MAX_BYTES) throw new Error('too large')
  const reader = res.body?.getReader()
  if (!reader) throw new Error('empty')
  const parts: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > MAX_BYTES) {
      void reader.cancel()
      throw new Error('too large')
    }
    parts.push(value)
  }
  const bytes = Buffer.concat(parts)
  const kind = sniff(bytes)
  if (!kind) throw new Error('not an image')
  return toData(kind, bytes)
}

function readLocal(file: string): string {
  const st = fs.statSync(file)
  if (!st.isFile() || st.size > MAX_BYTES) throw new Error('too large')
  const bytes = fs.readFileSync(file)
  const kind = sniff(bytes)
  if (!kind) throw new Error('not an image')
  return toData(kind, bytes)
}

const cache = new Map<string, Promise<string>>()

/** The image as a data: URL. Throws when it cannot be shown; the chat then keeps the plain link. */
export function chatImage(src: unknown): Promise<string> {
  if (typeof src !== 'string' || src.length > 4096) return Promise.reject(new Error('bad image'))
  const hit = cache.get(src)
  if (hit) {
    cache.delete(src)
    cache.set(src, hit)
    return hit
  }
  let job: Promise<string>
  if (/^https:\/\//i.test(src)) job = fetchWeb(src)
  else {
    const file = localImagePath(src)
    job = file ? Promise.resolve().then(() => readLocal(file)) : Promise.reject(new Error('bad image'))
  }
  cache.set(src, job)
  // a failure is not kept: the next render may try again
  job.catch(() => cache.delete(src))
  while (cache.size > 60) cache.delete(cache.keys().next().value!)
  return job
}
