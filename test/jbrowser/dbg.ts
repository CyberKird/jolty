import { startHarness } from './harness'

const h = await startHarness()
const ms = (p: Promise<unknown>, t = 4000): Promise<string> =>
  Promise.race([p.then((r) => 'ok ' + JSON.stringify(r).slice(0, 60)), new Promise<string>((r) => setTimeout(() => r('TIMEOUT'), t))]).catch((e) => 'ERR ' + e.message)
try {
  const url = `http://127.0.0.1:${h.hub.port}/jolty-blank`
  const tab = (await h.hub.request('tabs.create', { url, newWindow: true })) as { id: number }
  console.log('created', JSON.stringify(tab))
  console.log('attach', await ms(h.hub.request('debugger.attach', { tabId: tab.id })))
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    const info = (await h.hub.request('tabs.get', { tabId: tab.id })) as { status: string; url: string }
    console.log(`t+${i + 1}s status=${info.status} url=${info.url} eval:`, await ms(h.hub.cdp(tab.id, 'Runtime.evaluate', { expression: 'location.href' }), 2500))
  }
  console.log('Page.enable', await ms(h.hub.cdp(tab.id, 'Page.enable')))
} finally {
  await h.stop()
}
