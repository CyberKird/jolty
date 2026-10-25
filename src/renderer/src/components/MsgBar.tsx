import { useMemo } from 'react'
import { lastCodeBlock, shownText } from '../copy'
import { tr } from '@shared/i18n'
import { CopyButton } from './CopyField'
import { quoteActive } from './Quote'
import { plainDashes } from './Rich'

/**
 * The hover toolbar of a message. It sits in space the row reserves, shows through CSS only (hover, focus inside, or always on touch),
 * and every button is a real button, so Tab reaches it.
 */
export function MsgBar({ text, markdown }: { text: string; markdown?: string }) {
  const shown = useMemo(() => (markdown ? plainDashes(markdown) : ''), [markdown])
  const code = useMemo(() => (shown ? lastCodeBlock(shown) : ''), [shown])
  if (!text.trim()) return null
  return (
    <div className="msgbar" role="toolbar" aria-label={tr("Acțiuni pentru mesaj")}>
      <CopyButton label={tr("Copiază mesajul")} said={tr("Mesaj copiat")} get={(el) => shownText(el.closest('.msg-assistant, .msg-row')?.querySelector('.md, .message-text')) || text} />
      {shown && <CopyButton icon="file" label={tr("Copiază ca Markdown")} said={tr("Markdown copiat")} get={() => shown} />}
      {code && <CopyButton icon="block" label={tr("Copiază ultimul bloc de cod")} said={tr("Cod copiat")} get={() => code} />}
      <button type="button" className="cp" aria-label={tr("Răspunde la acest mesaj")} title={tr("Răspunde la acest mesaj")} onClick={() => quoteActive(text)}>
        <i className="ic ic-reply" aria-hidden />
      </button>
    </div>
  )
}
