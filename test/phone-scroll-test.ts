import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nextStick, type ScrollRead } from '../src/renderer/src/components/useStickToBottom'
import { fitViewport, type ViewportRead } from '../src/renderer/src/remote/viewport'

// a conversation 3000 px tall in a 600 px box: the end is at 2400
const at = (o: Partial<ScrollRead>): ScrollRead => ({ top: 2400, lastTop: 2400, scrollHeight: 3000, clientHeight: 600, byUser: false, stick: true, ...o })

test('following: the reader scrolling up lets go at once, a scroll down to the end follows again', () => {
  assert.equal(nextStick(at({ top: 2300, byUser: true })), false)
  assert.equal(nextStick(at({ top: 2390, byUser: true })), false, 'even 10 px up, inside the 120 px')
  assert.equal(nextStick(at({ top: 2350, lastTop: 2200, byUser: true, stick: false })), true, 'going down near the end')
  assert.equal(nextStick(at({ top: 2000, lastTop: 1900, byUser: true, stick: false })), false)
  assert.equal(nextStick(at({ top: 2400, lastTop: 2000, byUser: false, stick: false })), true, 'momentum reaching the very end')
  assert.equal(nextStick(at({ top: 2000, lastTop: 1500, byUser: false, stick: false })), false, 'momentum that stops short')
})

test('following: the elastic bounce past the end and a clamp keep following', () => {
  // an iPhone flick down lands past the end and springs back: the way back runs upwards
  assert.equal(nextStick(at({ top: 2440, lastTop: 2400, byUser: true })), true)
  assert.equal(nextStick(at({ top: 2400, lastTop: 2440, byUser: true })), true)
  // content got shorter just after a tap (the pending card swapped for the answer): the browser pulled the position back to the new end
  assert.equal(nextStick(at({ top: 2200, lastTop: 2400, scrollHeight: 2800, byUser: true })), true)
})

test('following: a position the chat set itself is not the reader scrolling', () => {
  // it jumped to 2400, then a code block of 400 px came in before the scroll event: 400 px from the end, inside the reader's 500 ms
  assert.equal(nextStick(at({ top: 2400, lastTop: 1800, scrollHeight: 3400, byUser: true, ours: 2400 })), true)
  // without knowing it was ours that read as the reader stopping 400 px short
  assert.equal(nextStick(at({ top: 2400, lastTop: 1800, scrollHeight: 3400, byUser: true })), false)
  // the reader really moved after the chat's jump: not ours any more
  assert.equal(nextStick(at({ top: 2000, lastTop: 2400, byUser: true, ours: 2400 })), false)
})

const vp = (o: Partial<ViewportRead>): ViewportRead => ({ typing: false, vvHeight: 844, vvTop: 0, full: 844, iphoneApp: false, screenW: 390, screenH: 844, landscape: false, ...o })

test('viewport: with no field in use the page fills the screen itself, whatever the visible area says', () => {
  // the keyboard went down but iOS still reports its height
  assert.deepEqual(fitViewport(vp({ vvHeight: 500, vvTop: 300 })), { follow: false, keyboard: false, floor: undefined })
  // a home screen app reporting the height without the status bar
  assert.deepEqual(fitViewport(vp({ vvHeight: 797, iphoneApp: true })), { follow: false, keyboard: false, floor: 844 })
  assert.equal(fitViewport(vp({ iphoneApp: true, landscape: true })).floor, 390, 'iOS keeps screen.height portrait when turned')
})

test('viewport: a field in use follows the visible area, a keyboard is a drop of more than 110 px', () => {
  assert.deepEqual(fitViewport(vp({ typing: true, vvHeight: 470, vvTop: 120 })), { follow: true, height: 470, top: 120, keyboard: true })
  // a hardware keyboard's bar: followed (it covers the box) but not a keyboard
  assert.deepEqual(fitViewport(vp({ typing: true, vvHeight: 800 })), { follow: true, height: 800, top: 0, keyboard: false })
})
