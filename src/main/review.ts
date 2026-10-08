// "Verifică cu alt model": the current changes go to a model from another family for a read-only
// review. A different family misses different things, which is the point of having several
// providers. The reviewer gets the diff only, in one turn, with no tools.
import { execFile } from 'child_process'
import fs from 'fs'
import path from 'path'
import type { ChatItem, EngineKind, Profile } from '@shared/types'

/** the diff a reviewer reads, in characters (about 15k tokens) */
const DIFF_BUDGET = 50000

/** The other family for a conversation: Codex reviews Claude's work and the other way round. */
export function reviewerFor(engine: EngineKind, profiles: Profile[]): Profile | undefined {
  const codex = profiles.find((p) => p.engine === 'codex')
  const claude = profiles.find((p) => p.engine === 'claude' && p.auth !== 'endpoint')
  return engine === 'codex' ? claude : codex || (engine !== 'claude' ? claude : undefined)
}

/** Uncommitted changes against HEAD plus new files, or '' outside a git repository. Reads only: the index is left alone. */
export async function gitDiff(cwd: string): Promise<string> {
  const run = (args: string[]): Promise<string> =>
    new Promise((resolve) => execFile('git', args, { cwd, timeout: 10000, windowsHide: true, maxBuffer: 20 * 1024 * 1024 }, (err, out) => resolve(err ? '' : String(out))))
  const [diff, untracked] = await Promise.all([run(['diff', 'HEAD', '--no-color']), run(['ls-files', '--others', '--exclude-standard'])])
  const added: string[] = []
  for (const rel of untracked.split('\n').filter(Boolean).slice(0, 30)) {
    try {
      const file = path.join(cwd, rel)
      if (fs.statSync(file).size > 200_000) continue
      added.push(`--- /dev/null\n+++ ${rel} (fișier nou)\n${fs.readFileSync(file, 'utf8').split('\n').map((l) => `+${l}`).join('\n')}`)
    } catch {
      // unreadable or gone: the reviewer simply does not see it
    }
  }
  return [diff, ...added].filter(Boolean).join('\n')
}

/** The diffs Jolty saw in this conversation, for a project that is not a git repository. */
export function transcriptDiff(items: ChatItem[]): string {
  return items
    .flatMap((it) => (it.kind === 'tool' && it.status !== 'error' ? it.diffs || [] : []))
    .map((d) => `--- ${d.path}\n${d.diff}`)
    .join('\n')
}

export function reviewPrompt(diff: string): string {
  const cut = diff.length > DIFF_BUDGET ? `${diff.slice(0, DIFF_BUDGET)}\n...(diff scurtat)` : diff
  return [
    'Fă code review pe modificările de mai jos, scrise de alt model.',
    'Caută doar probleme reale: bug-uri, cazuri limită netratate, securitate, date pierdute, regresii. Fără stil, fără laude, fără sugestii de gust.',
    'Pentru fiecare: fișier:linie, ce se strică și în ce situație concretă, apoi reparația în una-două fraze. Cel mult 8, cele mai grave primele.',
    'Dacă nu găsești nimic serios, spune asta într-o singură propoziție.',
    'Scrie în română. Nu folosi linia lungă (em dash) ca punctuație.',
    '',
    '<diff>',
    cut,
    '</diff>'
  ].join('\n')
}
