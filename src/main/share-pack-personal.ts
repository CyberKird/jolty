// Finds personal information in what is about to be packed (e-mail addresses, phone numbers, bank and card numbers,
// the user's own name in file paths) and replaces it with a placeholder, so the rest of the item still travels.
// Only the kind is ever reported, never the value. It is a net with holes (a name written in prose is not caught).
import os from 'os'
import type { PersonalKind } from '@shared/skills'
import type { PackFile } from './share-pack-format'

const TEXT_MAX = 512 * 1024
/** Addresses that belong to nobody: placeholders, bots, documentation. */
const FAKE_MAIL = /@(example\.(com|org|net)|test\.com|localhost|users\.noreply\.github\.com|noreply\.[\w.]+|anthropic\.com|your-?domain\.\w+|domain\.com|email\.com|mail\.com)$|^(noreply|no-reply|user|you|your|name|email|test|foo|bar|john|jane)@/i
const MAIL = /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g
const PHONE = [/(?<![\w.+])\+\d{1,3}[ .-]?\(?\d{1,4}\)?(?:[ .-]?\d{2,4}){2,4}(?!\d)/g, /(?<![\w.+])0[67]\d{2}[ .-]?\d{3}[ .-]?\d{3}(?!\d)/g]
const IBAN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{1,4}){3,8}\b/g
const CARD = /\b(?:\d[ -]?){13,19}\b/g
const HOME = [/[A-Za-z]:[\\/]+Users[\\/]+([^\\/\s"'`:*?<>|]+)/gi, /\/home\/([^/\s"'`:]+)/g, /\/Users\/([^/\s"'`:]+)/g]
const SHARED_HOME = new Set(['public', 'default', 'default user', 'all users', 'user', 'username', 'you', 'name', 'example', 'me', 'shared', '<user>', '%username%', '$user', '~'])

function ibanOk(raw: string): boolean {
  const s = raw.replace(/ /g, '')
  if (s.length < 15 || s.length > 34) return false
  const moved = s.slice(4) + s.slice(0, 4)
  let rem = 0
  for (const ch of moved) {
    const v = ch >= 'A' ? ch.charCodeAt(0) - 55 : Number(ch)
    rem = Number(String(rem) + String(v)) % 97
  }
  return rem === 1
}

function luhn(digits: string): boolean {
  let sum = 0
  let dbl = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i])
    if (dbl) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    dbl = !dbl
  }
  return sum % 10 === 0
}

/** Replaces personal information with placeholders and says which kinds were there. */
export function redact(text: string, account = os.userInfo().username): { text: string; kinds: Set<PersonalKind> } {
  const kinds = new Set<PersonalKind>()
  let out = text
  if (!out) return { text, kinds }
  for (const r of HOME)
    out = out.replace(r, (m, name: string) => {
      if (SHARED_HOME.has(name.toLowerCase())) return m
      kinds.add('home-path')
      return m.slice(0, m.length - name.length) + '<user>'
    })
  out = out.replace(MAIL, (m) => {
    if (FAKE_MAIL.test(m)) return m
    kinds.add('email')
    return '<email>'
  })
  out = out.replace(IBAN, (m) => {
    // the match may run on into the next word: keep the longest start that is a real IBAN
    const g = m.split(' ')
    for (let n = g.length; n >= 4; n--) {
      if (!ibanOk(g.slice(0, n).join(' '))) continue
      kinds.add('bank')
      return ['<iban>', ...g.slice(n)].join(' ')
    }
    return m
  })
  out = out.replace(CARD, (m) => {
    const d = m.replace(/\D/g, '')
    // a run of one digit or a plain counter is not a card
    if (d.length < 13 || d.length > 19 || /^(\d)\1+$/.test(d) || !luhn(d)) return m
    kinds.add('card')
    return '<card>'
  })
  for (const r of PHONE)
    out = out.replace(r, () => {
      kinds.add('phone')
      return '<phone>'
    })
  if (account.length >= 3) {
    const name = new RegExp(`(?<![A-Za-z0-9])${account.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`, 'gi')
    out = out.replace(name, () => {
      kinds.add('account-name')
      return '<user>'
    })
  }
  return { text: out, kinds }
}

export const personalIn = (text: string, account?: string): Set<PersonalKind> => redact(text, account).kinds

/** The files with personal information replaced (text files up to 512 KB; others are left as they are), and what was found. */
export function redactFiles(files: PackFile[], account?: string): { files: PackFile[]; kinds: PersonalKind[] } {
  const all = new Set<PersonalKind>()
  const out = files.map((f) => {
    if (f.data.length > TEXT_MAX || f.data.includes(0)) return f
    const r = redact(f.data.toString('utf8'), account)
    if (!r.kinds.size) return f
    r.kinds.forEach((k) => all.add(k))
    return { ...f, data: Buffer.from(r.text, 'utf8') }
  })
  return { files: out, kinds: [...all].sort() }
}

export const personalOf = (files: PackFile[], account?: string): PersonalKind[] => redactFiles(files, account).kinds
