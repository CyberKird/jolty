// Imported by index.ts before anything else reads the data folder: a restore downloaded in the last run is moved
// in place now, so settings, language, chats and profiles load from it.
import os from 'os'
import { dataDir } from '../store'
import { applyPendingRestore } from './vault-apply'

try {
  applyPendingRestore(dataDir(), os.homedir())
} catch (e) {
  // what was moved stays moved; the rest is tried again at the next start
  console.error('restore', e)
}
