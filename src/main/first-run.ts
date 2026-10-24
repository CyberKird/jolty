import type { Profile } from '@shared/types'
import { freeColor } from './store'

/**
 * The profiles at start-up: the ones saved, plus Hermes and OpenCode when they are installed (they bring their
 * own model and key). Claude and Codex are never added here: a new user picks a way to connect on the welcome
 * screen, and the profiles of an existing user are returned as they are.
 */
export function withDetectedAgents(profiles: Profile[], found: { hermes: boolean; opencode: boolean }): Profile[] {
  const out = [...profiles]
  if (found.hermes && !out.some((p) => p.engine === 'hermes')) out.push({ id: 'hermes-main', name: 'Hermes', engine: 'hermes', auth: 'existing', isDefaultDir: true, color: freeColor(out) })
  if (found.opencode && !out.some((p) => p.engine === 'opencode')) out.push({ id: 'opencode-main', name: 'OpenCode', engine: 'opencode', auth: 'existing', isDefaultDir: true, color: freeColor(out) })
  return out
}
