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

/** A quiet bug icon beside the account in the sidebar; opens a small form that ends in the user's mail app. */
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
  return (
    <div className="modal-back" data-state={state} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal bug-modal">
        <h2 className="modal-title">{tr("Raportează o problemă")}</h2>
        <p className="muted">{tr("Spune-ne ce s-a întâmplat și ce te așteptai. Se deschide emailul tău, cu mesajul gata scris, către {mail}; tu apeși Trimite.", { mail: CONTACT })}</p>
        <textarea className="textarea" rows={6} autoFocus value={text} maxLength={1200} onChange={(e) => { setText(e.target.value); setProblem(undefined) }} placeholder={tr("Ce s-a întâmplat?")} />
        {problem && <p className="small" role="alert" style={{ color: 'var(--del-ink)' }}>{WHY[problem]()}</p>}
        <p className="faint small">{tr("Se adaugă singure doar versiunea Jolty, Windows-ul și limba. Nu se trimit chaturile tale.")}</p>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button
            className="btn"
            onClick={() => {
              void navigator.clipboard.writeText(CONTACT).then(() => setCopied(true))
            }}
          >
            {copied ? tr("Adresa e copiată") : tr("Copiază adresa")}
          </button>
          <button
            className="btn primary"
            onClick={async () => {
              const now = Date.now()
              const check = reportCheck(text, sentTimes(), now)
              if (check !== 'ok') return setProblem(check)
              try {
                localStorage.setItem(SENT, JSON.stringify([...sentTimes().filter((at) => now - at < 36e5), now]))
              } catch {
                // without storage the brake just doesn't remember
              }
              await api.app.openExternal(bugReportUrl(text, await facts()))
              close()
            }}
          >
            {tr("Deschide emailul")}
          </button>
        </div>
      </div>
    </div>
  )
}
