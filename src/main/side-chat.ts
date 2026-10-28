// A side chat: a quick question beside a long conversation without adding a turn to it. It is a temporary
// chat (memory only, engine files wiped) marked with sideOf, so it never shows in the sidebar, and it is
// read-only. It starts from a short brief of the main chat built with the handoff digest. Texts for the model stay in English.
import { TaskBoard } from '@shared/tasks'
import type { ChatItem, Profile, SessionMeta, StartSessionInput } from '@shared/types'
import { isAcp } from '@shared/types'
import { tr } from '@shared/i18n'
import { digest, roughTokens } from './handoff'

/** characters of recent conversation in the brief: a side question should cost little */
export const SIDE_BUDGET = 2400
const MAX_FILES = 15
const MAX_STEPS = 12

/** what a write, a command or a browser action gets back in a side chat */
export const SIDE_READ_ONLY = 'This is a read-only side chat: it cannot edit files, run commands, browse or start sessions. Answer from what you can read, or tell the user to do it in the main chat.'

/** The brief the side chat's first message carries: the latest exchanges, the files touched and the plan. */
export function sideBrief(main: Pick<SessionMeta, 'cwd' | 'title'>, items: ChatItem[]): { text: string; tokens: number } {
  const d = digest(items, { budget: SIDE_BUDGET, perRequest: 1200, perAnswer: 800 })
  const steps = new TaskBoard().replay(items).steps().slice(0, MAX_STEPS)
  const mark = { done: 'x', active: '>', pending: ' ' } as const
  const text = [
    `This is a side chat next to a main conversation ("${main.title}") in ${main.cwd}. Nothing said here reaches the main conversation.`,
    SIDE_READ_ONLY,
    'A short summary of the main conversation follows; it is context, not a task.',
    '',
    `Latest messages${d.dropped ? ` (${d.dropped} older ones left out)` : ''}:`,
    '<conversation>',
    d.recent || '(empty)',
    '</conversation>',
    ...(d.files.length ? ['', 'Files changed in the main conversation:', ...d.files.slice(0, MAX_FILES).map((f) => `- ${f}`)] : []),
    ...(steps.length ? ['', 'Its current plan:', ...steps.map((s) => `[${mark[s.status]}] ${s.text}`)] : [])
  ].join('\n')
  return { text, tokens: roughTokens(text) }
}

/** The first message of a side chat: the brief, then the user's question. */
export const withBrief = (brief: string, question: string): string => `${brief}\n\nAnswer the message below, in the language it is written in.\n\n<message>\n${question}\n</message>`

/**
 * How the side chat starts: the main chat's account and model unless another is picked, always temporary and in plan
 * mode, never with the browser or the computer. Temporary chats exist only for Claude and Codex, so a main chat on
 * another engine borrows the first Claude or Codex account.
 */
export function sideStart(main: SessionMeta, profiles: Pick<Profile, 'id' | 'engine'>[], pick: { profileId?: string; model?: string; effort?: string } = {}): StartSessionInput {
  const able = (id?: string): boolean => Boolean(id && profiles.some((p) => p.id === id && !isAcp(p.engine)))
  const profileId = able(pick.profileId) ? pick.profileId! : able(main.profileId) ? main.profileId : profiles.find((p) => !isAcp(p.engine))?.id
  if (!profileId) throw new Error(tr("Conversația laterală are nevoie de un cont Claude sau Codex."))
  const same = profileId === main.profileId
  return {
    profileId,
    cwd: main.cwd,
    model: pick.model || (same ? main.model : undefined),
    effort: pick.effort ?? (same && !pick.model ? main.effort : undefined),
    permissionMode: 'plan',
    temporary: true,
    sideOf: main.id
  }
}

/** Side chats live beside their main chat, never in the list. */
export const listed = (m: Pick<SessionMeta, 'sideOf'>): boolean => !m.sideOf
