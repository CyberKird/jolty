// The agent's own task list above the composer, like the Claude app: one quiet line with the
// progress and the current step, opening into the full checklist.
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useEffect, useState } from 'react'
import { capability } from '@shared/complexity'
import { clock, etaLabel, timeLeft } from '@shared/eta'
import { sameProvider } from '@shared/provider'
import type { ChatItem, PlanStep, SessionMeta } from '@shared/types'
import { api, errMsg, useStore } from '../store'
import { useAllModels } from './ModelPicker'
import { tr } from '@shared/i18n'

const NONE: PlanStep[] = []

/** The current time, re-read every second while `on`, for clocks that count. */
export function useNow(on: boolean): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!on) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [on])
  return now
}

export function TaskStrip({ sessionId }: { sessionId: string }) {
  const steps = useStore((s) => s.plans[sessionId]) || NONE
  const running = useStore((s) => s.status[sessionId] === 'running')
  const timer = useStore((s) => s.clocks[sessionId])
  const [open, setOpen] = useState(false)
  const done = steps.filter((s) => s.status === 'done').length
  const all = done === steps.length
  const now = useNow(running && !all && steps.length > 0)
  if (!steps.length) return null
  const current = steps.find((s) => s.status === 'active') || steps.find((s) => s.status === 'pending')
  return (
    <div className={`tasks ${open ? 'open' : ''}`}>
      {open && (
        <ol className="tasks-list" aria-label={tr("Sarcinile modelului")}>
          {steps.map((s, i) => (
            <li key={i} className={`plan-step ${s.status}`}>
              <span className="box" aria-hidden />
              <span>{s.text}</span>
              <span className="sr-only">{s.status === 'done' ? tr(" (gata)") : s.status === 'active' ? tr(" (în lucru)") : ''}</span>
            </li>
          ))}
        </ol>
      )}
      <button className="tasks-bar" aria-expanded={open} onClick={() => setOpen(!open)} title={open ? 'Ascunde sarcinile' : tr("Arată toate sarcinile")}>
        <span className="tasks-count">
          {tr("Sarcini")} {done}/{steps.length}
        </span>
        <span className="tasks-track" aria-hidden>
          <span style={{ transform: `scaleX(${done / steps.length})` }} />
        </span>
        <span className={`tasks-now ${running && !all ? 'live' : ''}`}>{all ? tr("Toate gata") : current?.text}</span>
        {running && !all && (
          <span className="tasks-eta" title={timer?.turn ? tr("Lucrează de {clock}", { clock: clock(now - timer.turn) }) : undefined}>
            {etaLabel(timeLeft(timer, steps, now))}
          </span>
        )}
        {open ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
      </button>
    </div>
  )
}

const LIMIT_HIT = /limita abonamentului/i

/**
 * The account ran out mid-task: one click carries the same chat to another account of the same
 * provider (same files, full context) and lets it pick up where it stopped.
 */
export function LimitStrip({ session }: { session: SessionMeta }) {
  const items = useStore((s) => s.transcripts[session.id]) || NONE_ITEMS
  const running = useStore((s) => s.status[session.id] === 'running')
  const profiles = useStore((s) => s.profiles)
  const limits = useStore((s) => s.limits)
  const { loadSessions, toast } = useStore()
  const [busy, setBusy] = useState(false)
  if (running) return null
  let hit = false
  for (let i = items.length - 1; i >= 0 && !hit; i--) {
    const it = items[i]
    if (it.kind === 'user') break
    hit = it.kind === 'notice' && LIMIT_HIT.test(it.text)
  }
  const me = profiles.find((p) => p.id === session.profileId)
  if (!hit || !me) return null
  const worst = (id: string): number => Math.max(0, ...(limits[id]?.windows || []).map((w) => w.usedPercent))
  const next = profiles.filter((p) => sameProvider(me, p) && worst(p.id) < 100).sort((a, b) => worst(a.id) - worst(b.id))[0]
  const go = async (): Promise<void> => {
    if (!next) return
    setBusy(true)
    try {
      await api.sessions.handoff(session.id, next.id, session.model, session.effort)
      await loadSessions()
      // shown as working at once, like a message sent from the composer
      useStore.getState().onEvent({ type: 'status', sessionId: session.id, status: 'running' })
      await api.sessions.send(session.id, tr("Continuă de unde ai rămas: contul {me} a atins limita, acum lucrezi pe {next}.", { me: me.name, next: next.name }))
    } catch (err) {
      toast(errMsg(err), true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="verification-strip" role="status">
      <span className="verification-text">{tr("Limita contului {name} e atinsă", { name: me.name })}</span>
      {next ? (
        <>
          <span className="verification-cost">{tr("Același chat, cu tot contextul")}</span>
          <button disabled={busy} onClick={() => void go()}>
            {tr("Continuă pe {name} · {pct}% folosit", { name: next.name, pct: Math.round(worst(next.id)) })}
          </button>
        </>
      ) : (
        <span className="verification-cost">{tr("Niciun alt cont liber la același furnizor: folosește Continuă în")}</span>
      )}
    </div>
  )
}

/** A downloaded update, next to the composer where it is seen; × hides it until the next version. */
export function UpdateStrip() {
  const update = useStore((s) => s.update)
  const busy = useStore((s) => Object.values(s.status).includes('running'))
  const [hidden, setHidden] = useState(() => sessionStorage.getItem('jolty:update-hidden'))
  if (update?.state !== 'ready' || hidden === update.version) return null
  const hide = (): void => {
    sessionStorage.setItem('jolty:update-hidden', update.version || '')
    setHidden(update.version || '')
  }
  return (
    <div className="verification-strip update-strip" role="status">
      <span className="verification-text">{tr("Jolty {version} e gata de instalat", { version: update.version })}</span>
      <span className="verification-cost">{busy ? tr("Așteaptă să termine conversațiile care lucrează") : tr("Câteva secunde, conversațiile rămân")}</span>
      <button disabled={busy} onClick={() => void api.updates.install()}>{tr("Repornește acum")}</button>
      <button onClick={hide} aria-label={tr("Mai târziu")} title={tr("Mai târziu (rămâne butonul din bara de sus)")}>×</button>
    </div>
  )
}

const CHECK_COMMAND = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|typecheck|lint|check)\b|\b(?:npx\s+)?(?:tsc|eslint|vitest|jest|pytest)\b|\b(?:cargo|go|dotnet)\s+(?:test|build|check)\b|\bgit\s+diff\s+--check\b/i
const EXTRA_COST = /usage credits|extra usage|requires credits|per mtok|\$\d+(?:\.\d+)?\s*\/\s*\$\d/i

function failedCheck(items: ChatItem[]): Extract<ChatItem, { kind: 'tool' }> | undefined {
  let lastUser = -1
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].kind === 'user') { lastUser = i; break }
  }
  if (lastUser < 0) return undefined
  const checks = items.slice(lastUser + 1).filter((item): item is Extract<ChatItem, { kind: 'tool' }> =>
    item.kind === 'tool' && Boolean(item.command && CHECK_COMMAND.test(item.command))
  )
  const latest = checks.at(-1)
  return latest && (latest.status === 'error' || (typeof latest.exitCode === 'number' && latest.exitCode !== 0)) ? latest : undefined
}

export function VerificationStrip({ session }: { session: SessionMeta }) {
  const items = useStore((s) => s.transcripts[session.id]) || NONE_ITEMS
  const running = useStore((s) => s.status[session.id] === 'running')
  const profiles = useStore((s) => s.profiles)
  const { loadSessions, toast } = useStore()
  const groups = useAllModels(profiles)
  const [dismissed, setDismissed] = useState<string>()
  const [busy, setBusy] = useState(false)
  const failed = failedCheck(items)
  if (running || !failed || dismissed === failed.id) return null

  const group = groups.find((g) => g.profile.id === session.profileId)
  const current = group?.models.find((m) => m.id === session.model) || group?.models.find((m) => m.isDefault)
  const grade = group && current ? capability(group.profile, current).grade : 0
  const stronger = current && (group?.profile.auth === 'subscription' || group?.profile.local) ? group.models
    .filter((m) => !m.isDefault && !EXTRA_COST.test(`${m.id} ${m.label} ${m.description || ''}`) && !/\[1m\]|-1m\b/i.test(m.id))
    .filter((m) => capability(group.profile, m).grade > grade)
    .sort((a, b) => capability(group.profile, a).grade - capability(group.profile, b).grade)[0] : undefined

  const retry = async (model?: string): Promise<void> => {
    setBusy(true)
    try {
      if (model) {
        await api.sessions.setModel(session.id, model)
        await loadSessions()
      }
      await api.sessions.send(session.id, tr("Ultima verificare a eșuat. Citește rezultatul ei, repară cauza și rulează verificarea din nou. Limitează schimbările la problema găsită."))
      setDismissed(failed.id)
    } catch (err) { toast(errMsg(err), true) }
    finally { setBusy(false) }
  }

  return (
    <div className="verification-strip" role="status">
      <span className="verification-text" title={failed.title}>{tr("Verificare eșuată:")} {failed.title}</span>
      <span className="verification-cost">{group?.profile.local ? tr("Fără cost API") : group?.profile.auth === 'apiKey' || group?.profile.auth === 'endpoint' ? tr("Răspuns nou, tarifat de furnizor") : tr("Consumă un răspuns doar dacă alegi")}</span>
      <button disabled={busy} onClick={() => void retry()}>{tr("Repară cu modelul actual")}</button>
      {stronger && <button disabled={busy} onClick={() => void retry(stronger.id)} title={tr("Schimbă modelul în același cont și consumă încă un răspuns")}>{tr("Încearcă")} {stronger.label}</button>}
      <button disabled={busy} onClick={() => setDismissed(failed.id)} aria-label={tr("Ascunde sugestia")}>×</button>
    </div>
  )
}

const NONE_ITEMS: ChatItem[] = []
