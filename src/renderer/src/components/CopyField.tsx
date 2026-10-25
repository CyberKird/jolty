import { copyText } from '../copy'

/**
 * A copy button. Icon only, or with a label that swaps to `done` in place (both stacked, so the button never changes width).
 * `get` runs on click, so nothing is computed while the page renders. The icons are CSS masks (chat-tools.css).
 */
export function CopyButton({ get, label, done, text, said, icon = 'copy', className = '' }: { get: (from: HTMLElement) => string; label: string; done?: string; text?: string; said?: string; icon?: 'copy' | 'file' | 'block'; className?: string }) {
  return (
    <button type="button" className={`cp ${className}`} aria-label={label} title={label} onClick={(e) => copyText(get(e.currentTarget), e.currentTarget, said)}>
      <i className={`ic ic-${icon}`} aria-hidden />
      {text && <span className="lbl" aria-hidden data-t={text} data-ok={done || ''} />}
    </button>
  )
}
