// Helpers for noticing a Claude sign-in that ended by itself (files only, no Electron here, so tests and the engine can load it).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Claude Code clears the refresh token on disk when the server refuses it (`invalid_grant`, e.g. the sign-in reached its time limit).
 * What is left is a credentials file with an empty refresh token. A profile that never signed in has no file, and a deliberate
 * sign-out removes the `claudeAiOauth` block, so neither counts as "lost".
 */
export function lostSignIn(credentials: unknown): boolean {
  const o = (credentials as { claudeAiOauth?: { refreshToken?: unknown; loginEnded?: unknown } } | null | undefined)?.claudeAiOauth
  if (!o || typeof o !== 'object') return false
  return o.refreshToken === '' || o.loginEnded === 'time_limit'
}

/** The account email Claude Code remembers for a config folder, to preselect it on the sign-in page. */
export function rememberedEmail(config: unknown): string | undefined {
  const e = (config as { oauthAccount?: { emailAddress?: unknown } } | null | undefined)?.oauthAccount?.emailAddress
  return typeof e === 'string' && /^[^\s@<>"']+@[^\s@<>"']+$/.test(e) ? e : undefined
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** The folder Claude Code keeps a profile's sign-in in (`dir` is the profile's own folder, none for the default one). */
export const claudeConfigDir = (dir: string | undefined): string => dir ?? path.join(os.homedir(), '.claude')

export const signedOutIn = (dir: string | undefined): boolean => lostSignIn(readJson(path.join(claudeConfigDir(dir), '.credentials.json')))

/** The email this folder was last signed in with, or undefined. The default folder may also keep it in the home folder. */
export function emailIn(dir: string | undefined): string | undefined {
  return rememberedEmail(readJson(path.join(claudeConfigDir(dir), '.claude.json'))) ?? (dir ? undefined : rememberedEmail(readJson(path.join(os.homedir(), '.claude.json'))))
}
