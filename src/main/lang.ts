// Imported first by index.ts, so the language is set before any other module builds its texts.
// An install from before languages existed was all Romanian, so it stays Romanian until changed.
import { pickLang, setLang } from '@shared/i18n'
import { loadSettings } from './store'

const s = loadSettings()
const legacy = s.lastProfileId || s.lastCwd ? 'ro' : undefined
setLang(pickLang(s.language ?? legacy, Intl.DateTimeFormat().resolvedOptions().locale))
