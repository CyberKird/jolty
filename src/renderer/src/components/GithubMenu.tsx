// GitHub for the folder of this chat on a button of its own: the pull request of the branch with its checks and
// GitHub's auto-merge, and the open issues, one click from the message. It shows only where `gh` finds a repository.
import { Check, GitPullRequest } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { tr } from '@shared/i18n'
import type { GithubOverview, GithubPr } from '@shared/types'
import { api, errMsg, useStore } from '../store'
import { usePopover } from './ModelPicker'

const stateOf = (pr: GithubPr): 'fail' | 'pending' | 'pass' =>
  pr.checks.some((c) => c.state === 'fail') ? 'fail' : pr.checks.some((c) => c.state === 'pending') ? 'pending' : 'pass'

export function GithubMenu({ sessionId, onIssue }: { sessionId: string; onIssue: (text: string) => void }) {
  const { open, setOpen, ref, shown, state } = usePopover()
  const toast = useStore((s) => s.toast)
  const [data, setData] = useState<GithubOverview>()
  const load = useCallback(
    (force: boolean) => {
      void api.sessions.githubOverview(sessionId, force).then(setData).catch(() => setData(undefined))
    },
    [sessionId]
  )
  useEffect(() => {
    setData(undefined)
    load(false)
  }, [load])
  useEffect(() => {
    if (open) load(true)
  }, [open, load])

  if (data?.kind !== 'ok') return null
  const pr = data.pr
  const checksDone = pr ? pr.checks.filter((c) => c.state === 'pass' || c.state === 'skipped').length : 0
  const label = pr ? `#${pr.number}: ${tr("{ok} din {total} verificări trecute", { ok: String(checksDone), total: String(pr.checks.length) })}` : `GitHub: ${data.repo}`

  const pick = (n: number): void => {
    void api.sessions.githubIssue(sessionId, n).then(
      (text) => {
        onIssue(text)
        setOpen(false)
      },
      (err) => toast(errMsg(err), true)
    )
  }
  const toggleAuto = (): void => {
    if (!pr) return
    void api.sessions.githubAutoMerge(sessionId, !pr.autoMerge).then(
      () => load(true),
      (err) => toast(errMsg(err), true)
    )
  }

  return (
    <div className="picker" ref={ref}>
      <button className="chrome-toggle" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} title={label} aria-label={label}>
        <GitPullRequest size={14} strokeWidth={1.8} />
        {pr && (
          <>
            <span className={`gh-dot ${stateOf(pr)}`} aria-hidden />
            <span className="connector-count">#{pr.number}</span>
          </>
        )}
      </button>
      {shown && (
        <div className="picker-pop small github-pop" data-state={state} role="menu" aria-label={`GitHub: ${data.repo}`}>
          <div className="picker-list">
            {pr ? (
              <>
                <button data-opt role="menuitem" className="picker-opt" onClick={() => void api.app.openExternal(pr.url)} title={pr.url}>
                  <span className="picker-opt-text">
                    <span className="picker-opt-name">#{pr.number} {pr.title}</span>
                    <span className="picker-opt-desc">
                      {pr.state === 'MERGED' ? tr("îmbinat") : pr.state === 'CLOSED' ? tr("închis") : pr.draft ? tr("ciornă") : ''}
                      {pr.checks.length ? ` ${tr("{ok} din {total} verificări trecute", { ok: String(checksDone), total: String(pr.checks.length) })}` : ''}
                    </span>
                  </span>
                  <span className={`gh-dot ${stateOf(pr)}`} aria-hidden />
                </button>
                {pr.state === 'OPEN' && (
                  <button data-opt role="menuitemcheckbox" aria-checked={pr.autoMerge} className={`picker-opt ${pr.autoMerge ? 'on' : ''}`} onClick={toggleAuto} title={tr("GitHub îmbină pull request-ul (squash) imediat ce verificările trec.")}>
                    <span className="picker-opt-text">
                      <span className="picker-opt-name">{tr("Merge când e gata")}</span>
                    </span>
                    {pr.autoMerge && <Check size={14} />}
                  </button>
                )}
              </>
            ) : (
              <div className="gh-empty">{tr("Niciun pull request pentru ramura curentă.")}</div>
            )}
            <div className="picker-group-head">{tr("Issues deschise")}</div>
            {data.issues.length === 0 && <div className="gh-empty">{tr("Nu sunt issues deschise.")}</div>}
            {data.issues.map((i) => (
              <button key={i.number} data-opt role="menuitem" className="picker-opt" onClick={() => pick(i.number)} title={tr("Pune issue-ul în mesaj")}>
                <span className="picker-opt-text">
                  <span className="picker-opt-name">#{i.number} {i.title}</span>
                  {i.labels.length > 0 && <span className="picker-opt-desc">{i.labels.join(', ')}</span>}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
