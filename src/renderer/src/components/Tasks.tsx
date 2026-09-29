// The agent's own task list above the composer, like the Claude app: one quiet line with the
// progress and the current step, opening into the full checklist.
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useState } from 'react'
import { capability } from '@shared/complexity'
import type { ChatItem, PlanStep, SessionMeta } from '@shared/types'
import { api, errMsg, useStore } from '../store'
import { useAllModels } from './ModelPicker'

const NONE: PlanStep[] = []

export function TaskStrip({ sessionId }: { sessionId: string }) {
  const steps = useStore((s) => s.plans[sessionId]) || NONE
  const running = useStore((s) => s.status[sessionId] === 'running')
  const [open, setOpen] = useState(false)
  if (!steps.length) return null
  const done = steps.filter((s) => s.status === 'done').length
  const all = done === steps.length
  const current = steps.find((s) => s.status === 'active') || steps.find((s) => s.status === 'pending')
  return (
    <div className={`tasks ${open ? 'open' : ''}`}>
      {open && (
        <ol className="tasks-list" aria-label="Sarcinile modelului">
          {steps.map((s, i) => (
            <li key={i} className={`plan-step ${s.status}`}>
              <span className="box" aria-hidden />
              <span>{s.text}</span>
              <span className="sr-only">{s.status === 'done' ? ' (gata)' : s.status === 'active' ? ' (în lucru)' : ''}</span>
            </li>
          ))}
        </ol>
      )}
      <button className="tasks-bar" aria-expanded={open} onClick={() => setOpen(!open)} title={open ? 'Ascunde sarcinile' : 'Arată toate sarcinile'}>
        <span className="tasks-count">
          Sarcini {done}/{steps.length}
        </span>
        <span className="tasks-track" aria-hidden>
          <span style={{ transform: `scaleX(${done / steps.length})` }} />
        </span>
        <span className={`tasks-now ${running && !all ? 'live' : ''}`}>{all ? 'Toate gata' : current?.text}</span>
        {open ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
      </button>
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
      await api.sessions.send(session.id, 'Ultima verificare a eșuat. Citește rezultatul ei, repară cauza și rulează verificarea din nou. Limitează schimbările la problema găsită.')
      setDismissed(failed.id)
    } catch (err) { toast(errMsg(err), true) }
    finally { setBusy(false) }
  }

  return (
    <div className="verification-strip" role="status">
      <span className="verification-text" title={failed.title}>Verificare eșuată: {failed.title}</span>
      <span className="verification-cost">{group?.profile.local ? 'Fără cost API' : group?.profile.auth === 'apiKey' || group?.profile.auth === 'endpoint' ? 'Răspuns nou, tarifat de furnizor' : 'Consumă un răspuns doar dacă alegi'}</span>
      <button disabled={busy} onClick={() => void retry()}>Repară cu modelul actual</button>
      {stronger && <button disabled={busy} onClick={() => void retry(stronger.id)} title="Schimbă modelul în același cont și consumă încă un răspuns">Încearcă {stronger.label}</button>}
      <button disabled={busy} onClick={() => setDismissed(failed.id)} aria-label="Ascunde sugestia">×</button>
    </div>
  )
}

const NONE_ITEMS: ChatItem[] = []
