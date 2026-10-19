import assert from 'node:assert/strict'
import { test } from 'node:test'
import { autoUpdater, shown } from './updater-stubs'
import { current, init, install } from '../src/main/updater'

test('one restart lands on the newest release, even one published after the download', async () => {
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

  // 0.5.5 came out meanwhile: the restart fetches it first and installs once, with no extra notification
  autoUpdater.next = async () => {
    autoUpdater.emit('update-available', { version: '0.5.5' })
    const downloadPromise = new Promise((r) => setTimeout(r, 20)).then(() => autoUpdater.emit('update-downloaded', { version: '0.5.5' }))
    return { isUpdateAvailable: true, updateInfo: { version: '0.5.5' }, downloadPromise }
  }
  await install()
  assert.deepEqual([autoUpdater.installs, current().version, shown.length], [1, '0.5.5', 1])

  // offline at restart: what is downloaded still installs
  autoUpdater.next = () => Promise.reject(new Error('offline'))
  await install()
  assert.equal(autoUpdater.installs, 2)
})
