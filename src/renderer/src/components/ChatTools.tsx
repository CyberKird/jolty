import { useEffect } from 'react'
import { tr } from '@shared/i18n'
import { copyWithToast, lastCodeBlock } from '../copy'
import { useStore } from '../store'
import { plainDashes } from './Rich'

/** The polite announcement of every copy, and the two copy shortcuts of the conversation. */
export function ChatTools() {
  useEffect(() => {
    const lastReply = (): string => {
      const { transcripts, activeId } = useStore.getState()
      const items = (activeId && transcripts[activeId]) || []
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i]
        if (it.kind === 'assistant' && it.text.trim()) return plainDashes(it.text)
      }
      return ''
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.code !== 'KeyC' || !e.ctrlKey || e.metaKey) return
      const field = (e.target as HTMLElement | null)?.closest<HTMLInputElement | HTMLTextAreaElement>('textarea, input')
      // a text field with a selection keeps its own copy; AltGr letters (Ctrl+Alt) are typing, not a shortcut
      if (field && field.selectionStart !== field.selectionEnd) return
      if (e.shiftKey && !e.altKey) {
        const text = lastReply()
        if (!text) return
        e.preventDefault()
        copyWithToast(text, tr("Ultimul răspuns copiat"))
      } else if (e.altKey && !e.shiftKey && e.key.toLowerCase() === 'c') {
        const code = lastCodeBlock(lastReply())
        if (!code) return
        e.preventDefault()
        copyWithToast(code, tr("Ultimul bloc de cod copiat"))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return <div id="copy-live" className="sr-only" role="status" aria-live="polite" />
}
