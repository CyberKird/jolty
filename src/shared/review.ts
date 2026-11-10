// Review comments on a diff: which line each one belongs to and the message that carries them all to the model.

export interface ReviewComment {
  id: string
  /** where it was written: the diff's position in its file and the line's position in the diff, so it stays put while the diff grows */
  at: string
  path: string
  /** line number in the new file, when the diff has hunk headers; the diffs of the agents' edits are plain -/+ lines and have none */
  line?: number
  /** the line's own mark in the diff: added, removed or unchanged */
  mark: '+' | '-' | ' '
  code: string
  text: string
}

/** The new-file line number of every line of a unified diff; undefined for hunk headers, removed lines and diffs without headers. */
export function lineNumbers(diff: string): (number | undefined)[] {
  const out: (number | undefined)[] = []
  let next: number | undefined
  for (const line of diff.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line)
    if (hunk) {
      next = Number(hunk[1])
      out.push(undefined)
    } else if (next === undefined || line.startsWith('-') || line.startsWith('---')) {
      out.push(undefined)
    } else {
      out.push(next++)
    }
  }
  return out
}

export const markOf = (line: string): ReviewComment['mark'] => (line.startsWith('+') ? '+' : line.startsWith('-') ? '-' : ' ')

/** One message with every comment, grouped by file in the order they were written. The quoted line says what the comment is about. */
export function reviewMessage(comments: ReviewComment[], heading: string): string {
  const byPath = new Map<string, ReviewComment[]>()
  for (const c of comments) byPath.set(c.path, [...(byPath.get(c.path) || []), c])
  const blocks = [...byPath].map(([path, list]) =>
    list.map((c) => `${path}${c.line ? `:${c.line}` : ''}\n> ${c.mark === ' ' ? '' : c.mark}${c.code.replace(/^[-+ ]/, '').trimEnd()}\n${c.text.trim()}`).join('\n\n')
  )
  return `${heading}\n\n${blocks.join('\n\n')}`
}
