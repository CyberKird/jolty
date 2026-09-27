// Estimates how demanding a request is while the user types, and suggests a model tier and an
// effort level for it. Runs locally on every keystroke, so it is a fast heuristic, not a model call.
import type { ModelOption, Profile } from './types'

export type Level = 1 | 2 | 3 | 4
export type Tier = 'fast' | 'balanced' | 'deep'

export interface Assessment {
  level: Level
  label: string
  reasons: string[]
  tier: Tier
  effort: 'low' | 'medium' | 'high' | 'xhigh'
}

const LABELS: Record<Level, string> = { 1: 'Simplu', 2: 'Mediu', 3: 'Complex', 4: 'Foarte complex' }

const HARD: [RegExp, string][] = [
  [/arhitectur|architect/i, 'arhitectură'],
  [/refactor/i, 'refactorizare'],
  [/migr(ea|are|ează|ate|ation)/i, 'migrare'],
  [/de la zero|from scratch|aplicați[ea] (întreag|complet)|whole app|full app/i, 'construit de la zero'],
  [/(tot|întreg)(ul)? (proiect|codul|repo)|entire (codebase|project|repo)|all files|toate fișierele/i, 'tot proiectul'],
  [/securitate|security|vulnerab|exploit|criptare|encrypt/i, 'securitate'],
  [/performan|optimiz|\blent|\bslow|\blag\b|\bfps\b|memory leak|scurgere de memorie/i, 'performanță'],
  [/concuren|race condition|deadlock|thread|paralel|async.*bug/i, 'concurență'],
  [/algoritm|algorithm|matematic|physics|fizic/i, 'algoritmi'],
  [/multiplayer|netcode|sincroniz|websocket|real-?time|timp real/i, 'timp real / rețea'],
  [/bază de date|baza de date|database|schema|sql|migration/i, 'bază de date'],
  [/autentific|authentic|oauth|login|plăți|payment|stripe/i, 'autentificare / plăți'],
  [/debug|nu (mai )?merge|crash|se blochează|eroare (ciudat|aleator)|intermitent|flaky|heisenbug/i, 'depanare dificilă'],
  [/design system|sistem de design|animați.{0,20}(complex|3d)|three\.js|shader|webgl/i, 'grafică avansată'],
  [/test(e|s)? (complet|pentru tot)|coverage|acoperire/i, 'teste extinse'],
  [/(mai multe|multiple) (fișiere|pagini|module|servicii)|across (files|modules)/i, 'mai multe module'],
  [/impecabil|fără (nicio )?greșeal|production[- ]ready|gata de producție|enterprise/i, 'calitate de producție']
]

const MEDIUM: [RegExp, string][] = [
  [/adaugă|implementează|creează|construiește|fă (o|un)|scrie (o|un)|\badd\b|implement|create|build/i, 'funcționalitate nouă'],
  [/\bbug\b|repar|fix|nu funcționează|doesn.t work/i, 'reparație'],
  [/test/i, 'teste'],
  [/componen|pagin|endpoint|funcți|clas[aă]|modul/i, 'cod nou'],
  [/stil|design|\bui\b|interfaț|responsive|css/i, 'interfață'],
  [/integr|conect|\bapi\b/i, 'integrare']
]

const EASY: [RegExp, string][] = [
  [/^\s*(explică|ce face|ce înseamnă|ce e |cum funcționează|what does|explain|what is)/i, 'întrebare'],
  [/redenume|rename|typo|greșeal[aă] de scriere|comentari|\bcomment/i, 'modificare mică'],
  [/formatea|\bformat\b|indent|lint/i, 'formatare'],
  [/tradu|translate/i, 'traducere'],
  [/o (singură )?linie|one line|rapid|quick|simplu|mică|small/i, 'cerere mică'],
  [/^\s*(salut|bună|hi|hello|mersi|mulțumesc|thanks|ok)\b/i, 'mesaj scurt']
]

export function assess(text: string, images = 0): Assessment | undefined {
  const t = text.trim()
  if (t.length < 6 && !images) return undefined
  const reasons: string[] = []
  let score = 0

  const words = t.split(/\s+/).filter(Boolean).length
  if (words > 60) {
    score += 1
    reasons.push('cerere lungă')
  }
  if (words > 160) score += 1

  let hard = 0
  for (const [re, why] of HARD) {
    if (re.test(t)) {
      hard++
      if (hard <= 3) reasons.push(why)
    }
  }
  score += Math.min(hard, 3) * 2

  const easy = !hard && EASY.find(([re]) => re.test(t))
  let medium = 0
  for (const [re, why] of MEDIUM) {
    if (re.test(t)) {
      medium++
      if (!hard && !easy && medium <= 2) reasons.push(why)
    }
  }
  if (easy) {
    // a question or a tiny edit stays small even if it mentions code
    score -= 2
    reasons.push(easy[1])
  } else {
    score += Math.min(medium, 2)
    if (medium && score < 1) score = 1
    if (!medium && !hard && words < 8) score -= 1
  }

  const bullets = t.split('\n').filter((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l)).length
  if (bullets > 3) {
    score += bullets > 7 ? 4 : 3
    reasons.push(`${bullets} cerințe`)
  }
  const files = new Set(t.match(/[\w/-]+\.(tsx?|jsx?|py|rs|go|cs|cpp|java|kt|rb|php|css|html|json|md|lua|gd)\b/gi) || []).size
  if (files >= 3) {
    score += 1
    reasons.push(`${files} fișiere`)
  }
  if (/```/.test(t)) score += 1
  if (/\b(toate|fiecare|complet|totul|everything|every)\b/i.test(t)) score += 1
  if (images) score += 1

  const level: Level = score <= 0 ? 1 : score <= 2 ? 2 : score <= 5 ? 3 : 4
  return {
    level,
    label: LABELS[level],
    reasons: [...new Set(reasons)].slice(0, 4),
    tier: level === 1 ? 'fast' : level === 2 ? 'balanced' : 'deep',
    effort: level === 1 ? 'low' : level === 2 ? 'medium' : level === 3 ? 'high' : 'xhigh'
  }
}

// ---------------------------------------------------------------------------
// Turning a tier into a concrete model of the chosen profile
// ---------------------------------------------------------------------------
// Most preferred pattern first. Opus comes before the frontier models on purpose: those can
// bill extra usage credits on top of the subscription, so Jolty never suggests them on its own.
const TIER_PATTERNS: Record<Tier, RegExp[]> = {
  fast: [/haiku/i, /mini|nano|flash|lite|fast|luna/i],
  balanced: [/sonnet/i, /\bsol\b|balanced|medium|routine/i],
  deep: [/opus/i, /frontier|most capable|complex|demanding|astra|\bpro\b|max/i]
}

/** Models that cost more than the plan (extra usage credits) are only used when picked by hand. */
const EXTRA_COST = /usage credits|extra usage|requires credits/i

/** The same underlying model under two names (e.g. "Default" and "Sonnet"). */
export function sameModel(a?: ModelOption, b?: ModelOption): boolean {
  if (!a || !b) return false
  return a.id === b.id || Boolean(a.description && a.description === b.description)
}

export interface Suggestion {
  model?: ModelOption
  effort?: string
  /** a hint when this profile is a poor fit for the task (e.g. a small local model for a complex job) */
  note?: string
}

/** Picks the model and effort that match the assessment among the profile's own models. */
export function suggest(a: Assessment, profile: Profile | undefined, models: ModelOption[]): Suggestion {
  if (!profile || !models.length) return {}
  const text = (m: ModelOption): string => `${m.id} ${m.label} ${m.description || ''}`
  let model: ModelOption | undefined
  if (profile.auth === 'endpoint') {
    model = models[0]
  } else {
    const candidates = models.filter((m) => !EXTRA_COST.test(text(m)) && !/\[1m\]|-1m\b/i.test(m.id))
    for (const re of TIER_PATTERNS[a.tier]) {
      // prefer the named model over an alias like "Default" that points to it
      model = candidates.find((m) => re.test(text(m)) && !m.isDefault) || candidates.find((m) => re.test(text(m)))
      if (model) break
    }
    if (!model) model = models.find((m) => m.isDefault) || candidates[0] || models[0]
  }
  let effort: string | undefined = a.effort
  const levels = model?.efforts
  if (!levels?.length) effort = undefined
  else if (!levels.includes(a.effort)) {
    // nearest supported level, never above what was asked
    const order = ['low', 'medium', 'high', 'xhigh', 'max']
    effort = [...levels].sort((x, y) => order.indexOf(y) - order.indexOf(x)).find((l) => order.indexOf(l) <= order.indexOf(a.effort)) || levels[0]
  }
  let note: string | undefined
  if (a.level >= 3 && (profile.local || profile.auth === 'endpoint')) {
    note = profile.local
      ? 'Un model local e slab pentru o sarcină de nivelul ăsta. Un profil Claude sau Codex o face mult mai sigur.'
      : 'Pentru o sarcină de nivelul ăsta, un profil Claude sau Codex e de obicei mai sigur.'
  }
  return { model, effort, note }
}
