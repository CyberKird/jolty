// What the model may not touch, and what always needs a yes. Pure: the service feeds it window facts.
export interface WinFacts {
  exe: string
  title: string
  cls?: string
  path?: string
}

export type Verdict = { kind: 'blocked'; reason: string } | { kind: 'always'; reason: string } | { kind: 'app'; key: string; label: string }

const SECURITY_EXE = /^(consent|logonui|winlogon|credentialuibroker|securityhealthsystray|sechealthui|securityhealthservice|lockapp|windowsdefender|msmpeng)\.exe$/i
const SECURITY_TITLE = /(user account control|windows security|windows defender|windows hello|credential|sign in to windows|securitate windows|control cont utilizator)/i
const SECRETS_EXE = /^(keepass|keepassxc|keepassdx|1password|bitwarden|lastpass|dashlane|nordpass|enpass|roboform|protonpass|proton pass|keeper|authy|kleopatra|gpg4win|veracrypt)\w*\.exe$/i
const SECRETS_TITLE = /(1password|bitwarden|keepass|lastpass|dashlane|nordpass|enpass|roboform|proton pass|keeper password|password manager|manager de parole|veracrypt)/i
const BANKING_TITLE = /(\bbank|\bbanc|banking|\biban\b|paypal|revolut|\bwise\b|stripe|binance|coinbase|metamask|credit card|card number|checkout|payment|netbanking|home'?bank|\bbcr\b|\bbrd\b|raiffeisen)/i
/** System surfaces: anything done there reaches past one application, so each action is approved by itself. */
const SYSTEM_EXE = /^(explorer|searchhost|searchapp|startmenuexperiencehost|shellexperiencehost|taskmgr|regedit|mmc|control|systemsettings|msconfig|services|eventvwr|compmgmt|diskmgmt|gpedit|secpol|wscript|cscript|mshta|rundll32|runas|installer|msiexec|setup|uninstall|winget|ms-teams-installer)\w*\.exe$/i
const TERMINAL_EXE = /^(windowsterminal|wt|cmd|powershell|powershell_ise|pwsh|conhost|openconsole|mintty|bash|wsl|wslhost|alacritty|wezterm-gui|kitty|hyper|conemu\w*|putty|kitty|tabby|terminus|git-bash|mobaxterm)\.exe$/i
const TERMINAL_CLASS = /^(consolewindowclass|cascadia_hosting_window_class|mintty|virtualconsoleclass)$/i

export const isTerminal = (w: WinFacts): boolean => TERMINAL_EXE.test(w.exe) || TERMINAL_CLASS.test(w.cls || '')

/** Whether typing and clicking in this window is refused outright. */
export function blockedReason(w: WinFacts, secure = false): string | undefined {
  if (secure) return 'A secure Windows screen (UAC, lock screen or sign-in) is open. Jolty never types or clicks there; the user has to handle it.'
  if (SECURITY_EXE.test(w.exe) || SECURITY_TITLE.test(w.title)) return `"${w.title || w.exe}" is a Windows security window. Jolty never types or clicks there.`
  if (SECRETS_EXE.test(w.exe) || SECRETS_TITLE.test(w.title)) return `"${w.title || w.exe}" looks like a password manager or encryption tool. Jolty never types or clicks there.`
  if (BANKING_TITLE.test(w.title)) return `"${w.title}" looks like a banking or payment page. Jolty never types or clicks there; ask the user to do it.`
  return undefined
}

/** The identity trust is given to: the program, and for the shared UWP host also the window title. */
export function appKey(w: WinFacts): string {
  const exe = (w.exe || 'unknown').toLowerCase()
  return exe === 'applicationframehost.exe' ? `${exe}:${w.title.toLowerCase()}` : exe
}

export const appLabel = (w: WinFacts): string => (w.exe || 'unknown').replace(/\.exe$/i, '')

export function classify(w: WinFacts, secure = false): Verdict {
  const blocked = blockedReason(w, secure)
  if (blocked) return { kind: 'blocked', reason: blocked }
  if (SYSTEM_EXE.test(w.exe)) return { kind: 'always', reason: `${appLabel(w)} is part of Windows itself` }
  return { kind: 'app', key: appKey(w), label: appLabel(w) }
}

/** A chord with the Windows key (Win+R, Win+X ...) opens things outside the current application. */
export const reachesPastApp = (vks: number[]): boolean => vks.includes(0x5b) || vks.includes(0x5c)

const SECRET_NAME = /(passw|parol|\bpin\b|\bcvv\b|\bcvc\b|card.?number|secret|token|2fa|otp|one.?time)/i

/** A focused control that holds a secret: the formal flag first, then the names people give such fields. */
export function secretField(el: { password?: boolean; name?: string; id?: string } | null | undefined): boolean {
  if (!el) return false
  return el.password === true || SECRET_NAME.test(`${el.name || ''} ${el.id || ''}`)
}
