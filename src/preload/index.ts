import { contextBridge, ipcRenderer, webUtils } from 'electron'
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
  files: { path: (file) => webUtils.getPathForFile(file) },
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
    importAll: () => call('sessions:importAll'),
    send: (id, text, attachments) => call('sessions:send', id, text, attachments),
    interrupt: (id) => call('sessions:interrupt', id),
    setModel: (id, model) => call('sessions:setModel', id, model),
    setEffort: (id, effort) => call('sessions:setEffort', id, effort),
    setPermissionMode: (id, mode) => call('sessions:setPermissionMode', id, mode),
    setBrowser: (id, on) => call('sessions:setBrowser', id, on),
    compact: (id) => call('sessions:compact', id),
    rewind: (id, itemId, dryRun) => call('sessions:rewind', id, itemId, dryRun),
    respond: (id, requestId, decision) => call('sessions:respond', id, requestId, decision),
    handoff: (id, target, model, effort) => call('sessions:handoff', id, target, model, effort),
    remove: (id) => call('sessions:remove', id),
    review: (id) => call('sessions:review', id),
    onEvent: (cb) => {
      const listener = (_e: unknown, ev: ChatEvent): void => cb(ev)
      ipcRenderer.on('jolty:event', listener)
      return () => ipcRenderer.removeListener('jolty:event', listener)
    }
  },
  usage: {
    summary: () => call('usage:summary'),
    balance: (id) => call('usage:balance', id),
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
  updates: {
    status: () => call('updates:status'),
    check: () => call('updates:check'),
    install: () => call('updates:install')
  },
  composer: {
    slash: (cwd) => call('composer:slash', cwd),
    files: (cwd) => call('composer:files', cwd)
  },
  browser: {
    hasToken: () => call('browser:hasToken'),
    info: () => call('browser:info'),
    setToken: (token) => call('browser:setToken', token),
    openExtensionPage: () => call('browser:openExtensionPage'),
    live: (on) => call('browser:live', on)
  },
  app: {
    settings: () => call('app:settings'),
    saveSettings: (patch) => call('app:saveSettings', patch),
    pickFolder: () => call('app:pickFolder'),
    openExternal: (url) => call('app:openExternal', url),
    openPath: (p) => call('app:openPath', p),
    revealPath: (p) => call('app:revealPath', p),
    edit: (a) => call('app:edit', a),
    copyText: (t) => call('app:copyText', t),
    image: (kind, image, name) => call('app:image', kind, image, name),
    openLocal: (p) => call('app:openLocal', p),
    openLink: (u) => call('app:openLink', u),
    version: () => call('app:version')
  }
}

contextBridge.exposeInMainWorld('jolty', api)
// the language is known before any interface module runs, so texts built at load time are right too
contextBridge.exposeInMainWorld('joltyLang', ipcRenderer.sendSync('app:lang'))
