// The skills inventory and update checks. Contract: src/shared/skills.ts. Backends answer with Error codes
// (skill-not-found, bad-source, managed-by-plugin ...), the page words them.
import fs from 'fs'
import { shell } from 'electron'
import type { SkillInfo, SkillSource } from '@shared/skills'
import { writeSource } from './skill-fs'
import { lsRemote, shallowClone, treeOf } from './skills-git'
import { validCommit, validGitUrl, validRef, validSubdir } from './skills-parse'
import { currentRev, readState, scan, treeMode, writeState, type CheckState, type Entry } from './skills-scan'
import { updateEntry } from './skills-update'

const CHECK_CONCURRENCY = 4

const infos = (all: Entry[]): SkillInfo[] => all.map((e) => e.info)

async function find(id: string): Promise<{ e: Entry; all: Entry[] }> {
  const all = await scan()
  const e = all.find((x) => x.info.id === id)
  if (!e) throw new Error('skill-not-found')
  return { e, all }
}

/** Every skill found, offline, with the status the last check left behind. */
export async function list(): Promise<SkillInfo[]> {
  return infos(await scan())
}

/** What the remote has now: its tree id for a folder compared by tree, else the commit of the branch. */
async function remoteRev(e: Entry, st: CheckState | undefined): Promise<string> {
  const src = e.info.source
  if (src.kind !== 'git') throw new Error('no-source')
  if (treeMode(e, st)) {
    const clone = await shallowClone(src.url, src.ref, true)
    try {
      const tree = await treeOf(clone.repo, src.subdir)
      if (!tree) throw new Error('ref-not-found')
      return tree
    } finally {
      fs.rmSync(clone.root, { recursive: true, force: true })
    }
  }
  return lsRemote(src.url, src.ref ?? e.repo?.branch)
}

/** Asks the sources whether something newer exists (all skills with a git source, or just ids). Returns the full list. */
export async function check(ids?: string[]): Promise<SkillInfo[]> {
  const all = await scan()
  const seen = new Set<string>()
  const work = all.filter((e) => {
    const src = e.info.source
    if (!e.real || seen.has(e.real) || src.kind !== 'git' || e.info.status === 'broken') return false
    if (!validGitUrl(src.url, true) || (src.ref !== undefined && !validRef(src.ref)) || (src.subdir !== undefined && !validSubdir(src.subdir))) return false
    // the mirrors of one folder share its check, so one of them being asked for is enough
    if (ids && !all.some((o) => o.real === e.real && ids.includes(o.info.id))) return false
    seen.add(e.real)
    return true
  })
  const state = readState()
  let i = 0
  await Promise.all(
    Array.from({ length: CHECK_CONCURRENCY }, async () => {
      while (i < work.length) {
        const e = work[i++]
        const st = state[e.real!]
        try {
          const latest = await remoteRev(e, st)
          const current = currentRev(e, st)
          // offline or a missing ref throws above and leaves the last result as it was
          state[e.real!] = { ...st, latest, against: current, checkedAt: Date.now(), status: !current ? 'unknown' : current === latest ? 'ok' : 'outdated' }
        } catch {
          /* one unreachable source must not hide the others */
        }
      }
    })
  )
  writeState(state)
  return infos(await scan())
}

/** Brings the skill up to date from its source; the folder it replaces is kept under skill-backups. */
export async function update(id: string): Promise<SkillInfo> {
  const { e, all } = await find(id)
  await updateEntry(e, all)
  return (await find(id)).e.info
}

/** Tells Jolty where a skill came from. Only plain https git sources (or local) can be set from the page. */
export async function setSource(id: string, source: SkillSource): Promise<SkillInfo> {
  await find(id)
  const s = source as unknown as Record<string, unknown>
  if (s?.kind === 'local') writeSource(id, { kind: 'local' })
  else if (s?.kind === 'git') {
    const { url, ref, subdir, commit } = s
    if (!validGitUrl(url) || (ref !== undefined && !validRef(ref)) || (subdir !== undefined && !validSubdir(subdir)) || (commit !== undefined && !validCommit(commit))) throw new Error('bad-source')
    writeSource(id, { kind: 'git', url, ...(ref ? { ref } : {}), ...(subdir ? { subdir } : {}), ...(commit ? { commit } : {}) })
  } else throw new Error('bad-source')
  return (await find(id)).e.info
}

export async function reveal(id: string): Promise<void> {
  const { e } = await find(id)
  if (e.real) {
    const err = await shell.openPath(e.real)
    if (err) throw new Error(err)
  } else shell.showItemInFolder(e.info.dir)
}
