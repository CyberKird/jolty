import { startHarness } from './harness'

const h = await startHarness()
try {
  console.log('connected, extension:', h.hub.extension)
  const t0 = Date.now()
  const r = await h.call('browser_navigate', { url: h.site + '/' })
  console.log(r.isError, Date.now() - t0, 'ms\n' + r.text)
} finally {
  await h.stop()
}
