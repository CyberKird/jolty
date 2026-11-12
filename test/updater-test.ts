import assert from 'node:assert/strict'
import { test } from 'node:test'
import { autoUpdater, shown } from './updater-stubs'
import { current, init, install, setAuto } from '../src/main/updater'

test('the restart installs the version shown; a newer one is found by a check, shown, and then installed', async () => {
  init(() => undefined, () => undefined)
  autoUpdater.emit('update-available', { version: '0.5.4' })
  assert.equal(current().state, 'downloading')
  autoUpdater.emit('update-downloaded', { version: '0.5.4' })
  assert.equal(current().state, 'ready')
  assert.equal(shown.length, 1)

  // the hourly check finds the same version in the download cache: the restart button stays, no second notification
  autoUpdater.emit('checking-for-update')
  autoUpdater.emit('update-available', { version: '0.5.4' })
  autoUpdater.emit('update-downloaded', { version: '0.5.4' })
  assert.deepEqual([current().state, current().version, shown.length], ['ready', '0.5.4', 1])

  // a failed check never hides the downloaded update
  autoUpdater.emit('error', new Error('offline'))
  assert.equal(current().state, 'ready')

  // 0.5.5 came out meanwhile: the restart does not go looking for it, it installs what the card shows
  autoUpdater.next = () => Promise.reject(new Error('the restart must not check again'))
  await install()
  assert.deepEqual([autoUpdater.installs, current().version], [1, '0.5.4'])

  // a check (the search button, the hourly one) finds 0.5.5: the card shows it, and the next restart installs that one
  autoUpdater.emit('update-available', { version: '0.5.5' })
  assert.deepEqual([current().state, current().version], ['downloading', '0.5.5'])
  autoUpdater.emit('update-downloaded', { version: '0.5.5' })
  assert.deepEqual([current().state, current().version], ['ready', '0.5.5'])
  await install()
  assert.equal(autoUpdater.installs, 2)
})

test('with automatic updates off, a found version waits for Update, then downloads and installs once', async () => {
  const installs = autoUpdater.installs
  init(() => undefined, () => undefined, false)
  assert.equal(autoUpdater.autoDownload, false)
  assert.equal(autoUpdater.autoInstallOnAppQuit, false)
  autoUpdater.emit('update-available', { version: '0.6.0' })
  assert.deepEqual([current().state, current().version, autoUpdater.downloads], ['available', '0.6.0', 0])

  autoUpdater.pending = '0.6.0'
  await install()
  assert.deepEqual([autoUpdater.downloads, autoUpdater.installs, current().state], [1, installs + 1, 'ready'])

  // switching it back on downloads by itself again
  setAuto(true)
  assert.equal(autoUpdater.autoDownload, true)
  assert.equal(autoUpdater.autoInstallOnAppQuit, true)
})
