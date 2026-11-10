// GitHub for the folder a chat works in, through the user's own `gh`: their login, nothing stored by Jolty.
// A pull request of the current branch with its checks, the open issues, and GitHub's own auto-merge.
import { execFile } from 'child_process'
import fs from 'fs'
import { tr } from '@shared/i18n'
import type { GithubCheck, GithubIssue, GithubOverview, GithubPr } from '@shared/types'

interface Run {
  code: number
  out: string
  err: string
}

function run(cwd: string, args: string[]): Promise<Run> {
  if (!fs.existsSync(cwd)) return Promise.reject(new Error(tr("Folderul {path} nu mai există.", { path: cwd })))
  // a test points JOLTY_GH at a script: a .cmd cannot be started without a shell, so a script runs on the app's own node
  const stub = process.env.JOLTY_GH
  const script = stub?.endsWith('.js')
  const cmd = script ? process.execPath : stub || 'gh'
  const argv = script ? [stub as string, ...args] : args
  const env = script ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env
  return new Promise((resolve, reject) => {
    execFile(cmd, argv, { cwd, env, timeout: 30000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out, errOut) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return reject(new Error('no-gh'))
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(out), err: String(errOut || '').trim() })
    })
  })
}

// ------------------------------------------------------------------ reading what gh prints
type Raw = Record<string, unknown>
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** A check run reports status + conclusion, an old-style status reports one state: both become pass, fail, pending or skipped. */
export function checkOf(raw: Raw): GithubCheck {
  const name = str(raw.name) || str(raw.context) || '?'
  const result = (str(raw.conclusion) || str(raw.state) || str(raw.status)).toUpperCase()
  if (['SUCCESS', 'NEUTRAL'].includes(result)) return { name, state: 'pass' }
  if (['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(result)) return { name, state: 'fail' }
  if (result === 'SKIPPED') return { name, state: 'skipped' }
  return { name, state: 'pending' }
}

export function prOf(raw: Raw): GithubPr {
  const state = str(raw.state).toUpperCase()
  return {
    number: Number(raw.number),
    title: str(raw.title),
    url: str(raw.url),
    draft: raw.isDraft === true,
    state: state === 'MERGED' || state === 'CLOSED' ? state : 'OPEN',
    checks: (Array.isArray(raw.statusCheckRollup) ? raw.statusCheckRollup : []).map((c) => checkOf(c as Raw)),
    autoMerge: Boolean(raw.autoMergeRequest)
  }
}

export function issuesOf(raw: unknown): GithubIssue[] {
  return (Array.isArray(raw) ? raw : []).map((i: Raw) => ({
    number: Number(i.number),
    title: str(i.title),
    labels: (Array.isArray(i.labels) ? i.labels : []).map((l: Raw) => str(l.name)).filter(Boolean),
    author: str((i.author as Raw | undefined)?.login)
  }))
}

const ISSUE_MAX = 20000

/** An issue as the text that goes into the message: title, link, labels, body and the conversation under it. */
export function issueText(raw: Raw): string {
  const labels = (Array.isArray(raw.labels) ? raw.labels : []).map((l: Raw) => str(l.name)).filter(Boolean)
  const comments = (Array.isArray(raw.comments) ? raw.comments : []).map((c: Raw) => `- ${str((c.author as Raw | undefined)?.login) || '?'}: ${str(c.body).trim()}`)
  const text = [`GitHub issue #${raw.number}: ${str(raw.title)}`, str(raw.url), labels.length ? `Labels: ${labels.join(', ')}` : '', '', str(raw.body).trim(), comments.length ? `\nComments:\n${comments.join('\n')}` : '']
    .filter((l, i) => l || i === 3)
    .join('\n')
  return text.length > ISSUE_MAX ? `${text.slice(0, ISSUE_MAX)}…` : text
}

// ------------------------------------------------------------------ what the app asks for
const cache = new Map<string, { at: number; value: GithubOverview }>()
const FRESH = 30_000

function off(reason: 'no-gh' | 'no-repo' | 'no-auth'): GithubOverview {
  return { kind: 'off', reason }
}

export async function overview(cwd: string, force = false): Promise<GithubOverview> {
  const hit = cache.get(cwd)
  if (!force && hit && Date.now() - hit.at < FRESH) return hit.value
  let value: GithubOverview
  try {
    const repo = await run(cwd, ['repo', 'view', '--json', 'nameWithOwner'])
    if (repo.code) value = off(/auth login|not logged in|GH_TOKEN/i.test(repo.err) ? 'no-auth' : 'no-repo')
    else {
      const [pr, issues] = await Promise.all([
        run(cwd, ['pr', 'view', '--json', 'number,title,url,state,isDraft,statusCheckRollup,autoMergeRequest']),
        run(cwd, ['issue', 'list', '--state', 'open', '--limit', '30', '--json', 'number,title,labels,author'])
      ])
      value = {
        kind: 'ok',
        repo: str((JSON.parse(repo.out) as Raw).nameWithOwner),
        pr: pr.code ? undefined : prOf(JSON.parse(pr.out) as Raw),
        issues: issues.code ? [] : issuesOf(JSON.parse(issues.out))
      }
    }
  } catch (err) {
    if ((err as Error).message !== 'no-gh') console.error('[github]', (err as Error).message)
    value = off('no-gh')
  }
  cache.set(cwd, { at: Date.now(), value })
  return value
}

function wholeNumber(n: unknown): number {
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 10_000_000) throw new Error(tr("Număr de issue invalid."))
  return n
}

export async function issue(cwd: string, n: unknown): Promise<string> {
  const r = await run(cwd, ['issue', 'view', String(wholeNumber(n)), '--json', 'number,title,body,labels,url,comments']).catch(() => {
    throw new Error(tr("GitHub CLI (gh) nu e instalat sau nu e în PATH."))
  })
  if (r.code) throw new Error(r.err || tr("Nu am putut citi issue-ul."))
  return issueText(JSON.parse(r.out) as Raw)
}

/** GitHub merges the pull request (squash) once its checks pass; off takes the request back. */
export async function autoMerge(cwd: string, on: boolean): Promise<void> {
  const r = await run(cwd, ['pr', 'merge', on ? '--auto' : '--disable-auto', ...(on ? ['--squash'] : [])]).catch(() => {
    throw new Error(tr("GitHub CLI (gh) nu e instalat sau nu e în PATH."))
  })
  cache.delete(cwd)
  if (r.code) throw new Error(r.err || tr("GitHub nu a acceptat cererea."))
}
