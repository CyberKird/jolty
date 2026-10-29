import { GitBranch, Loader2, RefreshCw, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { create } from 'zustand'
import type { SessionMeta } from '@shared/types'
import { conflictMessage, prDraft, type MergeAction, type MergeCheck, type MergeStatus } from '@shared/merge'
import { tr } from '@shared/i18n'
import { api, useStore } from '../store'
import { useExitClose } from '../usePresence'
import { DiffView } from './Rich'
import './merge.css'

const useMerge = create<{ id?: string }>(() => ({}))
export const openMerge = (id: string): void => useMerge.setState({ id })

/** The branch mark on a session row with a worktree; a click opens the merge assistant instead of the chat. */
export function BranchButton({ s }: { s: SessionMeta }) {
  if (!s.worktree) return null
  return (
    <button
      className="live-branch merge-open"
      title={tr("Asistent de merge: {branch}", { branch: s.worktree.branch })}
      aria-label={tr("Asistent de merge: {branch}", { branch: s.worktree.branch })}
      onClick={(e) => {
        e.stopPropagation()
        openMerge(s.id)
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <GitBranch size={11} />
    </button>
  )
}

/** Mounted once; shows the panel for the session picked with openMerge. */
export function MergeHost() {
  const id = useMerge((m) => m.id)
  return id ? <MergePanel key={id} id={id} onClose={() => useMerge.setState({ id: undefined })} /> : null
}

type Pending = { kind: MergeAction; check: MergeCheck } | { kind: 'pr'; title: string; body: string } | { kind: 'remove' }

function MergePanel({ id, onClose }: { id: string; onClose: () => void }) {
  const { state, close } = useExitClose(onClose)
  const session = useStore((st) => st.sessions.find((x) => x.id === id))
  const running = useStore((st) => st.status[id] === 'running')
  const [s, setS] = useState<MergeStatus>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<Pending>()
  const [done, setDone] = useState<string>()

  const load = useCallback(async () => {
    setError(undefined)
    try {
      setS(await api.merge.status(id))
    } catch (e) {
      setError((e as Error).message)
    }
  }, [id])
  useEffect(() => void load(), [load])

  /** Runs one step; the panel reloads after it, so what it shows is always what git says now. */
  const step = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(undefined)
    setDone(undefined)
    try {
      await fn()
    } catch (e) {
      setPending(undefined)
      setError((e as Error).message)
    }
    setBusy(false)
    await load()
  }
  const check = (kind: MergeAction): Promise<void> => step(async () => setPending({ kind, check: await api.merge.check(id, kind) }))
  const askModel = async (kind: MergeAction, files: string[]): Promise<void> => {
    if (!s) return
    const target = session?.parentId && useStore.getState().sessions.some((x) => x.id === session.parentId) ? session.parentId : id
    await step(async () => {
      await api.sessions.send(target, conflictMessage(s, kind, files))
      close()
      await useStore.getState().openSession(target)
    })
  }

  const n = s?.commits.length ?? 0
  const base = s?.base ?? ''
  const lose = s ? (!s.merged && Boolean(s.tip)) : false
  return (
    <div className="modal-back" data-state={state} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal merge-modal" role="dialog" aria-label={tr("Asistent de merge")}>
        <div className="merge-top">
          <h2 className="modal-title">{tr("Asistent de merge")}</h2>
          <button className="btn small icon ghost" title={tr("Reîncarcă")} aria-label={tr("Reîncarcă")} disabled={busy} onClick={() => void step(async () => setPending(undefined))}>
            <RefreshCw size={13} />
          </button>
          <button className="btn small icon ghost" title={tr("Închide")} aria-label={tr("Închide")} onClick={close}>
            <X size={14} />
          </button>
        </div>
        {session && <p className="muted small merge-session">{session.title}</p>}
        {!s && !error && <Loader2 size={16} className="spin" aria-label={tr("Se încarcă...")} />}
        {s && (
          <>
            <div className="merge-head mono">
              <GitBranch size={13} />
              <span className="merge-ref">{s.branch}</span>
              <span className="faint">→</span>
              <span className="merge-ref">{s.base ?? tr("niciun branch")}</span>
              <span className="merge-chip add">{tr("{n} înainte", { n: s.ahead })}</span>
              <span className={`merge-chip ${s.behind ? 'warn' : ''}`}>{tr("{n} în urmă", { n: s.behind })}</span>
              {s.merged && s.tip && <span className="merge-chip add">{tr("deja în {base}", { base })}</span>}
              <span className={`merge-chip ${s.missing || s.dirty.length ? 'warn' : ''}`}>
                {s.missing ? tr("folderul lipsește") : s.dirty.length ? tr("modificări necomise: {n}", { n: s.dirty.length }) : tr("worktree curat")}
              </span>
            </div>
            <Notes s={s} running={running} />
            <div className="row merge-actions">
              <button className="btn small primary" disabled={busy || Boolean(s.problem) || s.merged || !s.ahead} onClick={() => void check('merge')}>
                {tr("Verifică și fă merge")}
              </button>
              <button className="btn small" disabled={busy || Boolean(s.problem) || s.missing || Boolean(s.dirty.length) || !s.ahead || !s.behind} onClick={() => void check('rebase')}>
                {tr("Rebase pe {base}", { base: base || '?' })}
              </button>
              {s.pr && !s.problem && (
                <button className="btn small" disabled={busy || !s.ahead} onClick={() => setPending({ kind: 'pr', ...prDraft(session?.title ?? s.branch, s.commits) })}>
                  {tr("Creează PR")}
                </button>
              )}
              <button className="btn small danger" disabled={busy || s.problem === 'same' || Boolean(s.dirty.length)} onClick={() => setPending({ kind: 'remove' })}>
                {tr("Șterge worktree și branch")}
              </button>
              {busy && <Loader2 size={14} className="spin" />}
            </div>
            {pending && (pending.kind === 'merge' || pending.kind === 'rebase') && pending.check.conflicts.length > 0 && (
              <div className="merge-box warn" role="alert">
                <p>{tr("Fișiere în conflict: {n}. Nu s-a schimbat nimic.", { n: pending.check.conflicts.length })}</p>
                <ul className="mono merge-files">{pending.check.conflicts.map((f) => <li key={f}>{f}</li>)}</ul>
                <div className="row">
                  <button className="btn small primary" disabled={busy} onClick={() => void askModel(pending.kind as MergeAction, (pending as { check: MergeCheck }).check.conflicts)}>
                    {tr("Cere modelului să rezolve")}
                  </button>
                  <button className="btn small ghost" onClick={() => setPending(undefined)}>{tr("Anulează")}</button>
                </div>
              </div>
            )}
            {pending && (pending.kind === 'merge' || pending.kind === 'rebase') && !pending.check.conflicts.length && (
              <Confirm
                text={
                  pending.kind === 'merge'
                    ? tr("Fac merge la {branch} (commituri: {n}) în {base}, în folderul {root}, cu un commit de merge. Nu se trimite nimic pe GitHub.", { branch: s.branch, n, base, root: s.root })
                    : tr("Mut commiturile din {branch} ({n}) peste {base}, în worktree-ul {path}. Istoria branch-ului se rescrie; {base} rămâne neatins.", { branch: s.branch, n, base, path: s.path })
                }
                yes={pending.kind === 'merge' ? tr("Fă merge") : tr("Fă rebase")}
                busy={busy}
                onNo={() => setPending(undefined)}
                onYes={() =>
                  void step(async () => {
                    await api.merge.run(id, pending.kind as MergeAction, (pending as { check: MergeCheck }).check)
                    setPending(undefined)
                    setDone(pending.kind === 'merge' ? tr("Merge făcut în {base}.", { base }) : tr("Rebase făcut pe {base}.", { base }))
                  })
                }
              />
            )}
            {pending?.kind === 'pr' && (
              <div className="merge-box">
                <input className="input" value={pending.title} maxLength={250} aria-label={tr("Titlul PR-ului")} onChange={(e) => setPending({ ...pending, title: e.target.value })} />
                <textarea className="textarea" rows={5} value={pending.body} aria-label={tr("Descrierea PR-ului")} onChange={(e) => setPending({ ...pending, body: e.target.value })} />
                <Confirm
                  text={tr("Trimit branch-ul {branch} pe origin (git push) și deschid un pull request către {base}.", { branch: s.branch, base })}
                  yes={tr("Push și creează PR")}
                  busy={busy || !pending.title.trim()}
                  onNo={() => setPending(undefined)}
                  onYes={() =>
                    void step(async () => {
                      const url = await api.merge.pr(id, pending.title, pending.body)
                      setPending(undefined)
                      setDone(tr("PR deschis: {url}", { url }))
                    })
                  }
                />
              </div>
            )}
            {pending?.kind === 'remove' && (
              <div className={`merge-box ${lose ? 'warn' : ''}`}>
                {lose ? (
                  <>
                    <p>{tr("Se pierd commiturile care nu sunt în {base} ({n}):", { n, base: base || tr("branch-ul de bază") })}</p>
                    <ul className="mono merge-files">{s.commits.map((c) => <li key={c.sha}>{c.sha.slice(0, 8)} {c.subject}</li>)}</ul>
                    <p className="faint small">{tr("Ultimul commit e {sha}; o vreme îl mai poți recupera cu git branch {branch} {sha}.", { sha: s.tip.slice(0, 12), branch: s.branch })}</p>
                  </>
                ) : null}
                <Confirm
                  text={
                    s.missing
                      ? tr("Șterg branch-ul {branch}; folderul worktree-ului lipsește deja.", { branch: s.branch })
                      : tr("Șterg folderul {path} și branch-ul {branch}. Linkurile din el (de ex. node_modules) se scot doar ca linkuri; ce e la capătul lor rămâne.", { path: s.path, branch: s.branch })
                  }
                  yes={lose ? tr("Șterge și pierde commiturile") : tr("Șterge")}
                  danger
                  busy={busy}
                  onNo={() => setPending(undefined)}
                  onYes={() =>
                    void step(async () => {
                      await api.merge.remove(id, s.tip, lose)
                      close()
                      useStore.getState().toast(tr("Worktree-ul și branch-ul {branch} au fost șterse.", { branch: s.branch }))
                    })
                  }
                />
              </div>
            )}
            {done && <p className="small merge-done" role="status">{done}</p>}
          </>
        )}
        {error && <p className="small merge-error" role="alert">{error}</p>}
        {s && (
          <>
            <h3 className="label merge-h">{tr("Commituri ({n})", { n })}</h3>
            {n ? (
              <ul className="merge-commits">
                {s.commits.map((c) => (
                  <li key={c.sha} title={c.body || undefined}>
                    <span className="mono faint">{c.sha.slice(0, 8)}</span> {c.subject}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="faint small">{tr("Niciun commit nou pe branch.")}</p>
            )}
            {s.stat && (
              <>
                <h3 className="label merge-h">{tr("Fișiere")}</h3>
                <pre className="mono merge-stat">{s.stat}</pre>
              </>
            )}
            {s.diffs.length > 0 && (
              <>
                <h3 className="label merge-h">{tr("Diferențe")}</h3>
                <div className="merge-diff">
                  <DiffView diffs={s.diffs} />
                </div>
                {s.truncated && <p className="faint small">{tr("Diferențele sunt prea mari; se vede doar începutul.")}</p>}
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/** States the panel cannot act in, said plainly with what to do. */
function Notes({ s, running }: { s: MergeStatus; running: boolean }) {
  const notes = [
    s.problem === 'detached' && tr("Folderul principal nu e pe niciun branch (detached HEAD). Fă checkout pe branch-ul de bază, apoi încearcă din nou."),
    s.problem === 'same' && tr("Branch-ul {branch} e deschis chiar în folderul principal. Fă checkout pe branch-ul de bază acolo, apoi încearcă din nou.", { branch: s.branch }),
    s.problem === 'nobranch' && tr("Branch-ul {branch} nu mai există.", { branch: s.branch }),
    s.rootDirty && tr("Folderul principal are modificări necomise. Fă commit sau stash acolo, apoi încearcă din nou."),
    s.missing && tr("Folderul worktree-ului nu mai există: branch-ul se poate încă unifica sau șterge, rebase-ul nu."),
    s.dirty.length > 0 && tr("Worktree-ul are modificări necomise; nu se șterge până nu le faci commit sau le arunci: {files}", { files: s.dirty.slice(0, 6).map((l) => l.slice(3)).join(', ') }),
    s.behind > 0 && !s.problem && tr("Commituri noi în {base} de când a pornit sesiunea: {n}.", { base: s.base ?? '', n: s.behind }),
    running && tr("Sesiunea încă lucrează: commiturile ei pot să nu fie gata.")
  ].filter((x): x is string => Boolean(x))
  if (!notes.length) return null
  return (
    <ul className="merge-notes small">
      {notes.map((t) => (
        <li key={t}>{t}</li>
      ))}
    </ul>
  )
}

function Confirm({ text, yes, busy, danger, onYes, onNo }: { text: string; yes: string; busy: boolean; danger?: boolean; onYes: () => void; onNo: () => void }) {
  return (
    <div className="merge-confirm">
      <p className="small">{text}</p>
      <div className="row">
        <button className={`btn small ${danger ? 'danger' : 'primary'}`} disabled={busy} onClick={onYes} autoFocus>
          {yes}
        </button>
        <button className="btn small ghost" onClick={onNo}>
          {tr("Anulează")}
        </button>
      </div>
    </div>
  )
}
