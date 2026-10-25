// Imported first by index.ts, so the language is set before any other module builds its texts.
// An install from before languages existed was all Romanian, so it stays Romanian until changed.
import { addLocales, pickLang, setLang } from '@shared/i18n'
import { LOCALES } from '@shared/locales'
import { loadSettings } from './store'

addLocales(LOCALES)
const s = loadSettings()
const legacy = s.lastProfileId || s.lastCwd ? 'ro' : undefined
setLang(pickLang(s.language ?? legacy, Intl.DateTimeFormat().resolvedOptions().locale))
