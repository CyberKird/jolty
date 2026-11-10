import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { createApi } from '@shared/api-factory'

// Main-process errors arrive as "Error invoking remote method 'x': Error: message"; keep the message.
async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return (await ipcRenderer.invoke(channel, ...args)) as T
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
  }
}

const api = createApi(
  call,
  (channel, cb) => {
    const listener = (_e: unknown, data: unknown): void => cb(data)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
  (file) => webUtils.getPathForFile(file)
)

contextBridge.exposeInMainWorld('jolty', api)
// the language is known before any interface module runs, so texts built at load time are right too
contextBridge.exposeInMainWorld('joltyLang', ipcRenderer.sendSync('app:lang'))
