import { tr } from './i18n'
// A message that seems to carry a key or a password. Only a hint for the sender, never a block.
const KINDS: [string, RegExp][] = [
  [tr("o cheie API"), /\b(?:sk-ant-[\w-]{16,}|sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_\w{30,}|AKIA[0-9A-Z]{16}|AIza[\w-]{30,}|xox[abp]-[\w-]{10,})/],
  [tr("o cheie privată"), /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  [tr("o parolă"), /\b(?:password|passwd|pwd|parola)\s*[:=]\s*\S{4,}/i],
  [tr("un token"), /\b(?:token|secret|api[_-]?key)\s*[:=]\s*["']?[\w\-./+=]{16,}/i],
  [tr("un IBAN"), /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}\b/]
]

/** What the text looks like it contains ("o cheie API"), or undefined. */
export function secretHint(text: string): string | undefined {
  return KINDS.find(([, re]) => re.test(text))?.[0]
}
