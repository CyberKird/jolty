import { tr } from '@shared/i18n'
import wordmark from '../assets/joltarise-wordmark-volt.svg'

// Plain DOM on purpose: this screen is shown while the entry module is still waiting for the pairing (top-level await),
// and a React component would import the entry chunk back and wait for it forever.

/** What the PC or the network said, in the user's language. Anything unknown means the PC could not be reached. */
function say(message: string): string {
  if (/not valid|expired/i.test(message)) return tr("Codul nu e valid sau a expirat")
  if (/pairing failed/i.test(message)) return tr("Împerecherea a eșuat")
  if (/no longer paired/i.test(message)) return tr("Telefonul nu mai e împerecheat. Deschide din nou linkul din Jolty.")
  return tr("Nu pot ajunge la PC. Verifică Tailscale și că Jolty e pornit pe PC.")
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (className) e.className = className
  if (text !== undefined) e.textContent = text
  return e
}

const BOLT = '<svg class="bolt" width="' + (17 * 205) / 740 + '" height="17" viewBox="0 0 205 740" aria-hidden="true"><polygon points="52,0 170,0 118,300 205,284 56,740 84,408 0,426"/></svg>'

/** Shows the pairing screen in place of the app until a code is accepted; `claim` trades the code for the phone's key. */
export function pairScreen(first: string | undefined, claim: (code: string) => Promise<string>): Promise<string> {
  const root = document.getElementById('root')!
  root.replaceChildren()
  const page = el('div', 'pair')

  const bar = el('header', 'titlebar')
  const brand = el('div', 'titlebar-brand')
  brand.insertAdjacentHTML('beforeend', BOLT)
  const name = el('span', 'brand-name')
  name.append('JOLT', el('b', undefined, 'Y'))
  const img = el('img', 'titlebar-wordmark')
  img.src = wordmark
  img.alt = 'Joltarise'
  img.draggable = false
  brand.append(name, el('span', 'titlebar-by', 'by'), img)
  bar.append(brand)

  const form = el('form', 'pair-body')
  const headline = el('h1', 'pair-headline', tr("Împerechează telefonul"))
  headline.append(el('span', undefined, '.'))
  const note = el('p', 'pair-note', tr("Pe PC, în Jolty, deschide Setări, Telefon și apasă „Împerechează un telefon”. Apoi scrie aici codul afișat."))
  const input = el('input', 'input pair-code')
  input.placeholder = tr("Cod de împerechere")
  input.setAttribute('aria-label', tr("Cod de împerechere"))
  input.autocomplete = 'off'
  input.autocapitalize = 'characters'
  input.spellcheck = false
  input.setAttribute('autocorrect', 'off')
  const go = el('button', 'btn primary pair-go', tr("Împerechează"))
  go.type = 'submit'
  go.disabled = true
  const error = el('p', 'pair-error', first ? say(first) : '')
  error.setAttribute('role', 'alert')
  input.addEventListener('input', () => {
    input.value = input.value.toUpperCase()
    go.disabled = !input.value.trim()
  })
  form.append(headline, note, input, go, error)
  page.append(bar, form)
  root.append(page)

  return new Promise((resolve) => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault()
      if (go.disabled) return
      go.disabled = true
      error.textContent = ''
      try {
        const token = await claim(input.value)
        root.replaceChildren()
        resolve(token)
      } catch (err) {
        error.textContent = say(err instanceof Error ? err.message : String(err))
        go.disabled = !input.value.trim()
      }
    })
  })
}
