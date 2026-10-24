// Knows when a model is new or updated and shows it in the picker, and keeps the intelligence/speed table
// fresh without a release. Every listing here is best effort: a failure is never shown to the user.
//
// Sources: Claude and Codex lists as the engines give them (recorded when the picker or the hourly scan loads
// them), the models Ollama has, and the model list of an endpoint provider (DeepSeek, Xiaomi MiMo...) at its own host.
import { Notification } from 'electron'
import type { ModelOption, Profile } from '@shared/types'
import { isAcp } from '@shared/types'
import { modelScore, parseRemoteScores, setRemoteScores } from '@shared/scores'
import { tr } from '@shared/i18n'
import * as store from './store'
import { OLLAMA_URL } from './local'
import { observe, parseOllamaTags, parseProviderList, withBadges, type Observed } from './model-watch-core'

const SCORES_URL = 'https://raw.githubusercontent.com/CyberKird/jolty/main/scores.json'
const EVERY = 3600e3
const TIMEOUT = 8000
/** a model list or the scores file is a few KB; anything bigger is not what we asked for */
const MAX_BYTES = 200_000

/** Local profiles share one source (Ollama); every other profile has its own. */
const sourceKey = (p: Profile): string => (p.local ? 'ollama' : p.id)
/** Profiles whose model list comes from the engine itself; endpoint profiles list what the user typed, so their source is the provider. */
const listedByEngine = (p: Profile): boolean => p.auth !== 'endpoint' && !isAcp(p.engine)

async function getJson(url: string, headers?: Record<string, string>): Promise<unknown> {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT), redirect: 'error' })
  if (!r.ok) throw new Error(String(r.status))
  const text = await r.text()
  if (text.length > MAX_BYTES) throw new Error('too big')
  return JSON.parse(text)
}

function notify(p: Profile, fresh: Observed[]): void {
  if (p.local || process.env.JOLTY_TEST || !Notification.isSupported()) return
  const here = fresh.every((m) => listedByEngine(p) || p.models?.includes(m.id))
  const names = fresh.map((m) => (listedByEngine(p) ? m.label : `${p.name}: ${m.label}`)).join(', ')
  new Notification({
    title: tr("Model nou în Jolty: {join}", { join: names }),
    body: here ? tr("Îl găsești în lista de modele din chat.") : tr("Nu e încă în lista contului. Adaugă-l la Conturi și chei.")
  }).show()
}

function record(p: Profile, current: Observed[]): void {
  // an empty list is a listing that failed quietly: recording it would make the next real list all new
  if (!current.length) return
  const file = store.loadModelWatch()
  const key = sourceKey(p)
  const r = observe(file[key], current, Date.now())
  if (r.next === file[key] && !r.fresh.length && !r.changed.length) return
  file[key] = r.next
  store.saveModelWatch(file)
  if (r.fresh.length) notify(p, r.fresh)
}

/** The list the picker gets: recorded for the watch, with badges and the score of each model attached. */
export function decorate(p: Profile, list: ModelOption[]): ModelOption[] {
  try {
    if (listedByEngine(p)) record(p, list.filter((m) => m.id !== 'default').map((m) => ({ id: m.id, label: m.label, version: m.description })))
    list = withBadges(list, store.loadModelWatch()[sourceKey(p)], Date.now())
  } catch {
    // the watch must never keep the picker from loading
  }
  return list.map((m) => {
    const score = modelScore(p, m)
    return score ? { ...m, score } : m
  })
}

async function listProvider(p: Profile): Promise<Observed[]> {
  if (p.local) return parseOllamaTags(await getJson(`${OLLAMA_URL}/api/tags`))
  const secret = store.getSecret(p.id)
  const url = p.baseUrl ? new URL(p.baseUrl) : undefined
  // the key only goes to the host the chat itself talks to, and only over https
  if (!secret || url?.protocol !== 'https:') return []
  for (const path of ['/models', '/v1/models']) {
    try {
      const list = parseProviderList(await getJson(url.origin + path, { authorization: `Bearer ${secret}` }))
      if (list.length) return list
    } catch {
      // this provider has no listing at that path
    }
  }
  return []
}

async function refreshScores(): Promise<void> {
  try {
    const raw = await getJson(SCORES_URL)
    const entries = parseRemoteScores(raw)
    if (!entries) return
    setRemoteScores(entries)
    store.saveScoresCache(raw)
  } catch {
    // offline or GitHub down: the last good copy (or the built-in table) stays
  }
}

/** Loads the cached scores now; with `scan` also checks every source after a short delay and then every hour. */
export function start(deps: { scan: boolean; profiles: () => Profile[]; loggedIn: (id: string) => Promise<boolean>; models: (id: string) => Promise<ModelOption[]> }): void {
  const cached = parseRemoteScores(store.loadScoresCache())
  if (cached) setRemoteScores(cached)
  if (!deps.scan) return
  const run = async (): Promise<void> => {
    void refreshScores()
    const seen = new Set<string>()
    for (const p of deps.profiles()) {
      if (isAcp(p.engine) || seen.has(sourceKey(p))) continue
      seen.add(sourceKey(p))
      try {
        if (!listedByEngine(p)) record(p, await listProvider(p))
        else if (await deps.loggedIn(p.id)) await deps.models(p.id)
      } catch {
        // not logged in, offline, provider without a listing
      }
    }
  }
  setTimeout(() => void run(), 30_000)
  setInterval(() => void run(), EVERY)
}
