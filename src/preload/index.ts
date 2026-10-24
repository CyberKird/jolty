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
    reorder: (ids) => call('profiles:reorder', ids),
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
    send: (id, text, attachments, parallel) => call('sessions:send', id, text, attachments, parallel),
    interrupt: (id) => call('sessions:interrupt', id),
    setModel: (id, model) => call('sessions:setModel', id, model),
    setEffort: (id, effort) => call('sessions:setEffort', id, effort),
    setPermissionMode: (id, mode) => call('sessions:setPermissionMode', id, mode),
    setBrowser: (id, on) => call('sessions:setBrowser', id, on),
    setComputer: (id, on) => call('sessions:setComputer', id, on),
    compact: (id) => call('sessions:compact', id),
    compactAndWait: (id) => call('sessions:compactAndWait', id),
    rewind: (id, itemId, dryRun) => call('sessions:rewind', id, itemId, dryRun),
    respond: (id, requestId, decision) => call('sessions:respond', id, requestId, decision),
    handoff: (id, target, model, effort, fresh) => call('sessions:handoff', id, target, model, effort, fresh),
    remove: (id) => call('sessions:remove', id),
    rename: (id, title) => call('sessions:rename', id, title),
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
  voice: {
    status: () => call('voice:status'),
    download: () => call('voice:download'),
    transcribe: (wav, lang) => call('voice:transcribe', wav, lang)
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
  power: {
    arm: (on, plan) => call('power:arm', on, plan),
    cancel: () => call('power:cancel'),
    state: () => call('power:state')
  },
  browser: {
    hasToken: () => call('browser:hasToken'),
    info: () => call('browser:info'),
    setToken: (token) => call('browser:setToken', token),
    openExtensionPage: () => call('browser:openExtensionPage'),
    native: () => call('browser:native'),
    installNative: () => call('browser:installNative'),
    live: (on) => call('browser:live', on)
  },
  preview: {
    open: (cwd) => call('preview:open', cwd),
    probe: (ports) => call('preview:probe', ports),
    draft: (rel, html) => call('preview:draft', rel, html)
  },
  schedules: {
    list: () => call('schedules:list'),
    add: (input) => call('schedules:add', input),
    update: (id, patch) => call('schedules:update', id, patch),
    remove: (id) => call('schedules:remove', id),
    run: (id) => call('schedules:run', id)
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
