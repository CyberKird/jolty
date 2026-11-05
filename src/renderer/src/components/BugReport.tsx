import { Bug } from 'lucide-react'
import { useState } from 'react'
import { tr } from '@shared/i18n'
import { bugReportUrl, CONTACT, reportCheck } from '@shared/links'
import { api } from '../store'
import { useExitClose } from '../usePresence'

const SENT = 'jolty.bugReports'
const sentTimes = (): number[] => {
  try {
    const v = JSON.parse(localStorage.getItem(SENT) || '[]')
    return Array.isArray(v) ? v.filter((n) => typeof n === 'number') : []
  } catch {
    return []
  }
}
const WHY = {
  short: () => tr("Scrie măcar câteva cuvinte despre ce s-a întâmplat."),
  links: () => tr("Fără liste de linkuri în raport: scrie doar ce s-a întâmplat."),
  wait: () => tr("Ai trimis deja câteva rapoarte. Încearcă din nou peste o oră.")
}

async function facts(): Promise<string> {
  const os = navigator.userAgent.match(/Windows NT [\d.]+/)?.[0] ?? navigator.platform
  return `Jolty ${await api.app.version().catch(() => '?')} | ${os} | ${navigator.language}`
}

/** A quiet bug icon beside the account in the sidebar; opens a small form that sends the report to Jolty's inbox. */
export function BugReportButton() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button className="bug-btn" onClick={() => setOpen(true)} title={tr("Raportează o problemă")} aria-label={tr("Raportează o problemă")}>
        <Bug size={15} />
      </button>
      {open && <BugReport onClose={() => setOpen(false)} />}
    </>
  )
}

function BugReport({ onClose }: { onClose: () => void }) {
  const { state, close } = useExitClose(onClose)
  const [text, setText] = useState('')
  const [copied, setCopied] = useState(false)
  const [problem, setProblem] = useState<'short' | 'links' | 'wait'>()
  const [phase, setPhase] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle')
  const send = async (): Promise<void> => {
    const now = Date.now()
    const check = reportCheck(text, sentTimes(), now)
    if (check !== 'ok') return setProblem(check)
    setPhase('sending')
    try {
      await api.app.sendBugReport(text, await facts())
    } catch {
      return setPhase('failed')
    }
    try {
      localStorage.setItem(SENT, JSON.stringify([...sentTimes().filter((at) => now - at < 36e5), now]))
    } catch {
      // without storage the brake just doesn't remember
    }
    setPhase('sent')
  }
  return (
    <div className="modal-back" data-state={state} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal bug-modal">
        <h2 className="modal-title">{tr("Raportează o problemă")}</h2>
        <p className="muted">{tr("Spune-ne ce s-a întâmplat și ce te așteptai. Raportul ajunge direct la noi, fără să deschizi emailul.")}</p>
        <textarea className="textarea" rows={6} autoFocus disabled={phase === 'sending' || phase === 'sent'} value={text} maxLength={1200} onChange={(e) => { setText(e.target.value); setProblem(undefined) }} placeholder={tr("Ce s-a întâmplat?")} />
        {problem && <p className="small" role="alert" style={{ color: 'var(--del-ink)' }}>{WHY[problem]()}</p>}
        {phase === 'failed' && <p className="small" role="alert" style={{ color: 'var(--del-ink)' }}>{tr("Nu am putut trimite raportul. Verifică internetul sau trimite-l prin email.")}</p>}
        {phase === 'sent' && <p className="small" role="status">{tr("Raportul a fost trimis. Mulțumim!")}</p>}
        <p className="faint small">{tr("Se adaugă singure doar versiunea Jolty, Windows-ul și limba. Nu se trimit chaturile tale.")}</p>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          {phase === 'failed' && (
            <>
              <button
                className="btn"
                onClick={() => {
                  void navigator.clipboard.writeText(CONTACT).then(() => setCopied(true))
                }}
              >
                {copied ? tr("Adresa e copiată") : tr("Copiază adresa")}
              </button>
              <button className="btn" onClick={async () => void api.app.openExternal(bugReportUrl(text, await facts()))}>
                {tr("Deschide emailul")}
              </button>
            </>
          )}
          {phase === 'sent' ? (
            <button className="btn primary" onClick={close}>
              {tr("Închide")}
            </button>
          ) : (
            <button className="btn primary" disabled={phase === 'sending'} onClick={() => void send()}>
              {phase === 'sending' ? tr("Se trimite…") : phase === 'failed' ? tr("Încearcă din nou") : tr("Trimite raportul")}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
