/** Files that hold secrets: a model gets asked about them even in the modes that otherwise read and edit freely. */
export const SECRET_FILES = ['**/.env', '**/.env.*', '**/secrets.json', '**/.credentials.json', '**/*.pem', '**/*.key', '**/id_rsa*', '**/id_ed25519*', '~/.ssh/**']
export const SECRET_FILE_RULES = SECRET_FILES.flatMap((f) => [`Read(${f})`, `Edit(${f})`])

const SECRET_PATH = /(^|[\\/])(\.env(\..*)?|secrets\.json|\.credentials\.json|[^\\/]*\.(pem|key)|id_rsa[^\\/]*|id_ed25519[^\\/]*)$|[\\/]\.ssh[\\/]/i

/** Whether a file path is one of SECRET_FILES (the same list, as a regular expression). */
export const isSecretPath = (p: string): boolean => SECRET_PATH.test(p)

/** The file paths in a tool call's input (Claude: file_path, notebook_path, path; ACP: filePath, locations). */
export function inputPaths(input: unknown): string[] {
  if (!input || typeof input !== 'object') return []
  const o = input as Record<string, unknown>
  const locations = Array.isArray(o.locations) ? o.locations.map((l) => (l as { path?: unknown })?.path) : []
  return [o.file_path, o.notebook_path, o.path, o.filePath, ...locations].filter((v): v is string => typeof v === 'string')
}

/**
 * A request for a secret file is shown only while the setting asks for it. With the setting off, a session that
 * was started under the old rules must not keep asking, so the answer is decided per request, not per session.
 */
export const touchesSecretFile = (input: unknown): boolean => inputPaths(input).some(isSecretPath)
