// Not part of the suite (needs a visible Chromium: JBROWSER_HEADFUL=1): does the Live panel's picture keep coming
// while the browser window is minimized, as it does when it is behind Jolty or another app?
import { spawn } from 'node:child_process'
import { startHarness } from './harness'

const h = await startHarness()
try {
  await h.call('browser_navigate', { url: h.site + '/ticker' })
  const tab = [...(h.svc as unknown as { byId: Map<number, { windowId: number }> }).byId.values()][0]
  for (const state of ['normal', 'minimized', 'normal', 'covered']) {
    let cover: ReturnType<typeof spawn> | undefined
    if (state === 'covered') {
      // an opaque window over the whole screen: the browser window is occluded, not minimized
      cover = spawn('powershell', ['-NoProfile', '-Command', 'Add-Type -AssemblyName System.Windows.Forms; $f=New-Object Windows.Forms.Form; $f.FormBorderStyle="None"; $f.WindowState="Maximized"; $f.TopMost=$true; $f.BackColor="Black"; $f.Show(); $t=[DateTime]::Now.AddSeconds(9); while([DateTime]::Now -lt $t){[Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 50}; $f.Close()'], { stdio: 'ignore' })
      await new Promise((r) => setTimeout(r, 2500))
    } else await h.hub.request('window.bounds', { windowId: tab.windowId, state })
    await new Promise((r) => setTimeout(r, 1000))
    const frames: string[] = []
    h.svc.setLive((f) => f.frame && frames.push(f.frame.length + ':' + f.frame.slice(-12)))
    await new Promise((r) => setTimeout(r, 4000))
    h.svc.setLive(undefined)
    cover?.kill()
    console.log(state, '| frames in 4 s:', frames.length, '| different:', new Set(frames).size)
  }
  // a page that does not change sends no screencast frames: the picture still refreshes (a window that stopped
  // painting looks the same to the screencast)
  await h.call('browser_navigate', { url: h.site + '/' })
  await new Promise((r) => setTimeout(r, 1500))
  const still: number[] = []
  h.svc.setLive((f) => f.frame && still.push(Date.now()))
  await new Promise((r) => setTimeout(r, 9000))
  h.svc.setLive(undefined)
  const late = still.filter((t) => t > still[0] + 2500).length
  console.log('static page | frames in 9 s:', still.length, '| after the first 2.5 s:', late)
} finally {
  await h.stop()
}
