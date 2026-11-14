// Questions with choices for the user, shown as a card in the chat: Claude Code's own AskUserQuestion tool,
// and ask_user on the Jolty MCP server for the engines that have no such tool (Codex, OpenCode, Gemini).
import type { AskQuestion } from '@shared/types'

export const ASK_USER_TOOL = 'ask_user'

const MAX_QUESTIONS = 4
const MAX_OPTIONS = 6

const clip = (v: unknown, n: number): string => (typeof v === 'string' ? v.trim().slice(0, n) : '')

/** The questions of a tool call, cleaned up; undefined when there is nothing a card can show. */
export function parseQuestions(input: unknown): AskQuestion[] | undefined {
  const raw = (input as { questions?: unknown })?.questions
  if (!Array.isArray(raw)) return undefined
  const out: AskQuestion[] = []
  for (const q of raw.slice(0, 20)) {
    const question = clip((q as { question?: unknown })?.question, 600)
    const opts = (q as { options?: unknown })?.options
    if (!question || !Array.isArray(opts)) continue
    const options = opts
      .slice(0, MAX_OPTIONS)
      .map((o) => (typeof o === 'string' ? { label: clip(o, 120) } : { label: clip(o?.label, 120), description: clip(o?.description, 400) || undefined }))
      .filter((o) => o.label)
    if (options.length < 2) continue
    out.push({ question, header: clip((q as { header?: unknown }).header, 24) || undefined, options, multiSelect: (q as { multiSelect?: unknown }).multiSelect === true })
  }
  // the answers are keyed by the question text, so two equal questions would share one answer
  const seen = new Set<string>()
  const unique = out.filter((q) => !seen.has(q.question) && seen.add(q.question)).slice(0, MAX_QUESTIONS)
  return unique.length ? unique : undefined
}

/** Answers from the renderer: only the questions that were asked, as text. */
export function cleanAnswers(questions: AskQuestion[], answers: unknown): Record<string, string> | undefined {
  if (!answers || typeof answers !== 'object') return undefined
  const out: Record<string, string> = {}
  for (const q of questions) {
    const a = clip((answers as Record<string, unknown>)[q.question], 4000)
    if (a) out[q.question] = a
  }
  return Object.keys(out).length ? out : undefined
}

/** The tool result when the user closes the card without answering. */
export const DISMISSED =
  'The user dismissed the question without answering. Do not ask the same thing again: go on with your best judgment and say in one line what you chose, or stop if the task cannot go on without the answer.'

/** What ask_user hands back to the model. */
export function formatAnswers(questions: AskQuestion[], answers: Record<string, string> | undefined): string {
  if (!answers) return DISMISSED
  return questions.map((q) => `${q.question}\nAnswer: ${answers[q.question] || '(no answer)'}`).join('\n\n')
}

/** Sessions nobody is watching (a scheduled run, a job of a lead session) decide on their own. */
export const NOBODY_WATCHING =
  'Nobody is watching this session, so no one can answer. Decide yourself with your best judgment, say in one line what you chose and why, and go on.'

/** When to ask. `tool` is the name the engine knows the question tool by. */
export function askRule(tool: string): string {
  return `Questions for the user: when you reach a real decision that changes the result (two or more reasonable approaches, a design or product choice, scope, a destructive or costly step) and the request, the project, the memory and earlier conversations do not settle it, ask with the ${tool} tool instead of guessing or writing the question as plain text: 1 to 4 questions, each with 2 to 4 short, distinct options and a one-line description of what each means; put the option you recommend first and add " (recommended)" to its label; the user can always type their own answer, so never add an "Other" option. Do not ask about what you can decide or check yourself, about steps the user already approved, or just to confirm you may continue: then keep working. Batch related questions into one call instead of asking one after another.`
}

export const ASK_USER_SCHEMA = {
  name: ASK_USER_TOOL,
  description:
    'Asks the user 1 to 4 multiple-choice questions in a card in the chat and waits for the answers. The user can also type their own answer. Use it when a real decision is open and nothing you can read settles it.',
  inputSchema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_QUESTIONS,
        items: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'the full question, ending with a question mark' },
            header: { type: 'string', description: 'very short label shown as a tag (max 12 characters)' },
            options: {
              type: 'array',
              minItems: 2,
              maxItems: 4,
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', description: '1 to 5 words' },
                  description: { type: 'string', description: 'what choosing it means' }
                },
                required: ['label']
              }
            },
            multiSelect: { type: 'boolean', description: 'true when several options can be picked together' }
          },
          required: ['question', 'options']
        }
      }
    },
    required: ['questions']
  }
}
