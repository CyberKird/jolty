// The parts of list_models and ask_model that need no engine: reading the tool input, deciding which files a
// model can take, preparing them, and writing the model list for the asking model. Texts here are for a model, so
// they stay in English whatever the interface language.
import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import type { Attachment, EngineKind, Profile } from '@shared/types'
import { isSecretPath } from './engines/secret-files'

export const MAX_QUESTION = 200_000
export const MAX_ASK_FILES = 8

export interface AskInput {
  profile: string
  question: string
  model?: string
  files: string[]
}

/** The arguments of ask_model; throws with the reason (which the asking model reads) when something is off. */
export function parseAskInput(a: Record<string, unknown>): AskInput {
  const profile = typeof a.profile === 'string' ? a.profile.trim() : ''
  if (!profile) throw new Error('profile is needed: the id or the name of a profile from list_models')
  const question = typeof a.question === 'string' ? a.question.trim() : ''
  if (!question) throw new Error('question is empty')
  if (question.length > MAX_QUESTION) throw new Error(`question is too long (${question.length} characters, at most ${MAX_QUESTION}); put the long part in a file`)
  if (a.model !== undefined && a.model !== null && typeof a.model !== 'string') throw new Error('model must be a text: an id from list_models')
  const model = typeof a.model === 'string' ? a.model.trim() : ''
  if (a.files !== undefined && a.files !== null && !Array.isArray(a.files)) throw new Error('files must be a list of absolute paths')
  const raw = (a.files as unknown[] | undefined | null) ?? []
  if (raw.length > MAX_ASK_FILES) throw new Error(`at most ${MAX_ASK_FILES} files`)
  const files = [...new Set(raw.map((f) => (typeof f === 'string' ? f.trim() : '')))]
  for (const f of files) if (!f || !path.isAbsolute(f)) throw new Error(`files need absolute paths, got ${JSON.stringify(f)}`)
  return { profile, question, model: model || undefined, files }
}

export type FileKind = 'image' | 'pdf' | 'audio' | 'video' | 'text'

const BY_EXT: Record<string, [FileKind, string]> = {
  '.png': ['image', 'image/png'], '.jpg': ['image', 'image/jpeg'], '.jpeg': ['image', 'image/jpeg'], '.webp': ['image', 'image/webp'], '.gif': ['image', 'image/gif'],
  '.pdf': ['pdf', 'application/pdf'],
  '.mp3': ['audio', 'audio/mpeg'], '.wav': ['audio', 'audio/wav'], '.m4a': ['audio', 'audio/mp4'], '.ogg': ['audio', 'audio/ogg'], '.flac': ['audio', 'audio/flac'], '.aac': ['audio', 'audio/aac'],
  '.mp4': ['video', 'video/mp4'], '.mov': ['video', 'video/quicktime'], '.webm': ['video', 'video/webm'], '.mkv': ['video', 'video/x-matroska'], '.avi': ['video', 'video/x-msvideo']
}

/** By extension; anything else is taken for text and checked when it is read. */
export function fileKind(file: string): { kind: FileKind; mime: string } {
  const [kind, mime] = BY_EXT[path.extname(file).toLowerCase()] ?? ['text', 'text/plain']
  return { kind, mime }
}

/** Whether a model of this profile can take the file kind. Text is always fine: it goes into the question. */
export function accepts(p: Pick<Profile, 'engine' | 'auth' | 'vision'>, m: { vision?: boolean } | undefined, kind: FileKind): boolean {
  if (kind === 'text') return true
  if (kind === 'image') return m?.vision !== false && (p.engine === 'gemini' || p.engine === 'codex' || (p.engine === 'claude' && (p.auth !== 'endpoint' || p.vision === true)))
  if (kind === 'pdf') return p.engine === 'gemini' || (p.engine === 'claude' && p.auth !== 'endpoint')
  return p.engine === 'gemini'
}

const KINDS: FileKind[] = ['image', 'pdf', 'audio', 'video']

const LIMITS: Record<FileKind, number> = { image: 9 * 1024 * 1024, pdf: 20 * 1024 * 1024, audio: 500 * 1024 * 1024, video: 500 * 1024 * 1024, text: 100 * 1024 }
const MAX_TEXT_TOTAL = 300 * 1024

export interface AskFiles {
  /** images and PDFs as bytes, audio and video as a path (only a browser upload takes those) */
  attachments: Attachment[]
  /** text files, ready to follow the question */
  inlined: string
}

/** Reads the files for one model; throws, naming the file, when one is a secret, too big, unreadable or of a kind the model cannot take. */
export function readAskFiles(files: string[], take: (kind: FileKind) => boolean, who: string): AskFiles {
  const attachments: Attachment[] = []
  let inlined = ''
  let textBytes = 0
  for (const f of files) {
    const name = path.basename(f)
    if (isSecretPath(f)) throw new Error(`${name} looks like a file that holds secrets; it is not sent to another model`)
    let real: string
    try {
      real = fs.realpathSync(f)
      if (!fs.statSync(real).isFile()) throw new Error('not a file')
    } catch {
      throw new Error(`${name}: not a readable file`)
    }
    // the link may point somewhere else than the name suggests
    if (isSecretPath(real)) throw new Error(`${name} looks like a file that holds secrets; it is not sent to another model`)
    const { kind, mime } = fileKind(real)
    if (!take(kind)) throw new Error(`${name}: ${who} cannot take ${kind === 'text' ? 'this file' : `${kind} files`}. list_models shows which profiles take which files`)
    const size = fs.statSync(real).size
    if (size > LIMITS[kind]) throw new Error(`${name}: ${Math.round(size / 1024 / 1024)} MB is over the ${Math.round(LIMITS[kind] / 1024 / 1024) || '0.1'} MB limit for ${kind} files`)
    if (kind === 'text') {
      const bytes = fs.readFileSync(real)
      if (bytes.subarray(0, 8192).includes(0)) throw new Error(`${name}: a binary file of a type that is not known; only text, images, PDF, audio and video can be sent`)
      textBytes += bytes.length
      if (textBytes > MAX_TEXT_TOTAL) throw new Error('the text files together are over 300 KB; send fewer or shorter ones')
      inlined += `\n\n<file name=${JSON.stringify(name)}>\n${bytes.toString('utf8')}\n</file>`
      continue
    }
    const keep = kind === 'image' || kind === 'pdf'
    attachments.push({ id: randomUUID(), name, mime, ...(keep ? { data: fs.readFileSync(real).toString('base64') } : { path: real }), size })
  }
  return { attachments, inlined }
}

export interface AskModelRow {
  id: string
  label: string
  isDefault?: boolean
  /** false when the model cannot read images */
  vision?: boolean
  iq?: number
  tps?: number
  speed?: string
}

export interface AskProfile {
  id: string
  name: string
  engine: EngineKind
  models: AskModelRow[]
  /** the kinds of file this profile can take, besides text */
  files: FileKind[]
}

export const fileKindsOf = (p: Pick<Profile, 'engine' | 'auth' | 'vision'>): FileKind[] => KINDS.filter((k) => accepts(p, undefined, k))

/** The list for the asking model: who can be asked, with which models, how clever and how fast, and which files they take. */
export function formatAskable(list: AskProfile[]): string {
  if (!list.length) return 'No profile can answer right now (none is signed in, or their limits are full).'
  const rows = list.map((p) => {
    const head = `- ${p.name} (profile id: ${p.id}, ${p.engine}) takes files: ${p.files.length ? p.files.join(', ') : 'text only'}`
    if (!p.models.length) return `${head}\n    no model list yet (the Jolty browser is not open); leave model out to use the model the page is on`
    const models = p.models.map((m) => {
      const bits = [m.iq !== undefined ? `intelligence ${m.iq}` : '', m.tps !== undefined ? `speed ${m.tps} tokens/s${m.speed ? ` (${m.speed})` : ''}` : '', m.vision === false ? 'no images' : '', m.isDefault ? 'default' : '']
      return `    ${m.id}${m.label !== m.id ? ` (${m.label})` : ''}${bits.filter(Boolean).length ? `: ${bits.filter(Boolean).join(', ')}` : ''}`
    })
    return `${head}\n${models.join('\n')}`
  })
  return `${list.length} profile(s) you can ask with ask_model (intelligence: Artificial Analysis index, higher is better; speed: median tokens per second):\n\n${rows.join('\n\n')}`
}
