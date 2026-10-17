// Not part of the suite: do the tools keep working when the browser window is hidden or covered?
import { startHarness } from './harness'

const h = await startHarness()
try {
  const nav = await h.call('browser_navigate', { url: h.site + '/' })
  const tab = [...(h.svc as unknown as { byId: Map<number, { windowId: number }> }).byId.values()][0]
  const ref = /button "Clicked 0" \[ref=(e\d+)\]/.exec(nav.text)![1]
  for (const state of ['minimized', 'normal']) {
    await h.hub.request('window.bounds', { windowId: tab.windowId, state })
    await new Promise((r) => setTimeout(r, 800))
    const t0 = Date.now()
    const shot = await h.call('browser_take_screenshot')
    const click = await h.call('browser_click', { ref })
    const snap = await h.call('browser_snapshot')
    console.log(state, '| screenshot', shot.isError ? 'ERR ' + shot.text.slice(0, 80) : shot.images + ' image', '| click', click.isError ? 'ERR ' + click.text.slice(0, 100) : 'ok', '| snapshot', snap.isError ? 'ERR' : /Clicked \d/.exec(snap.text)?.[0], '|', Date.now() - t0, 'ms')
  }
} finally {
  await h.stop()
}
