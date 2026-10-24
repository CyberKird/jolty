// The tools that move the pointer, press buttons and type. Each builds a timed plan from the human models and
// hands it to the helper in one piece; the gate in service.ts decides first whether it may run at all.
import { clickPoint, chordPlan, clickPlan, dragPlan, later, movePlan, parseCombo, planEnd, scrollPlan, typeDuration, typePlan, type Button, type Ev } from './plan'
import { isTerminal, reachesPastApp, secretField } from './policy'
import { num, obj, str, text, UserError, type ToolDef } from './result'
import type { ComputerService, Session } from './service'
import type { HelperState, WinInfo } from './helper'

const BUTTONS = ['left', 'right', 'middle']
const XY = { x: { type: 'number', description: 'Screenshot pixel, from the left' }, y: { type: 'number', description: 'Screenshot pixel, from the top' } }
const SIZE = {
  w: { type: 'number', description: 'Width of the thing you click, in screenshot pixels (from computer_ui_tree). Optional: lets the click land naturally inside it and sets how carefully the pointer approaches.' },
  h: { type: 'number', description: 'Height of the thing you click. Optional.' }
}

const button = (v: unknown): Button => {
  const b = v === undefined ? 'left' : String(v)
  if (!BUTTONS.includes(b)) throw new UserError('"button" is left, right or middle')
  return b as Button
}

/** Waits for a fresh look at the machine after an approval, since the user may have taken a while. */
async function fresh(svc: ComputerService, s: Session): Promise<HelperState> {
  const st = await svc.input.state()
  svc.checkFront(s, st)
  return st
}

const needFront = (st: HelperState): WinInfo => {
  if (!st.foreground) throw new UserError('No window is in front. Take a screenshot, then focus one with computer_focus_window.')
  return st.foreground
}

/** The key combo as a short readable string for messages. */
const pretty = (combo: string): string => combo.split('+').map((p) => p.trim()).join('+')

export const ACT_TOOLS: ToolDef[] = [
  {
    name: 'computer_mouse_move',
    description: 'Moves the pointer to a point of the latest screenshot (hover, to reveal a menu or tooltip). Takes a human-like curved path.',
    inputSchema: obj({ ...XY, ...SIZE }, ['x', 'y']),
    annotations: { readOnlyHint: true },
    async run(svc, s, a) {
      const st = await svc.begin(s, 'read')
      const v = svc.needView(s)
      const at = svc.physical(s, num(a.x, 'x'), num(a.y, 'y'))
      const mode = svc.host.settings().human
      const w = Number.isFinite(num(a.w, 'w', { optional: true })) ? num(a.w, 'w') / v.scale : undefined
      await svc.readingPause(s, st)
      await svc.perform(s, movePlan(st, at, mode, svc.rng, w))
      const under = await svc.input.windowAt(at.x, at.y)
      return text(`Moved the pointer to (${a.x}, ${a.y})${under ? `, over "${under.title}" (${under.exe})` : ''}.`)
    }
  },
  {
    name: 'computer_click',
    description:
      'Clicks at a point of the latest screenshot: the pointer travels there on a human-paced curve, rests a moment, then presses. Use count 2 for a double click. Optionally hold modifier keys (ctrl, shift, alt) during the click. Works on the window under the point; asks the user once per application.',
    inputSchema: obj(
      { ...XY, ...SIZE, button: { type: 'string', enum: BUTTONS, description: 'Default left' }, count: { type: 'number', description: '1 (default), 2 or 3' }, hold: { type: 'string', description: 'Modifier keys held during the click, like "ctrl" or "ctrl+shift"' } },
      ['x', 'y']
    ),
    async run(svc, s, a) {
      const st = await svc.begin(s, 'act')
      const v = svc.needView(s)
      const target = svc.physical(s, num(a.x, 'x'), num(a.y, 'y'))
      const btn = button(a.button)
      const count = Math.round(num(a.count, 'count', { def: 1, min: 1, max: 3 }))
      svc.checkFront(s, st)
      const mode = svc.host.settings().human
      const w = Number.isFinite(num(a.w, 'w', { optional: true })) ? num(a.w, 'w') / v.scale : undefined
      const h = Number.isFinite(num(a.h, 'h', { optional: true })) ? num(a.h, 'h') / v.scale : undefined
      const land = clickPoint(target, mode, svc.rng, w, h)
      const win = await svc.input.windowAt(land.x, land.y)
      const what = `${count === 2 ? 'Double-click' : count === 3 ? 'Triple-click' : btn === 'left' ? 'Click' : `${btn[0].toUpperCase()}${btn.slice(1)}-click`} in ${win?.exe || 'a window'}`
      await svc.authorize(s, win, st, { title: what, detail: `${win?.title ?? ''} at (${a.x}, ${a.y})` })
      const now = await fresh(svc, s)
      await svc.readingPause(s, now)
      const mods = typeof a.hold === 'string' && a.hold ? parseCombo(a.hold) : []
      const path = movePlan(now, land, mode, svc.rng, w)
      const arrive = planEnd(path)
      const click = later(clickPlan(btn, count, mode, svc.rng), arrive + (mode === 'fast' ? 10 : 25))
      const last = planEnd(click)
      const events: Ev[] = [
        ...path,
        ...mods.map((m, i): Ev => ['k', Math.max(0, arrive - 30) + i * 12, m, 1, 0]),
        ...click,
        ...[...mods].reverse().map((m, i): Ev => ['k', last + 25 + i * 14, m, 0, 0])
      ]
      await svc.perform(s, events)
      svc.overlay.pulse(land.x, land.y)
      svc.acted(s)
      const note = await svc.afterAction(s)
      return text(`${count > 1 ? `${count} clicks` : 'Clicked'} (${btn}) at (${a.x}, ${a.y}).`, note)
    }
  },
  {
    name: 'computer_drag',
    description: 'Presses at one point, carries the pointer to another and lets go (move a window, select text, drag a file). Points are pixels of the latest screenshot.',
    inputSchema: obj({ x: XY.x, y: XY.y, to_x: { type: 'number', description: 'Where to let go, screenshot pixel from the left' }, to_y: { type: 'number', description: 'Where to let go, from the top' }, button: { type: 'string', enum: BUTTONS } }, ['x', 'y', 'to_x', 'to_y']),
    async run(svc, s, a) {
      const st = await svc.begin(s, 'act')
      svc.needView(s)
      const from = svc.physical(s, num(a.x, 'x'), num(a.y, 'y'))
      const to = svc.physical(s, num(a.to_x, 'to_x'), num(a.to_y, 'to_y'))
      const btn = button(a.button)
      svc.checkFront(s, st)
      const mode = svc.host.settings().human
      const start = clickPoint(from, mode, svc.rng)
      const end = clickPoint(to, mode, svc.rng)
      const w1 = await svc.input.windowAt(start.x, start.y)
      await svc.authorize(s, w1, st, { title: `Drag in ${w1?.exe || 'a window'}`, detail: `from (${a.x}, ${a.y}) to (${a.to_x}, ${a.to_y})` })
      const w2 = await svc.input.windowAt(end.x, end.y)
      if (w2 && w1 && w2.exe !== w1.exe) await svc.authorize(s, w2, st, { title: `Drop into ${w2.exe}`, detail: `${w2.title} at (${a.to_x}, ${a.to_y})` })
      const now = await fresh(svc, s)
      await svc.readingPause(s, now)
      const approach = movePlan(now, start, mode, svc.rng)
      const arrive = planEnd(approach)
      const events: Ev[] = [...approach, ...later(dragPlan(start, end, btn, mode, svc.rng), arrive + (mode === 'fast' ? 10 : between(svc, 40, 140)))]
      await svc.perform(s, events)
      svc.overlay.pulse(end.x, end.y)
      svc.acted(s)
      return text(`Dragged from (${a.x}, ${a.y}) to (${a.to_x}, ${a.to_y}).`, await svc.afterAction(s))
    }
  },
  {
    name: 'computer_scroll',
    description: 'Scrolls with the mouse wheel in notches, with a short flick-like slowdown. Optionally moves the pointer to a point first (scrolling works on the thing under the pointer).',
    inputSchema: obj({ x: XY.x, y: XY.y, direction: { type: 'string', enum: ['down', 'up', 'right', 'left'], description: 'Default down' }, amount: { type: 'number', description: 'Wheel notches, 1 to 40 (default 3)' } }),
    annotations: { readOnlyHint: true },
    async run(svc, s, a) {
      const st = await svc.begin(s, 'read')
      const mode = svc.host.settings().human
      const dir = a.direction === undefined ? 'down' : String(a.direction)
      if (!['down', 'up', 'left', 'right'].includes(dir)) throw new UserError('"direction" is down, up, left or right')
      const amount = Math.round(num(a.amount, 'amount', { def: 3, min: 1, max: 40 }))
      const moves: Ev[] = []
      let lead = 0
      let pos = { x: st.x, y: st.y }
      if (a.x !== undefined || a.y !== undefined) {
        svc.needView(s)
        pos = svc.physical(s, num(a.x, 'x'), num(a.y, 'y'))
        await svc.readingPause(s, st)
        moves.push(...movePlan(st, pos, mode, svc.rng))
        lead = planEnd(moves) + (mode === 'fast' ? 10 : 70)
      }
      const signed = dir === 'down' || dir === 'right' ? amount : -amount
      await svc.perform(s, [...moves, ...later(scrollPlan(signed, dir === 'left' || dir === 'right', mode, svc.rng), lead)])
      const under = await svc.input.windowAt(pos.x, pos.y)
      return text(`Scrolled ${dir} by ${amount} notch${amount > 1 ? 'es' : ''}${under ? ` over "${under.title}"` : ''}. Take a screenshot to see the result.`)
    }
  },
  {
    name: 'computer_type',
    description:
      'Types text into the window in front, one key at a time with human rhythm (pauses at word and sentence ends, rare slips that it corrects itself). The focus must already be in the field: click it first. Newlines press Enter. Refuses password fields. In a terminal the user is asked about every command.',
    inputSchema: obj({ text: { type: 'string', description: 'What to type' }, paste: { type: 'boolean', description: 'Paste through the clipboard instead of typing; only honoured when the user allowed it in Settings, for long text' } }, ['text']),
    async run(svc, s, a) {
      const st = await svc.begin(s, 'act')
      const body = str(a.text, 'text')
      if (body.length > 20000) throw new UserError('Too much text for one call (limit 20,000 characters). Split it.')
      svc.checkFront(s, st)
      const fg = needFront(st)
      const terminal = isTerminal(fg)
      const settings = svc.host.settings()
      await svc.authorize(s, fg, st, {
        title: terminal ? `Type into a terminal (${fg.exe})` : `Type in ${fg.exe}`,
        detail: body.length > 600 ? `${body.slice(0, 600)}... (${body.length} characters)` : body,
        always: terminal
      })
      const now = await fresh(svc, s)
      if (secretField(await svc.input.focused())) throw new UserError('The field that has the focus holds a password or another secret. Jolty never types there; ask the user to type it.')
      await svc.readingPause(s, now)
      const front = needFront(now).hwnd
      if (a.paste === true && settings.paste && body.length >= 80) {
        if (await svc.host.clipboard.hasImage()) throw new UserError('The clipboard holds an image that pasting would replace. Type the text instead.')
        const keep = await svc.host.clipboard.readText()
        await svc.host.clipboard.writeText(body)
        try {
          await svc.perform(s, chordPlan(parseCombo('ctrl+v'), 1, settings.human, svc.rng), { guard: front })
          await svc.sleep(250)
        } finally {
          await svc.host.clipboard.writeText(keep)
        }
        svc.acted(s)
        return text(`Pasted ${body.length} characters.`, await svc.afterAction(s))
      }
      let chars = body
      const typos = settings.human === 'max' && body.length >= 12 && body.includes(' ') && !terminal
      let speed = 1
      let events = typePlan(chars, settings.human, svc.rng, typos)
      // one call has to finish inside the engine's tool timeout: a long text is typed faster, and cut if it still does not fit
      const budget = 50000
      if (typeDuration(events) > budget) {
        speed = Math.min(3, typeDuration(events) / budget)
        events = typePlan(chars, settings.human, svc.rng, typos, speed)
      }
      let rest = ''
      if (typeDuration(events) > budget) {
        const keep = Math.max(1, Math.floor((chars.length * budget) / typeDuration(events)))
        const cut = chars.lastIndexOf(' ', keep)
        const at = cut > keep * 0.6 ? cut + 1 : keep
        rest = chars.slice(at)
        chars = chars.slice(0, at)
        events = typePlan(chars, settings.human, svc.rng, typos, speed)
      }
      await svc.perform(s, events, { guard: front })
      svc.acted(s)
      return text(
        rest ? `Typed the first ${chars.length} of ${body.length} characters (one call has a time limit). Call computer_type again with the rest, starting at: ${JSON.stringify(rest.slice(0, 40))}.` : `Typed ${chars.length} characters.`,
        await svc.afterAction(s)
      )
    }
  },
  {
    name: 'computer_key',
    description:
      'Presses a key or a chord in the window in front: "enter", "tab", "esc", "ctrl+c", "ctrl+shift+t", "alt+f4", "f5", "pagedown". Modifiers are held in the right order and released in reverse. Use repeat for several presses. Chords with the Windows key ask the user every time.',
    inputSchema: obj({ keys: { type: 'string', description: 'Key or combo joined with +' }, repeat: { type: 'number', description: 'How many times (1 to 20)' } }, ['keys']),
    async run(svc, s, a) {
      const st = await svc.begin(s, 'act')
      const combo = str(a.keys, 'keys')
      const vks = parseCombo(combo)
      const repeat = Math.round(num(a.repeat, 'repeat', { def: 1, min: 1, max: 20 }))
      svc.checkFront(s, st)
      const fg = needFront(st)
      const mode = svc.host.settings().human
      if (reachesPastApp(vks)) await svc.confirmEach(s, { title: `Press ${pretty(combo)}`, detail: 'A shortcut with the Windows key acts on the whole PC.' })
      else {
        const sends = vks.includes(0x0d) && isTerminal(fg)
        await svc.authorize(s, fg, st, { title: `Press ${pretty(combo)} in ${fg.exe}`, always: sends })
      }
      const now = await fresh(svc, s)
      // a letter, digit or paste could put a secret somewhere: same rule as typing
      const inserts = vks.length === 1 ? (vks[0] >= 0x30 && vks[0] <= 0x5a) || vks[0] === 0x20 : vks.includes(0x56) && vks.includes(0x11)
      if (inserts && secretField(await svc.input.focused())) throw new UserError('The field that has the focus holds a password or another secret. Jolty never types or pastes there.')
      await svc.readingPause(s, now)
      await svc.perform(s, chordPlan(vks, repeat, mode, svc.rng), { guard: needFront(now).hwnd })
      svc.acted(s)
      return text(`Pressed ${pretty(combo)}${repeat > 1 ? ` x${repeat}` : ''}.`, await svc.afterAction(s))
    }
  }
]

function between(svc: ComputerService, lo: number, hi: number): number {
  return lo + (hi - lo) * svc.rng()
}
