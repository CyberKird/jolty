// Interface language. The Romanian text in the code is the key: tr('Setări') looks it up in the
// chosen language's dictionary and falls back to the key itself, so Romanian needs no dictionary
// and a missing entry shows the original instead of breaking. scripts/i18n-check.mjs keeps every
// dictionary complete. The languages are the ones the Claude apps offer, plus Romanian and Arabic.
import { LOCALES } from './locales'

export const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'ro', name: 'Română' },
  { code: 'fr', name: 'Français' },
  { code: 'de', name: 'Deutsch' },
  { code: 'es', name: 'Español' },
  { code: 'it', name: 'Italiano' },
  { code: 'pt-BR', name: 'Português (Brasil)' },
  { code: 'ja', name: '日本語' },
  { code: 'ko', name: '한국어' },
  { code: 'hi', name: 'हिन्दी' },
  { code: 'id', name: 'Bahasa Indonesia' },
  { code: 'ar', name: 'العربية' }
] as const

export type Lang = (typeof LANGUAGES)[number]['code']

const isLang = (l: unknown): l is Lang => LANGUAGES.some((x) => x.code === l)

// the interface gets its language from the preload before any module runs; the main process sets it in main/lang.ts
const preset = (globalThis as { joltyLang?: string }).joltyLang
let current: Lang = isLang(preset) ? preset : 'en'

/** The saved choice, else the system language when Jolty has it, else English. */
export function pickLang(saved?: string, system?: string): Lang {
  if (isLang(saved)) return saved
  const sys = (system || '').toLowerCase()
  const match = LANGUAGES.find((x) => x.code.toLowerCase() === sys) || LANGUAGES.find((x) => sys.startsWith(x.code.split('-')[0].toLowerCase()))
  return match?.code ?? 'en'
}

export function setLang(lang: string | undefined): void {
  current = isLang(lang) ? lang : 'en'
}

export const getLang = (): Lang => current

/** The language's English name, for telling a model which language to write in. */
export const LANG_ENGLISH_NAME: Record<Lang, string> = {
  en: 'English',
  ro: 'Romanian',
  fr: 'French',
  de: 'German',
  es: 'Spanish',
  it: 'Italian',
  'pt-BR': 'Brazilian Portuguese',
  ja: 'Japanese',
  ko: 'Korean',
  hi: 'Hindi',
  id: 'Indonesian',
  ar: 'Arabic'
}

/** Arabic reads right to left: the interface mirrors (see the end of styles.css). */
export const isRtl = (): boolean => current === 'ar'

/** For dates and numbers. */
export const dateLocale = (): string => (current === 'ro' ? 'ro-RO' : current)

/** `tr('Continuă în {name}', { name })`: the text in the current language, with its {placeholders} filled. */
export function tr(src: string, vars?: Record<string, unknown>): string {
  const s = current === 'ro' ? src : (LOCALES[current]?.[src] ?? src)
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s
}
