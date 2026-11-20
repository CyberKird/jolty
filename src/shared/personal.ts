import { tr } from './i18n'

// A message that seems to carry someone's personal data. Only a hint for the sender, never a block:
// the person who wrote the text knows whether it is a real customer or an example.
const KINDS: [string, RegExp][] = [
  [tr('o adresă de email'), /\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/i],
  [tr('un IBAN'), /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}\b/],
  [tr('un număr de telefon'), /(?:\+\d{1,3}|\b(?:tel|telefon|phone|mobil|handy)\b)[\s:.]*\(?\d[\d\s()./-]{6,}/i]
]

/** What the text looks like it contains ("o adresă de email"), or undefined. */
export function personalHint(text: string): string | undefined {
  return KINDS.find(([, re]) => re.test(text))?.[0]
}
