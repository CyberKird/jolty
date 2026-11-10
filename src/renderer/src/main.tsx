import { createRoot } from 'react-dom/client'
import './styles.css'
import './organize.css'
import './chat-tools.css'
import './transitions.css'
import './themes.css'
import './theme-glass.css'
import './lowpower.css'
import './windowed.css'
import './phone.css'
import { setLowPowerMode } from './lowpower'
import { applySavedTheme } from './theme'
import { addLocales, getLang } from '@shared/i18n'

// the saved choice arrives with the settings (App); until then the machine decides, so a weak PC never paints the full look first
setLowPowerMode('auto')
// the last theme is remembered here too, so the window opens in it and does not flash the default first
applySavedTheme()

// only the chosen language's dictionary is parsed; App comes after it because some modules build their texts on load
const dicts = import.meta.glob<Record<string, string>>('../../shared/locales/*.json', { import: 'default' })
const lang = getLang()
const load = dicts[`../../shared/locales/${lang}.json`]
if (load) addLocales({ [lang]: await load() })
// a browser on a paired phone has no preload: the API comes over the connection to the PC (remote/boot.ts); the dictionary is in first, so its screens speak the user's language
if (!(window as unknown as { jolty?: unknown }).jolty) {
  await (await import('./remote/boot')).connectRemote()
  ;(await import('./remote/phone')).setupPhone()
}

// a throw while rendering unmounts the whole tree, which is a black window: reload instead, at most twice a minute
const recover = (e: unknown): void => {
  console.error('[jolty] renderer crashed', e)
  const now = Date.now()
  const recent = JSON.parse(sessionStorage.getItem('jolty-reloads') || '[]').filter((t: number) => now - t < 60_000)
  if (recent.length >= 2) return
  sessionStorage.setItem('jolty-reloads', JSON.stringify([...recent, now]))
  location.reload()
}
const opts = { onUncaughtError: recover }
// the same page is the quick entry box (main/quick.ts loads it with #quick)
try {
  if (location.hash === '#quick') {
    const { QuickEntry } = await import('./components/QuickEntry')
    createRoot(document.getElementById('root')!, opts).render(<QuickEntry />)
  } else {
    const { App } = await import('./App')
    createRoot(document.getElementById('root')!, opts).render(<App />)
  }
} catch (e) {
  recover(e)
}
