// "Improve prompt": the composer text goes to a cheap model once and comes back clearer; these two are the pure parts.

/** the text is sent to the model whole up to this many characters */
export const IMPROVE_MAX = 8000

/** The instruction for the model. English on purpose (for the model, not the user): the reply keeps the message's own language. */
export function improvePrompt(text: string): string {
  return `Rewrite the message below, which a user is about to send to an AI coding assistant, so it is clearer and more complete.
Rules:
- Reply in the same language as the message.
- Keep the same intent. Do not invent requirements, files, names or details that are not in the message.
- Keep file names, paths, commands, code, URLs, @mentions, /commands and quoted text exactly as written.
- Fix spelling and grammar, remove filler, put the steps or the conditions in order. A short message stays short.
- Reply with the rewritten message only: no explanation, no title, no quotation marks around it.

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
