// What a conversation carries when it moves to another provider. The new model starts with no
// context, so it gets a compact brief instead of the whole history: the original request, the
// latest exchanges within a fixed budget, the files already changed and the git state. That keeps
// a switch to a few thousand tokens instead of the full transcript plus a re-read of the project.
import type { ChatItem } from '@shared/types'

/** characters of recent conversation carried over (about 3-4k tokens) */
export const TEXT_BUDGET = 12000
/** one long answer may not crowd out the rest: its end is kept, where conclusions usually are */
const PER_ANSWER = 1500
const PER_REQUEST = 4000
const GIT_BUDGET = 3000

export { sameProvider } from '@shared/provider'

const head = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s)
const tail = (s: string, n: number): string => (s.length > n ? `…${s.slice(-n)}` : s)

/** The latest exchanges that fit the budget, the first request, and every file an edit touched. */
export function digest(items: ChatItem[]): { first?: string; recent: string; dropped: number; files: string[] } {
  const files = new Set<string>()
  const turns: string[] = []
  for (const it of items) {
    if (it.kind === 'user' && it.text.trim()) turns.push(`[User]\n${head(it.text.trim(), PER_REQUEST)}`)
    else if (it.kind === 'assistant' && it.text.trim()) turns.push(`[Assistant]\n${tail(it.text.trim(), PER_ANSWER)}`)
    else if (it.kind === 'tool' && it.status !== 'error') for (const d of it.diffs || []) files.add(d.path)
  }
  const kept: string[] = []
  let size = 0
  for (let i = turns.length - 1; i >= 0; i--) {
    if (size + turns[i].length > TEXT_BUDGET && kept.length) break
    kept.unshift(turns[i])
    size += turns[i].length
  }
  const dropped = turns.length - kept.length
  const firstUser = items.find((x) => x.kind === 'user' && x.text.trim())
  const first = dropped && firstUser && firstUser.kind === 'user' ? head(firstUser.text.trim(), PER_ANSWER) : undefined
  return { first, recent: kept.join('\n\n'), dropped, files: [...files] }
}

export interface HandoffSource {
  /** "Claude Code", "Codex"... */
  engine: string
  profile?: string
  cwd: string
}

/** The text the new engine receives, ahead of the user's next message when there is one. */
export function handoffPrompt(src: HandoffSource, items: ChatItem[], git: string, opts: { next?: string; graph?: boolean } = {}): string {
  const d = digest(items)
  return [
    `You are taking over a conversation started in ${src.engine}${src.profile ? ` (profile "${src.profile}")` : ''}, in the same project: ${src.cwd}`,
    'Below is a compact brief, not the whole history: the original request, the latest messages, the files already changed and the git state.',
    '',
    ...(d.first ? ['Original request:', '<request>', d.first, '</request>', ''] : []),
    `Latest messages${d.dropped ? ` (${d.dropped} older ones left out)` : ''}:`,
    '<conversation>',
    d.recent || '(empty)',
    '</conversation>',
    '',
    ...(d.files.length ? ['Files changed in the conversation:', ...d.files.slice(0, 40).map((f) => `- ${f}`), ''] : []),
    'Current git state:',
    '<git>',
    head(git, GIT_BUDGET) || '(not a git repository, or no changes)',
    '</git>',
    '',
    ...(opts.graph ? ['The project has a code map in graphify-out/GRAPH_REPORT.md: when you need its structure, read that instead of searching the whole codebase.', ''] : []),
    'Do not re-read files just to get oriented: open them only when you need them for what comes next. Do not redo work already done.',
    ...(opts.next
      ? ['Answer the message below, in the language it is written in.', '', '<message>', opts.next, '</message>']
      : ['Continue where the conversation left off. First say briefly what you understand comes next.'])
  ].join('\n')
}

/** Rough token count of a prompt, for telling the user what a switch costs. */
export const roughTokens = (text: string): number => Math.ceil(text.length / 3.5)
