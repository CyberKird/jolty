// Dictionaries per language, keyed by the Romanian text in the code (see ../i18n.ts).
// Romanian has none: the keys are the Romanian text. scripts/i18n-check.mjs keeps them complete.
import ar from './ar.json'
import de from './de.json'
import en from './en.json'
import es from './es.json'
import fr from './fr.json'
import hi from './hi.json'
import id from './id.json'
import it from './it.json'
import ja from './ja.json'
import ko from './ko.json'
import ptBR from './pt-BR.json'

export const LOCALES: Record<string, Record<string, string>> = { en, fr, de, es, it, 'pt-BR': ptBR, ja, ko, hi, id, ar }
