// Not part of the automated suite: runs the tools on real websites to look at snapshot quality and speed.
import { startHarness } from './harness'

const h = await startHarness()
try {
  for (const url of ['https://example.com', 'https://en.wikipedia.org/wiki/Electron_(software)', 'https://github.com/microsoft/vscode', 'https://news.ycombinator.com', 'https://www.google.com']) {
    const t0 = Date.now()
    const r = await h.call('browser_navigate', { url })
    const ms = Date.now() - t0
    const body = r.text
    console.log(`\n===== ${url}: ${ms} ms, ${body.length} chars, error=${r.isError}`)
    console.log(body.slice(0, process.env.FULL ? 6000 : 1400))
  }
} finally {
  await h.stop()
}
