// The in-app bug report goes to Jolty's own site, which mails it to the inbox: nothing is opened on the user's PC and no mail account is needed.
const ENDPOINT = process.env.JOLTY_BUG_URL || 'https://www.joltarise.com/api/jolty-bug'
const MIN = 15
const MAX = 1200
const MAX_FACTS = 300

export async function sendBugReport(message: unknown, facts: unknown): Promise<void> {
  if (typeof message !== 'string' || message.trim().length < MIN || message.length > MAX) throw new Error('invalid bug report')
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: message.trim(), facts: typeof facts === 'string' ? facts.slice(0, MAX_FACTS) : '' }),
    signal: AbortSignal.timeout(15_000)
  })
  if (!res.ok) throw new Error(`bug report not accepted (${res.status})`)
}
