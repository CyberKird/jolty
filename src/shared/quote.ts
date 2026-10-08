// A reply's quote travels as Markdown "> " lines in front of the message, so every engine reads it.

/** a reply carries at most this much of the quoted text */
export const QUOTE_MAX = 1500

export const clipQuote = (text: string): string => (text.length > QUOTE_MAX ? `${text.slice(0, QUOTE_MAX)}…` : text)

/** The message as sent: the quote as "> " lines, a blank line, then what the user wrote. */
export function withQuote(quote: string | undefined, text: string): string {
  if (!quote) return text
  return `${clipQuote(quote).split('\n').map((l) => `> ${l}`).join('\n')}\n\n${text}`
}

/** Splits a sent message back into its quote and its own text, for drawing the quote apart. */
export function splitQuote(text: string): { quote?: string; body: string } {
  const m = /^((?:> .*(?:\n|$))+)\n?/.exec(text)
  if (!m) return { body: text }
  return { quote: m[1].split('\n').filter(Boolean).map((l) => l.slice(2)).join('\n'), body: text.slice(m[0].length) }
}
