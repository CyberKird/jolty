import { contextBridge, ipcRenderer } from 'electron'
import type { ChatEvent, JoltyApi } from '@shared/types'

// Main-process errors arrive as "Error invoking remote method 'x': Error: message"; keep the message.
async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return (await ipcRenderer.invoke(channel, ...args)) as T
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
  }
}

const api: JoltyApi = {
  profiles: {
    list: () => call('profiles:list'),
    create: (input) => call('profiles:create', input),
    update: (id, patch) => call('profiles:update', id, patch),
    remove: (id) => call('profiles:remove', id),
    status: (id) => call('profiles:status', id),
    login: (id) => call('profiles:login', id),
    logout: (id) => call('profiles:logout', id),
    models: (id) => call('profiles:models', id)
  },
  sessions: {
    list: () => call('sessions:list'),
    external: (profileId, cwd) => call('sessions:external', profileId, cwd),
    start: (input) => call('sessions:start', input),
    history: (id) => call('sessions:history', id),
    send: (id, text, attachments) => call('sessions:send', id, text, attachments),
    interrupt: (id) => call('sessions:interrupt', id),
    setModel: (id, model) => call('sessions:setModel', id, model),
    setEffort: (id, effort) => call('sessions:setEffort', id, effort),
    setPermissionMode: (id, mode) => call('sessions:setPermissionMode', id, mode),
    respond: (id, requestId, decision) => call('sessions:respond', id, requestId, decision),
    handoff: (id, target) => call('sessions:handoff', id, target),
    remove: (id) => call('sessions:remove', id),
    onEvent: (cb) => {
      const listener = (_e: unknown, ev: ChatEvent): void => cb(ev)
      ipcRenderer.on('jolty:event', listener)
      return () => ipcRenderer.removeListener('jolty:event', listener)
    }
  },
  usage: {
    summary: () => call('usage:summary'),
    refreshLimits: (id) => call('usage:refreshLimits', id)
  },
  local: {
    hardware: () => call('local:hardware'),
    status: () => call('local:status'),
    catalog: () => call('local:catalog'),
    pull: (tag) => call('local:pull', tag),
    remove: (tag) => call('local:remove', tag),
    createProfile: (tag) => call('local:createProfile', tag),
    installOllama: () => call('local:installOllama')
  },
  system: {
    check: () => call('system:check'),
    fix: (id) => call('system:fix', id)
  },
  codexImport: {
    detect: (id, cwd) => call('codexImport:detect', id, cwd),
    run: (id, cwd, types) => call('codexImport:run', id, cwd, types)
  },
  app: {
    settings: () => call('app:settings'),
    saveSettings: (patch) => call('app:saveSettings', patch),
    pickFolder: () => call('app:pickFolder'),
    openExternal: (url) => call('app:openExternal', url),
    openPath: (p) => call('app:openPath', p),
    version: () => call('app:version')
  }
}

contextBridge.exposeInMainWorld('jolty', api)
