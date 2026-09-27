// Instructions Jolty adds to every conversation, on both engines.

/** The user wants no em or en dashes anywhere: not in replies, not in what the model writes to disk. */
export const WRITING_RULES =
  'Never use em dashes (U+2014) or en dashes (U+2013) as punctuation: not in replies, code, comments, commit messages or any file you write. Use a comma, a colon, parentheses or a plain hyphen instead.'
