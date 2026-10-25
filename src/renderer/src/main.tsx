import { createRoot } from 'react-dom/client'
import './styles.css'
import './chat-tools.css'
import './transitions.css'
import './lowpower.css'
import './windowed.css'
import { setLowPowerMode } from './lowpower'
import { addLocales, getLang } from '@shared/i18n'

// the saved choice arrives with the settings (App); until then the machine decides, so a weak PC never paints the full look first
setLowPowerMode('auto')

// only the chosen language's dictionary is parsed; App comes after it because some modules build their texts on load
const dicts = import.meta.glob<Record<string, string>>('../../shared/locales/*.json', { import: 'default' })
const lang = getLang()
const load = dicts[`../../shared/locales/${lang}.json`]
if (load) addLocales({ [lang]: await load() })
const { App } = await import('./App')

createRoot(document.getElementById('root')!).render(<App />)
