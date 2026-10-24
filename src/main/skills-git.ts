// Git for the skills inventory. Local repo facts are read straight from .git (fast, no process per skill); anything
// that talks to a remote goes through execFile('git') with prompts, credential helpers, hooks and fsmonitor off.
import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

export interface LocalRepo {
  top: string
  url?: string
  branch?: string
  commit?: string
}

const GIT_TIMEOUT = 15_000

const read = (f: string): string | undefined => {
  try {
    return fs.readFileSync(f, 'utf8')
  } catch {
    return undefined
  }
}

function resolveRef(gitDir: string, common: string, ref: string): string | undefined {
  for (const d of [gitDir, common]) {
    const v = read(path.join(d, ref))?.trim()
    if (v) return v
  }
  const packed = read(path.join(common, 'packed-refs'))
  return packed?.split('\n').find((l) => l.endsWith(` ${ref}`))?.split(' ')[0]
}

function originUrl(config: string): string | undefined {
  let remote: string | undefined
  const urls: Record<string, string> = {}
  for (const line of config.replace(/\r/g, '').split('\n')) {
    const sec = /^\s*\[remote\s+"([^"]+)"\]/.exec(line)
    if (sec) remote = sec[1]
    else if (/^\s*\[/.test(line)) remote = undefined
    else if (remote && !urls[remote]) {
      const m = /^\s*url\s*=\s*(.+?)\s*$/.exec(line)
      if (m) urls[remote] = m[1]
    }
  }
  return urls.origin ?? Object.values(urls)[0]
}

const repoCache = new Map<string, LocalRepo | null>()

/** The git repo a folder sits in (itself or a parent), read from disk. Cached until clearRepoCache. */
export function localRepo(dir: string): LocalRepo | undefined {
  const hit = repoCache.get(dir)
  if (hit !== undefined) return hit ?? undefined
  let found: LocalRepo | null = null
  const dotGit = path.join(dir, '.git')
  let gitDir: string | undefined
  try {
    const st = fs.statSync(dotGit)
    if (st.isDirectory()) gitDir = dotGit
    else {
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(read(dotGit) ?? '')
      if (m) gitDir = path.resolve(dir, m[1])
    }
  } catch {
    /* no .git here */
  }
  const head = gitDir ? read(path.join(gitDir, 'HEAD'))?.trim() : undefined
  if (gitDir && head) {
    const commonRel = read(path.join(gitDir, 'commondir'))?.trim()
    const common = commonRel ? path.resolve(gitDir, commonRel) : gitDir
    const ref = /^ref:\s*(.+)$/.exec(head)?.[1]
    found = {
      top: dir,
      url: originUrl(read(path.join(common, 'config')) ?? ''),
      branch: ref?.replace(/^refs\/heads\//, ''),
      commit: ref ? resolveRef(gitDir, common, ref) : head
    }
  } else {
    const parent = path.dirname(dir)
    found = parent !== dir ? (localRepo(parent) ?? null) : null
  }
  repoCache.set(dir, found)
  return found ?? undefined
}

export const clearRepoCache = (): void => repoCache.clear()

const NO_HOOKS = path.join(os.tmpdir(), 'jolty-no-git-hooks')

/** Runs git with no shell, no prompt, no credential helper, no hooks. Rejects with Error('git-timeout' | stderr). */
export function git(args: string[], cwd?: string, timeout = GIT_TIMEOUT): Promise<string> {
  const safe = ['-c', 'credential.helper=', '-c', 'core.askPass=', '-c', `core.hooksPath=${NO_HOOKS}`, '-c', 'core.fsmonitor=false', '-c', `protocol.file.allow=${process.env.JOLTY_TEST ? 'always' : 'never'}`]
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes', LC_ALL: 'C' }
  return new Promise((resolve, reject) => {
    execFile('git', [...safe, ...args], { cwd, env, timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((err as { killed?: boolean }).killed ? 'git-timeout' : String(stderr || err.message).trim().slice(0, 500)))
      else resolve(stdout)
    })
  })
}

/** The commit the remote has for ref (or its default branch). */
export async function lsRemote(url: string, ref?: string): Promise<string> {
  const out = await git(['ls-remote', '--', url, ref ?? 'HEAD'])
  const lines = out.split('\n').filter(Boolean).map((l) => l.split('\t'))
  const hit = ref ? (lines.find((l) => l[1] === `refs/heads/${ref}`) ?? lines.find((l) => l[1] === `refs/tags/${ref}^{}`) ?? lines[0]) : lines[0]
  if (!hit?.[0]) throw new Error('ref-not-found')
  return hit[0]
}

/** A shallow clone in a new temp folder; the caller removes `root` when done. blobless = trees only, for comparing folders. */
export async function shallowClone(url: string, ref: string | undefined, blobless = false): Promise<{ root: string; repo: string; commit: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jolty-skill-'))
  const repo = path.join(root, 'repo')
  try {
    await git(['clone', '--depth', '1', '--single-branch', ...(blobless ? ['--filter=blob:none', '--no-checkout'] : []), ...(ref ? ['--branch', ref] : []), '--', url, repo], undefined, 120_000)
    const commit = (await git(['rev-parse', 'HEAD'], repo)).trim()
    return { root, repo, commit }
  } catch (e) {
    fs.rmSync(root, { recursive: true, force: true })
    throw e
  }
}

/** The tree id of a subfolder at HEAD of a clone (same value GitHub's tree API and the skills lock file use). */
export async function treeOf(repo: string, subdir?: string): Promise<string | undefined> {
  try {
    return (await git(['rev-parse', `HEAD:${subdir ?? ''}`], repo)).trim() || undefined
  } catch {
    return undefined
  }
}

/** Uncommitted changes under dir in its repo. */
export async function isDirty(dir: string): Promise<boolean> {
  return (await git(['status', '--porcelain', '--', '.'], dir)).trim().length > 0
}
