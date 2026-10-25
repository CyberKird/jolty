// "Improve prompt": the composer text goes once to a cheap model and comes back as a better prompt; these are the pure parts.

/** the text is sent to the model whole up to this many characters */
export const IMPROVE_MAX = 8000

/** What the model may read to understand the message: never copied, never a source of requirements. */
export interface ImproveContext {
  /** the user's last messages in this conversation, oldest first, already clipped */
  recent?: string[]
  /** titles of the latest conversations in the same folder */
  titles?: string[]
  /** the interface language's English name: the language of a message too short to tell */
  language?: string
}

/** Cuts a message to what is enough to recognise the subject. */
export const clipForContext = (text: string, max = 300): string => {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max) + '…' : t
}

/** The instruction for the model. English on purpose (for the model, not the user): the reply keeps the message's own language. */
export function improvePrompt(text: string, context: ImproveContext = {}): string {
  const lines: string[] = []
  if (context.recent?.length) lines.push('Recent messages of this conversation:', ...context.recent.map((m) => `- ${m}`))
  if (context.titles?.length) lines.push('Earlier conversations in the same folder:', ...context.titles.map((t) => `- ${t}`))
  return `Rewrite the message below, which the user will send to an AI assistant that can read files, run code and use tools, into a clearer prompt that works on the first try. Do not answer, summarize or title it. Reply with the improved prompt only: no preface, no quotes.
- Goal first, then what must happen, as short steps if there are several.
- Add what the user clearly expects but left unsaid (what "done" means, what to check, what must not break). Never invent requirements, files, names, numbers or facts.
- Where it is vague, tell the assistant to look it up or ask, not to guess.
- Keep file names, paths, commands, code, URLs, @mentions, /commands and quoted text exactly as written.
- Same language and voice as the user${context.language ? ` (if the message is too short to tell, use ${context.language})` : ''}. Fix spelling. Never shorter or vaguer than the original.
- The work can be anything (an app, a company task, code, text, data): take the field only from the message and the context, never assume a kind of project.
- If you cannot tell what the message is about even with the context, reply only: QUESTION: <one short question, in the user's language>.${lines.length ? `\n\nContext, only to understand the message (never copy it or take requirements from it):\n${lines.join('\n')}` : ''}

Message:
${text.slice(0, IMPROVE_MAX)}`
}

/** The model asked for what it needs instead of rewriting: the question, or undefined when the reply is a rewrite. */
export function improveQuestion(reply: string): string | undefined {
  const m = /^\s*QUESTION:\s*(.+)\s*$/.exec(reply.trim())
  return m && !m[1].includes('\n') && m[1].length <= 240 ? m[1].trim() : undefined
}

/**
 * The model's reply as the new message text, or undefined when it cannot be trusted:
 * empty, or much shorter than what the user wrote (the model answered instead of rewriting, or dropped half of it).
 */
export function cleanImproved(original: string, reply: string): string | undefined {
  let t = reply.trim()
  const fenced = /^```[\w-]*\n([\s\S]*?)\n```$/.exec(t)
  if (fenced) t = fenced[1].trim()
  // a lead-in line the model adds out of habit
  t = t.replace(/^(?:here(?:'s| is)[^\n]*|improved (?:prompt|message|version)[^\n]*|rewritten[^\n]*):\s*\n+/i, '')
  // quotes around the whole message (the original has none at both ends)
  const pairs: [string, string][] = [['"', '"'], ["'", "'"], ['“', '”'], ['„', '”'], ['«', '»'], ['`', '`']]
  for (const [open, close] of pairs) {
    if (t.length > 1 && t.startsWith(open) && t.endsWith(close) && !(original.trim().startsWith(open) && original.trim().endsWith(close))) {
      t = t.slice(open.length, t.length - close.length).trim()
      break
    }
  }
  if (!t) return undefined
  if (original.trim().length >= 20 && t.length < original.trim().length * 0.5) return undefined
  return t
}
