// The .joltypack file format, pure (no Electron, no disk writes). A pack comes from someone else: everything read
// from it is checked here before any other code sees it.
//
// Layout: "JOLTYPACK\n", a 4-byte big-endian header length, the header (UTF-8 JSON), then one gzip stream with the
// contents of every file back to back. The header lists the items, and for each item its files with the offset and
// size in the decompressed body, a sha256 and the time the file was last changed.
import { createHash } from 'crypto'
import zlib from 'zlib'
import type { PackPart } from '@shared/skills'

export const MAGIC = Buffer.from('JOLTYPACK\n')
export const FORMAT = 1
export const EXT = '.joltypack'

export const LIMITS = {
  /** decompressed body */
  total: 100 * 1024 * 1024,
  files: 5000,
  /** bigger files are left out of an export with a warning */
  file: 20 * 1024 * 1024,
  header: 8 * 1024 * 1024,
  items: 2000,
  /** a pack file on disk; gzip of already compressed data can be a bit bigger than the body */
  packFile: 110 * 1024 * 1024
}

export const PARTS: PackPart[] = ['skills', 'commands', 'instructions', 'settings', 'profiles', 'schedules']

export interface PackFile {
  path: string
  data: Buffer
  modifiedAt: number
}

export interface PackEntry {
  key: string
  part: PackPart
  /** the part after `${part}:` */
  name: string
  label: string
  detail?: string
  modifiedAt: number
  files: PackFile[]
}

export interface PackMeta {
  format: number
  app: string
  name: string
  author?: string
  note?: string
  createdAt: number
}

export interface DecodedPack {
  meta: PackMeta
  entries: PackEntry[]
  warnings: string[]
}

interface HeaderFile {
  path: string
  size: number
  sha256: string
  modifiedAt: number
  offset: number
}

interface HeaderItem {
  key: string
  part: string
  label: string
  detail?: string
  modifiedAt: number
  files: HeaderFile[]
}

export class PackError extends Error {}

const fail = (code: string): never => {
  throw new PackError(code)
}

export const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

/** Same value as hashSkillDir for a folder with these files. */
export function hashFiles(files: { path: string; data: Buffer }[]): string {
  const h = createHash('sha1')
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) h.update(f.path).update('\0').update(f.data).update('\0')
  return h.digest('hex')
}

const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i
// eslint-disable-next-line no-control-regex
const BAD_CHARS = /[\u0000-\u001f<>:"|?*\\/]/

/** One path segment that is safe as a file or folder name on Windows, macOS and Linux. */
export function safeSegment(s: unknown): boolean {
  return (
    typeof s === 'string' &&
    s.length > 0 &&
    s.length <= 200 &&
    s !== '.' &&
    s !== '..' &&
    !BAD_CHARS.test(s) &&
    !RESERVED.test(s) &&
    !/[. ]$/.test(s) &&
    !s.startsWith(' ')
  )
}

/** A relative path with forward slashes, every segment safe, nothing absolute, no `..`. */
export function safeRel(p: unknown): boolean {
  return typeof p === 'string' && p.length <= 1024 && p.split('/').every(safeSegment)
}

/** Text shown in the page or used as a profile or task name: bounded, no control characters. */
// eslint-disable-next-line no-control-regex
export const safeLabel = (s: unknown, max = 200): boolean => typeof s === 'string' && s.length > 0 && s.length <= max && !/[\u0000-\u001f\u007f]/.test(s)

const isTime = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0

export function encodePack(meta: PackMeta, entries: PackEntry[]): Buffer {
  const chunks: Buffer[] = []
  let offset = 0
  const items: HeaderItem[] = entries.map((e) => ({
    key: e.key,
    part: e.part,
    label: e.label,
    ...(e.detail ? { detail: e.detail } : {}),
    modifiedAt: Math.round(e.modifiedAt),
    files: e.files.map((f) => {
      const hf = { path: f.path, size: f.data.length, sha256: sha256(f.data), modifiedAt: Math.round(f.modifiedAt), offset }
      chunks.push(f.data)
      offset += f.data.length
      return hf
    })
  }))
  const header = Buffer.from(JSON.stringify({ ...meta, items }), 'utf8')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(header.length)
  return Buffer.concat([MAGIC, len, header, zlib.gzipSync(Buffer.concat(chunks))])
}

/**
 * Reads and checks a pack. Throws PackError with a code for a pack that cannot be trusted at all (bad format,
 * unsafe paths, over the limits); drops single items whose content does not match its checksum (warning
 * 'checksum-mismatch') or whose part this version does not know ('unknown-parts').
 */
export function decodePack(buf: Buffer): DecodedPack {
  if (buf.length > LIMITS.packFile) fail('too-large')
  if (buf.length < MAGIC.length + 4 || !buf.subarray(0, MAGIC.length).equals(MAGIC)) fail('not-a-pack')
  const hlen = buf.readUInt32BE(MAGIC.length)
  if (hlen > LIMITS.header || MAGIC.length + 4 + hlen > buf.length) fail('bad-header')
  let h: Record<string, unknown>
  try {
    h = JSON.parse(buf.subarray(MAGIC.length + 4, MAGIC.length + 4 + hlen).toString('utf8')) as Record<string, unknown>
  } catch {
    return fail('bad-header')
  }
  if (!h || typeof h !== 'object') fail('bad-header')
  if (h.format !== FORMAT) fail(typeof h.format === 'number' && h.format > FORMAT ? 'newer-format' : 'bad-format')
  if (!safeLabel(h.name) || !isTime(h.createdAt) || typeof h.app !== 'string' || h.app.length > 40) fail('bad-header')
  if (h.author !== undefined && !safeLabel(h.author, 100)) fail('bad-header')
  if (h.note !== undefined && (typeof h.note !== 'string' || h.note.length > 4000)) fail('bad-header')
  if (!Array.isArray(h.items) || h.items.length > LIMITS.items) fail(Array.isArray(h.items) ? 'too-many-items' : 'bad-header')

  // the whole header is checked before the body is inflated
  const raw = h.items as HeaderItem[]
  let files = 0
  let declared = 0
  const keys = new Set<string>()
  for (const it of raw) {
    if (!it || typeof it !== 'object' || typeof it.key !== 'string' || typeof it.part !== 'string') fail('bad-header')
    if (!it.key.startsWith(`${it.part}:`) || it.key.length > 1100 || !safeLabel(it.label) || !isTime(it.modifiedAt)) fail('bad-header')
    if (it.detail !== undefined && !safeLabel(it.detail, 1000)) fail('bad-header')
    if (keys.has(it.key.toLowerCase())) fail('duplicate-key')
    keys.add(it.key.toLowerCase())
    if (!Array.isArray(it.files)) fail('bad-header')
    const paths = new Set<string>()
    const dirs = new Set<string>()
    for (const f of it.files) {
      if (!f || typeof f !== 'object' || !safeRel(f.path)) fail('unsafe-path')
      const k = f.path.toLowerCase()
      // a file and a folder of the same name, or two names that only differ in case, collide on Windows
      if (paths.has(k) || dirs.has(k)) fail('duplicate-path')
      for (let i = k.indexOf('/'); i >= 0; i = k.indexOf('/', i + 1)) {
        const parent = k.slice(0, i)
        if (paths.has(parent)) fail('duplicate-path')
        dirs.add(parent)
      }
      paths.add(k)
      if (!Number.isInteger(f.size) || f.size < 0 || f.size > LIMITS.file) fail('too-large')
      if (!Number.isInteger(f.offset) || f.offset < 0 || typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256) || !isTime(f.modifiedAt)) fail('bad-header')
      declared += f.size
      if (++files > LIMITS.files) fail('too-many-files')
      if (declared > LIMITS.total) fail('too-large')
    }
  }

  let body: Buffer
  try {
    body = zlib.gunzipSync(buf.subarray(MAGIC.length + 4 + hlen), { maxOutputLength: LIMITS.total })
  } catch (e) {
    return fail(e instanceof RangeError || (e as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE' ? 'too-large' : 'bad-body')
  }

  const warnings = new Set<string>()
  const entries: PackEntry[] = []
  for (const it of raw) {
    if (!PARTS.includes(it.part as PackPart)) {
      warnings.add('unknown-parts')
      continue
    }
    const out: PackFile[] = []
    let ok = true
    for (const f of it.files) {
      const data = f.offset + f.size <= body.length ? body.subarray(f.offset, f.offset + f.size) : undefined
      if (!data || sha256(data) !== f.sha256) {
        ok = false
        break
      }
      out.push({ path: f.path, data: Buffer.from(data), modifiedAt: f.modifiedAt })
    }
    if (!ok) {
      warnings.add('checksum-mismatch')
      continue
    }
    const name = it.key.slice(it.part.length + 1)
    entries.push({ key: it.key, part: it.part as PackPart, name, label: it.label, detail: it.detail, modifiedAt: it.modifiedAt, files: out })
  }
  const meta: PackMeta = { format: FORMAT, app: h.app as string, name: h.name as string, createdAt: h.createdAt as number }
  if (h.author) meta.author = h.author as string
  if (h.note) meta.note = h.note as string
  return { meta, entries, warnings: [...warnings] }
}

/** a > b for dotted version numbers ("0.7.16"); anything that is not a number counts as 0 */
export function versionNewer(a: string, b: string): boolean {
  const pa = a.split(/[.+-]/).map((x) => parseInt(x, 10) || 0)
  const pb = b.split(/[.+-]/).map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0)
  return false
}
