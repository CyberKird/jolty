// The lazy pages, loadable ahead of the switch: the page cross-fades in with its content, not a blank column that fills later.
const loaders: Record<string, () => Promise<unknown>> = {
  import: () => import('./pages/Import'),
  accounts: () => import('./pages/Accounts'),
  local: () => import('./pages/Local'),
  usage: () => import('./pages/Usage'),
  schedules: () => import('./pages/Schedules'),
  skills: () => import('./pages/Skills'),
  system: () => import('./pages/System'),
  settings: () => import('./pages/Settings')
}

/** Resolves once the page's code is in, or after `ms` so a slow disk never stalls the click. */
export function preloadPage(page: string, ms = 250): Promise<unknown> {
  const load = loaders[page]?.()
  return load ? Promise.race([load.catch(() => undefined), new Promise((r) => setTimeout(r, ms))]) : Promise.resolve()
}
