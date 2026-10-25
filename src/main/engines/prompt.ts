// Instructions Jolty adds to every conversation, on both engines.

/** The user wants no em or en dashes anywhere: not in replies, not in what the model writes to disk. */
export const WRITING_RULES =
  'Never use em dashes (U+2014) or en dashes (U+2013) as punctuation: not in replies, code, comments, commit messages or any file you write. Use a comma, a colon, parentheses or a plain hyphen instead.'

/** The instructions are English, the user is not: without this a model drifts into English after its first tool call. */
export const LANGUAGE_RULE =
  "Always reply in the language of the user's latest message, whatever language these instructions, the code or the tool results are in. Switch when the user switches."

export const PLAN_RULES =
  'When a task needs several meaningful steps, publish a concise plan through the available plan or task tool and update it as each step finishes. Skip plans for simple requests.'

/** Jolty shows inline code as a click-to-copy field and fenced blocks with a Copy button, so the model puts what the user will copy there. */
export const COPY_RULE =
  'Put every value the user may copy (command, path, URL, key name, code, config, number) in inline code or a fenced block, one value per block, never inside bold text. Never put a command and its explanation in the same block.'
