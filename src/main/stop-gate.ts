import type { ChatEvent, ChatItem } from '@shared/types'

/**
 * What a conversation may still say after the user pressed Stop. The engine winds down on its own time: its
 * trailing text, new tools and a late "running" must not bring the chat back to life. Results of tools already
 * shown still land (their spinners stop), notices pass, and so do the final idle and error.
 */
export function afterStop(e: ChatEvent, shown: (itemId: string) => ChatItem | undefined): boolean {
  switch (e.type) {
    case 'status':
      return e.status !== 'running'
    case 'delta':
    case 'draft':
    case 'plan':
      return false
    case 'item':
      return e.item.kind === 'notice' || (e.item.kind === 'tool' && shown(e.item.id)?.kind === 'tool')
    default:
      return true
  }
}
