// Not part of the suite: saves screenshots of what the user sees while a model works (overlay, cursor).
import fs from 'node:fs'
import { startHarness } from './harness'

const h = await startHarness()
try {
  const nav = await h.call('browser_navigate', { url: h.site + '/form' })
  const snap = nav.text
  const ref = (re: RegExp): string => /\[ref=(e\d+)\]/.exec(snap.split('\n').find((l) => re.test(l))!)![1]
  // start the click but grab the picture while the cursor is on its way
  const click = h.call('browser_click', { ref: ref(/button "Send"/) })
  await new Promise((r) => setTimeout(r, 180))
  const shot = await h.call('browser_take_screenshot', { type: 'png' })
  await click
  const raw = await h.rpc('chat1', { jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'browser_take_screenshot', arguments: { type: 'png' } } })
  const j = (await raw.json()) as { result: { content: { type: string; data?: string }[] } }
  const img = j.result.content.find((c) => c.type === 'image')!
  fs.writeFileSync(process.argv[2] || 'overlay.png', Buffer.from(img.data!, 'base64'))
  console.log('saved', shot.images)
} finally {
  await h.stop()
}
