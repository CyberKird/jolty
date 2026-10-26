// The Jolty browser as Gemini's page: a tab in the window Jolty keeps for its browser work, driven through the extension.
import { tr } from '@shared/i18n'
import { nativeBrowser } from '../jbrowser/native'
import type { Tab } from '../jbrowser/tab'
import fs from 'fs'
import path from 'path'
import { dataDir } from '../store'
import { sleep, type Catalog, type GeminiBrowser } from './gemini-web'

const catalogFile = (): string => path.join(dataDir(), 'gemini-models.json')

/** The real thing: a tab in the window Jolty keeps for its browser work, through the extension. */
export const realBrowser: GeminiBrowser = {
  connected: () => nativeBrowser.service.hub.connected,
  catalog: {
    read() {
      try {
        return JSON.parse(fs.readFileSync(catalogFile(), 'utf8')) as Catalog
      } catch {
        return undefined
      }
    },
    write(c) {
      try {
        fs.writeFileSync(catalogFile(), JSON.stringify(c))
      } catch {
        // a list that cannot be kept is just read again next time
      }
    }
  },
  async open(key, url) {
    const svc = nativeBrowser.service
    await nativeBrowser.start()
    if (!svc.hub.connected) await svc.opts.ensureBrowser?.()
    if (!svc.hub.connected) throw new Error(svc.opts.notConnected())
    const tab: Tab = await svc.openTab(key, url)
    await tab.waitLoad(25000)
    return {
      eval: <T,>(script: string) => tab.eval<T>(script),
      async upload(trigger, files) {
        const chooser = (): Tab['chooser'] => tab.chooser
        tab.chooser = undefined
        if (!(await tab.eval<boolean>(trigger))) throw new Error('no upload button')
        for (let i = 0; i < 40 && !chooser(); i++) await sleep(100)
        const open = chooser()
        if (!open) throw new Error('no file chooser')
        await tab.send('DOM.setFileInputFiles', { files, backendNodeId: open.backendNodeId })
        tab.chooser = undefined
      },
      async dispose() {
        await svc.closeTab(key, tab).catch(() => undefined)
        await svc.release(key).catch(() => undefined)
      }
    }
  }
}
