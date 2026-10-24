// "Improve prompt": the composer text goes once to the model picked in the composer and comes back as a better prompt; these two are the pure parts.

/** the text is sent to the model whole up to this many characters */
export const IMPROVE_MAX = 8000

/** The instruction for the model. English on purpose (for the model, not the user): the reply keeps the message's own language. */
export function improvePrompt(text: string, project?: string): string {
  return `You are a prompt engineer. A user is about to send the message below to an AI coding agent${project ? ` working in the project folder "${project}"` : ''}. Rewrite it into a better prompt for that agent: one that gets the job done right on the first try.
Do not answer it, do not summarize it, do not give it a title. Return the improved prompt itself.
How:
- State the goal plainly, then what has to happen, as short steps or bullets when there is more than one thing to do.
- Spell out what the user clearly expects but left implicit: what "done" means, what to check or test, what must not break or change. Only what follows from the message; never invent requirements, files, names, numbers or facts.
- Where the message is vague and the agent would have to guess, tell the agent to look it up in the code or to ask, instead of guessing.
- Keep file names, paths, commands, code, URLs, @mentions, /commands and quoted text exactly as written.
- Same language and same voice as the user (first person, addressed to the agent). Fix spelling and grammar.
- It must never come out shorter or vaguer than the original. A one-line message becomes a few clear lines, not an essay.
Reply with the improved prompt only: no preface, no explanation, no quotation marks around it.

Message:
${text.slice(0, IMPROVE_MAX)}`
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
