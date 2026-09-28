// Estimates how demanding a request is while the user types, and suggests a model tier and an
// effort level for it. Runs locally on every keystroke, so it is a fast heuristic, not a model call.
import type { ModelOption, Profile, RateLimitSnapshot } from './types'

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
// What each model is good for, compared with the Claude models the user knows
// ---------------------------------------------------------------------------
/** 5 = frontier (Opus, Fable, Codex's top model), 4 = Sonnet class, 3 = unverified API, 2 = Haiku class, 1 = small. */
export type Grade = 1 | 2 | 3 | 4 | 5

export interface Capability {
  grade: Grade
  /** short tag shown in the model menu */
  tag: string
  /** the comparison in words, with where it comes from */
  compare: string
}

/** Models that cost more than the plan (extra usage credits) are only used when picked by hand. */
const EXTRA_COST = /usage credits|extra usage|requires credits|per mtok|\$\d+(\.\d+)?\s*\/\s*\$\d/i
const text = (m: ModelOption): string => `${m.id} ${m.label} ${m.description || ''}`

export function capability(profile: Profile, m: ModelOption): Capability {
  const t = text(m)
  if (profile.local) return { grade: 2, tag: 'local', compare: 'Model local: cel mult la nivelul lui Haiku 4.5 (estimare din catalogul Jolty, nu test propriu).' }
  if (profile.auth === 'endpoint' || profile.engine === 'hermes')
    return { grade: 3, tag: 'nevalidat', compare: 'API extern: nu există o comparație verificată cu Claude. Bun pentru sarcini medii; la cele grele un model de top e mai sigur.' }
  if (profile.engine === 'claude') {
    if (/fable/i.test(t)) return { grade: 5, tag: 'top', compare: 'Cel mai capabil model Claude, pentru sarcinile cele mai grele și lungi.' }
    if (/opus/i.test(t)) return { grade: 5, tag: 'top', compare: 'Opus: nivel de top pentru cod și sarcini complexe.' }
    if (/sonnet/i.test(t)) return { grade: 4, tag: 'echilibrat', compare: 'Sonnet: rapid și solid pentru munca de zi cu zi.' }
    if (/haiku/i.test(t)) return { grade: 2, tag: 'rapid', compare: 'Haiku: cel mai rapid, pentru cereri mici.' }
    return { grade: 4, tag: 'Claude', compare: 'Model Claude.' }
  }
  if (/astra|frontier|most demanding|most capable/i.test(t)) return { grade: 5, tag: 'top', compare: 'Modelul de top Codex: aceeași clasă cu Opus la sarcini grele (după descrierea OpenAI).' }
  if (/luna|mini|nano|lite|fast|quick/i.test(t)) return { grade: 2, tag: 'rapid', compare: 'Model Codex rapid, pentru cereri mici.' }
  return { grade: 4, tag: 'echilibrat', compare: 'Model Codex echilibrat, bun pentru cod de zi cu zi.' }
}

// ---------------------------------------------------------------------------
// Recommendation: quiet when the current pick fits, one line when it clearly does not
// ---------------------------------------------------------------------------
const NEEDED: Record<Level, Grade> = { 1: 1, 2: 3, 3: 4, 4: 5 }
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

export interface ModelGroupLite {
  profile: Profile
  models: ModelOption[]
  error?: string
}

export interface Pick {
  profileId: string
  modelId?: string
  effort?: string
}

export interface Recommendation {
  kind: 'weak' | 'limit' | 'overkill' | 'none'
  text: string
  target?: { profileId: string; model: ModelOption; effort?: string; profileName: string }
}

/** Highest used share of the account's 5 h / 7 d windows (0 when unknown). */
export function limitLoad(snap?: RateLimitSnapshot): number {
  return Math.max(0, ...(snap?.windows.map((w) => w.usedPercent) || []))
}

/** The supported level closest to the wanted one, never above it. */
function fitEffort(m: ModelOption, wanted: string): string | undefined {
  const levels = m.efforts
  if (!levels?.length) return undefined
  if (levels.includes(wanted)) return wanted
  const w = EFFORTS.indexOf(wanted)
  return [...levels].sort((x, y) => EFFORTS.indexOf(y) - EFFORTS.indexOf(x)).find((l) => EFFORTS.indexOf(l) <= w) || levels[0]
}

export function recommend(a: Assessment, groups: ModelGroupLite[], current: Pick, limits: Record<string, RateLimitSnapshot>): Recommendation {
  const none: Recommendation = { kind: 'none', text: '' }
  const cg = groups.find((g) => g.profile.id === current.profileId)
  const cm = cg?.models.find((m) => m.id === current.modelId) || cg?.models.find((m) => m.isDefault)
  if (!cg || !cm) return none
  const need = NEEDED[a.level]
  const cur = capability(cg.profile, cm)
  const curLoad = limitLoad(limits[cg.profile.id])

  // every model that can do the job, from every account that is connected and not at its limit
  const candidates = groups
    .filter((g) => !g.error && (g.profile.engine !== 'hermes' || g.profile.id === current.profileId) && limitLoad(limits[g.profile.id]) < 95)
    .flatMap((g) =>
      g.models
        .filter((m) => !EXTRA_COST.test(text(m)) && !/\[1m\]|-1m\b/i.test(m.id))
        .map((m) => ({ g, m, cap: capability(g.profile, m) }))
    )
    .filter((c) => c.cap.grade >= need)
    .sort((x, y) => {
      const k = (c: typeof x): number[] => [
        c.g.profile.id === cg.profile.id ? 0 : 1, // staying keeps the whole context
        c.g.profile.auth === 'subscription' || c.g.profile.local ? 0 : 1, // already paid for
        c.cap.grade - need, // the smallest model that is enough
        c.m.isDefault ? 1 : 0, // the named model over its "Default" alias
        limitLoad(limits[c.g.profile.id])
      ]
      const a1 = k(x)
      const b1 = k(y)
      for (let i = 0; i < a1.length; i++) if (a1[i] !== b1[i]) return a1[i] - b1[i]
      return 0
    })
  const best = candidates[0]
  const target = best && { profileId: best.g.profile.id, model: best.m, effort: fitEffort(best.m, a.effort), profileName: best.g.profile.name }

  if (cur.grade < need) {
    if (!target) return { kind: 'weak', text: `Sarcină ${a.label.toLowerCase()}: niciun model conectat nu e la nivelul ideal. Merge, dar verifică atent rezultatul.` }
    return { kind: 'weak', text: `${cm.label} e prea slab pentru o sarcină ${a.label.toLowerCase()}.`, target }
  }
  // the model fits, but an explicitly low effort would hold it back on hard work
  const chosen = current.effort
  if (a.level >= 3 && chosen && cm.efforts?.length && EFFORTS.indexOf(chosen) < EFFORTS.indexOf(a.effort)) {
    const e = fitEffort(cm, a.effort)
    if (e && e !== chosen) return { kind: 'weak', text: `Efortul ${chosen} e mic pentru o sarcină ${a.label.toLowerCase()}.`, target: { profileId: cg.profile.id, model: cm, effort: e, profileName: cg.profile.name } }
  }
  if (curLoad >= 90 && target && target.profileId !== cg.profile.id) {
    return { kind: 'limit', text: `${cg.profile.name} e la ${Math.round(curLoad)}% din limită.`, target }
  }
  // clear overkill on a small request: say it once, quietly
  if (a.level === 1 && (cur.grade === 5 || (chosen && EFFORTS.indexOf(chosen) >= EFFORTS.indexOf('xhigh'))) && target && target.profileId === cg.profile.id) {
    if (target.model.id !== cm.id || (target.effort && target.effort !== chosen)) return { kind: 'overkill', text: 'Cerere mică: ajunge un model mai ușor și îți cruță limita.', target }
  }
  return none
}

// ---------------------------------------------------------------------------
// Auto-delegation: big mechanical work to a cheap endpoint or local model
// ---------------------------------------------------------------------------
const DELEGATE = /\b(refactor|rescrie|scrie.{0,20}(teste?|test|doc|documenta|tipuri|types)|tests? for|docstring|documenta|tipuri|\btypes\b|lint|formatat|migrat|convertit|sumariz|rezumat|tradu)/i
const SECRET = /\b(sk-[a-z0-9]|api[_-]?key|token|password|secret|parola|authorization)\b/i

/**
 * New chats only: an already running session keeps its engine and model.
 * ponytail: 20 words is the cost floor; raise it if short refactors start getting routed away.
 */
export function delegatePick(text: string, profiles: Profile[], currentId?: string): Profile | undefined {
  if (text.trim().split(/\s+/).filter(Boolean).length < 20) return undefined
  if (SECRET.test(text) || !DELEGATE.test(text)) return undefined
  const current = profiles.find((p) => p.id === currentId)
  if (current?.local || current?.auth === 'endpoint') return undefined
  return profiles.find((p) => p.auth === 'endpoint' && p.engine === 'claude' && p.hasSecret) || profiles.find((p) => p.local)
}
