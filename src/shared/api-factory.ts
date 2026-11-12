import type { ChatEvent, JoltyApi } from './types'

/** Sends a call to the main process (Electron IPC in the app, a WebSocket in the phone page) and returns what it answers. */
export type Call = <T>(channel: string, ...args: unknown[]) => Promise<T>
/** Listens to a push channel of the main process; returns the function that stops listening. */
export type Listen = (channel: string, cb: (data: unknown) => void) => () => void

/** The whole renderer API as channel calls: the desktop preload and the phone page build the same object from it. */
export function createApi(call: Call, listen: Listen, filePath: (file: File) => string): JoltyApi {
  return {
    files: { path: filePath },
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
      setMcpOff: (id, names) => call('sessions:setMcpOff', id, names),
      connectors: () => call('sessions:connectors'),
      githubOverview: (id, force) => call('sessions:githubOverview', id, force),
      githubIssue: (id, n) => call('sessions:githubIssue', id, n),
      githubAutoMerge: (id, on) => call('sessions:githubAutoMerge', id, on),
      compact: (id) => call('sessions:compact', id),
      compactAndWait: (id) => call('sessions:compactAndWait', id),
      rewind: (id, itemId, dryRun) => call('sessions:rewind', id, itemId, dryRun),
      respond: (id, requestId, decision) => call('sessions:respond', id, requestId, decision),
      handoff: (id, target, model, effort, fresh) => call('sessions:handoff', id, target, model, effort, fresh),
      remove: (id) => call('sessions:remove', id),
      rename: (id, title) => call('sessions:rename', id, title),
      referenceFile: (id) => call('sessions:referenceFile', id),
      setFlags: (ids, flags) => call('sessions:setFlags', ids, flags),
      closed: () => call('sessions:closed'),
      restore: (id) => call('sessions:restore', id),
      side: (id, profileId, model, effort) => call('sessions:side', id, profileId, model, effort),
      promoteSide: (id) => call('sessions:promoteSide', id),
      review: (id) => call('sessions:review', id),
      improvePrompt: (text, profileId, model, cwd, sessionId) => call('sessions:improvePrompt', text, profileId, model, cwd, sessionId),
      onEvent: (cb) => listen('jolty:event', (ev) => cb(ev as ChatEvent))
    },
    skills: {
      list: () => call('skills:list'),
      check: (ids) => call('skills:check', ids),
      update: (id) => call('skills:update', id),
      setSource: (id, source) => call('skills:setSource', id, source),
      reveal: (id) => call('skills:reveal', id)
    },
    pack: {
      items: () => call('pack:items'),
      export: (req) => call('pack:export', req),
      open: (file) => call('pack:open', file),
      apply: (previewId, decisions) => call('pack:apply', previewId, decisions),
      discard: (previewId) => call('pack:discard', previewId),
      undo: (importId) => call('pack:undo', importId)
    },
    backup: {
      list: () => call('backup:list'),
      pictures: () => call('backup:pictures'),
      setConfig: (id, values) => call('backup:setConfig', id, values),
      connect: (id) => call('backup:connect', id),
      disconnect: (id) => call('backup:disconnect', id),
      setPassword: (id, password) => call('backup:setPassword', id, password),
      run: (id) => call('backup:run', id),
      remote: (id) => call('backup:remote', id),
      restore: (id, password) => call('backup:restore', id, password)
    },
    usage: {
      time: () => call('usage:time'),
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
    claudeWeb: {
      list: () => call('claudeWeb:list'),
      connect: (profileId) => call('claudeWeb:connect', profileId),
      disconnect: (profileId) => call('claudeWeb:disconnect', profileId),
      refresh: (profileId) => call('claudeWeb:refresh', profileId)
    },
    setup: {
      testKey: (baseUrl, model, key) => call('setup:testKey', baseUrl, model, key),
      providerModels: (baseUrl, key, profileId) => call('setup:providerModels', baseUrl, key, profileId),
      testFree: (model) => call('setup:testFree', model),
      account: (engine) => call('setup:account', engine),
      presets: () => call('setup:presets'),
      helper: (profileId, model) => call('setup:helper', profileId, model)
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
      sendBugReport: (message, facts) => call('app:sendBugReport', message, facts),
      notificationsBlocked: () => call('app:notificationsBlocked'),
      openNotificationSettings: () => call('app:openNotificationSettings'),
      glassSupport: () => call('app:glassSupport'),
      openColorSettings: () => call('app:openColorSettings'),
      openPath: (p) => call('app:openPath', p),
      revealPath: (p) => call('app:revealPath', p),
      edit: (a) => call('app:edit', a),
      copyText: (t) => call('app:copyText', t),
      image: (kind, image, name) => call('app:image', kind, image, name),
      openLocal: (p) => call('app:openLocal', p),
      openLink: (u) => call('app:openLink', u),
      version: () => call('app:version')
    },
    merge: {
      status: (id) => call('merge:status', id),
      check: (id, action) => call('merge:check', id, action),
      run: (id, action, seen) => call('merge:run', id, action, seen),
      pr: (id, title, body) => call('merge:pr', id, title, body),
      remove: (id, tip, lose) => call('merge:remove', id, tip, lose)
    },
    background: {
      state: () => call('background:state'),
      setQuickKey: (key) => call('background:setQuickKey', key),
      quickSubmit: (input) => call('quick:submit', input),
      quickClose: () => call('quick:close'),
      onQuickShown: (cb) => listen('quick:shown', () => cb())
    },
    library: {
      list: () => call('library:list'),
      image: (sessionId, itemId, index, small) => call('library:image', sessionId, itemId, index, small)
    },
    remote: {
      status: () => call('remote:status'),
      enable: (on) => call('remote:enable', on),
      pair: () => call('remote:pair'),
      revoke: (id) => call('remote:revoke', id),
      disconnect: () => call('remote:disconnect'),
      stopScreen: () => call('remote:stopScreen'),
      wakeStatus: () => call('remote:wakeStatus'),
      wakeSet: (url) => call('remote:wakeSet', url),
      wakeTest: () => call('remote:wakeTest'),
      wakeConfig: () => call('remote:wakeConfig'),
      onChange: (cb) => listen('remote:changed', () => cb())
    }
  }
}
