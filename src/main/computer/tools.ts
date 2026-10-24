// The computer tools models can call: looking (screenshot, zoom, windows, UI tree), moving between windows and
// the clipboard here; the ones that press and type are in tools-act.ts.
import path from 'path'
import { displayOfRect, toPhysical, toPicture, type DisplayInfo } from './geometry'
import type { WinInfo } from './helper'
import { blockedReason } from './policy'
import { ACT_TOOLS } from './tools-act'
import { image, num, obj, str, text, UserError, type ToolDef } from './result'
import type { ComputerService, Session } from './service'

const READ = { readOnlyHint: true }

/** Where a window is, in the pixels of the latest screenshot. */
function where(svc: ComputerService, s: Session, w: WinInfo, displays: DisplayInfo[]): string {
  if (w.minimized) return 'minimized'
  const v = svc.ensureView(s)
  const d = displayOfRect(displays, w)
  if (!d || d.index !== v.display.index) return d ? `on display ${d.index} (not in the latest screenshot)` : 'off screen'
  const p = toPicture(v, w.x, w.y)
  return `at (${p.x}, ${p.y}) size ${Math.round(w.w * v.scale)}x${Math.round(w.h * v.scale)}`
}

const flags = (w: WinInfo): string => [w.focused ? 'in front' : '', w.maximized ? 'maximized' : ''].filter(Boolean).join(', ')

export const TOOLS: ToolDef[] = [
  {
    name: 'computer_screenshot',
    description:
      'Takes a screenshot of one display (default: the primary one) with the mouse pointer drawn in. All coordinates you use afterwards are pixels of this image, origin top-left. The answer lists the displays, the pointer position and the window in front.',
    inputSchema: obj({ display: { type: 'number', description: 'Display index from the list in a previous answer (0 = primary). Default: primary.' } }),
    annotations: READ,
    async run(svc, s, a) {
      const st = await svc.begin(s, 'read')
      const displays = svc.capturer.displays()
      const index = a.display === undefined ? Math.max(0, displays.findIndex((d) => d.primary)) : num(a.display, 'display', { min: 0, max: displays.length - 1 })
      const d = displays[index]
      if (!d) throw new UserError(`No display ${index}. Displays: ${displays.map((x) => x.index).join(', ')}.`)
      const shot = await svc.capturer.grab(d, undefined, { x: st.x, y: st.y })
      svc.setView(s, shot.view)
      s.seenFg = st.foreground?.hwnd ?? 0
      const v = shot.view
      const cur = toPicture(v, st.x, st.y)
      const onIt = cur.x >= 0 && cur.y >= 0 && cur.x < v.width && cur.y < v.height
      return {
        content: [
          { type: 'text', text: [
            `Screenshot of display ${d.index}${d.primary ? ' (primary)' : ''}: ${v.width}x${v.height} px (the display is ${d.w}x${d.h} physical px). Coordinates: pixels of this image, origin top-left, x to the right, y down.`,
            `Pointer: ${onIt ? `at (${cur.x}, ${cur.y})` : 'not on this display'}.`,
            st.foreground ? `Window in front: "${st.foreground.title}" (${st.foreground.exe}), ${where(svc, s, st.foreground, displays)}.` : 'No window is in front.',
            `Displays: ${displays.map((x) => `${x.index}${x.primary ? ' primary' : ''} ${x.w}x${x.h} at ${x.x},${x.y}`).join(' | ')}.`
          ].join('\n') },
          image(shot.jpeg)
        ]
      }
    }
  },
  {
    name: 'computer_zoom',
    description: 'Looks closer at a rectangle of the latest screenshot (small print, icons) and returns it enlarged. Coordinates stay those of the screenshot; this does not change them.',
    inputSchema: obj(
      { x: { type: 'number', description: 'Left edge, screenshot pixels' }, y: { type: 'number', description: 'Top edge' }, width: { type: 'number' }, height: { type: 'number' } },
      ['x', 'y', 'width', 'height']
    ),
    annotations: READ,
    async run(svc, s, a) {
      const st = await svc.begin(s, 'read')
      const v = svc.needView(s)
      const x = num(a.x, 'x', { min: 0, max: v.width - 1 })
      const y = num(a.y, 'y', { min: 0, max: v.height - 1 })
      const w = Math.min(num(a.width, 'width', { min: 8 }), v.width - x)
      const h = Math.min(num(a.height, 'height', { min: 8 }), v.height - y)
      const tl = toPhysical(v, x, y)
      const region = { x: tl.x, y: tl.y, w: Math.max(1, Math.round(w / v.scale)), h: Math.max(1, Math.round(h / v.scale)) }
      const shot = await svc.capturer.grab(v.display, region, { x: st.x, y: st.y })
      const zoom = shot.view.scale / v.scale
      s.lookedSinceAct = true
      return {
        content: [
          { type: 'text', text: `Zoomed on screenshot region x=${x}, y=${y}, ${w}x${h}: this image is ${shot.view.width}x${shot.view.height}, ${zoom.toFixed(2)}x. A point (px, py) in it is (${x} + px/${zoom.toFixed(3)}, ${y} + py/${zoom.toFixed(3)}) in screenshot coordinates; click using those, not the zoomed ones.` },
          image(shot.jpeg)
        ]
      }
    }
  },
  {
    name: 'computer_windows',
    description: 'Lists the open windows from front to back: id (hwnd), title, program, position in screenshot pixels, and which one is in front. Use the id with computer_focus_window.',
    inputSchema: obj({}),
    annotations: READ,
    async run(svc, s) {
      const st = await svc.begin(s, 'read')
      const displays = svc.capturer.displays()
      const list = await svc.input.windows()
      s.seenFg = st.foreground?.hwnd ?? 0
      const lines = list.slice(0, 40).map((w) => `- id ${w.hwnd}: "${w.title.slice(0, 90)}" (${w.exe || 'unknown'}) ${where(svc, s, w, displays)}${flags(w) ? `; ${flags(w)}` : ''}`)
      return text(`${list.length} windows, front to back:\n${lines.join('\n')}`, s.view ? '' : 'Positions use the primary display until you take a screenshot.')
    }
  },
  {
    name: 'computer_focus_window',
    description: 'Brings a window to the front (and restores it if minimized). Give its id from computer_windows, or part of its title.',
    inputSchema: obj({ id: { type: 'number', description: 'Window id from computer_windows' }, title: { type: 'string', description: 'Part of the window title (when no id)' } }),
    async run(svc, s, a) {
      const st = await svc.begin(s, 'act')
      const list = await svc.input.windows()
      const win =
        a.id !== undefined ? list.find((w) => w.hwnd === num(a.id, 'id')) : list.find((w) => w.title.toLowerCase().includes(str(a.title, 'title').toLowerCase()))
      if (!win) throw new UserError('No such window. List them with computer_windows.')
      await svc.authorize(s, win, st, { title: `Bring "${win.title}" to the front`, detail: `${win.exe}` })
      svc.overlay.active(svc.ensureView(s).display)
      const ok = await svc.input.focus(win.hwnd)
      svc.acted(s)
      const note = await svc.afterAction(s, 220)
      return text(ok ? `Brought "${win.title}" to the front.` : `Asked Windows to bring "${win.title}" to the front, but it did not come (another program may hold the focus).`, note)
    }
  },
  {
    name: 'computer_open_app',
    description: 'Starts a program or opens a file or link the way the Start menu or Explorer would: a program name (notepad, calc), a full path, or a link (https://..., ms-settings:). No arguments. Asks the user every time.',
    inputSchema: obj({ target: { type: 'string', description: 'Program name, path, or link' } }, ['target']),
    async run(svc, s, a) {
      const st = await svc.begin(s, 'act')
      const target = str(a.target, 'target').trim()
      // eslint-disable-next-line no-control-regex
      if (target.length > 400 || /[\u0000-\u001f]/.test(target)) throw new UserError('That is not a program name, path or link.')
      if (st.secure) throw new UserError(blockedReason({ exe: '', title: '' }, true) as string)
      await svc.confirmEach(s, { title: `Open ${target}`, detail: target })
      const before = new Set((await svc.input.windows()).map((w) => w.hwnd))
      const pid = await svc.input.launch(target)
      svc.acted(s)
      let opened: WinInfo | undefined
      for (let i = 0; i < 28 && !opened; i++) {
        await svc.sleep(300)
        opened = (await svc.input.windows()).find((w) => !before.has(w.hwnd))
      }
      const note = await svc.afterAction(s, 200)
      return text(
        opened ? `Started ${path.basename(target)}${pid > 0 ? ` (process ${pid})` : ''}. A new window appeared: id ${opened.hwnd} "${opened.title}" (${opened.exe}).` : `Started ${target}${pid > 0 ? ` (process ${pid})` : ''}, but no new window showed up yet.`,
        note
      )
    }
  },
  {
    name: 'computer_ui_tree',
    description:
      'Lists the controls of a window (the one in front by default) from Windows UI Automation: type, name, automation id, center position in screenshot pixels, size, state. More exact than reading positions off the picture. Password fields are marked and their values never shown. Some programs (games, custom-drawn apps) expose little.',
    inputSchema: obj({ id: { type: 'number', description: 'Window id from computer_windows. Default: the window in front.' }, max_nodes: { type: 'number', description: 'Default 150, up to 400' } }),
    annotations: READ,
    async run(svc, s, a) {
      const st = await svc.begin(s, 'read')
      const hwnd = a.id !== undefined ? num(a.id, 'id') : (st.foreground?.hwnd ?? 0)
      const win = (await svc.input.windows()).find((w) => w.hwnd === hwnd) ?? (st.foreground?.hwnd === hwnd ? st.foreground : undefined)
      if (!win) throw new UserError('No such window. List them with computer_windows.')
      const blocked = blockedReason({ exe: win.exe, title: win.title, cls: win.cls }, st.secure)
      if (blocked) throw new UserError(blocked)
      const max = Math.min(400, num(a.max_nodes, 'max_nodes', { def: 150, min: 10 }))
      const r = await svc.input.uiTree(hwnd, max, 14)
      if (r.error && !r.nodes.length) throw new UserError(`The window did not give its controls: ${r.error}`)
      const v = svc.ensureView(s)
      s.seenFg = st.foreground?.hwnd ?? 0
      const lines = r.nodes.map((n, i) => {
        const c = toPicture(v, n.x + n.w / 2, n.y + n.h / 2)
        const bits = [n.password ? 'PASSWORD FIELD' : '', n.enabled ? '' : 'disabled', n.focus ? 'focused' : ''].filter(Boolean)
        return `${'  '.repeat(Math.min(n.d, 6))}[${i}] ${n.type}${n.name ? ` "${n.name.slice(0, 80)}"` : ''}${n.id ? ` id=${n.id}` : ''} @(${c.x}, ${c.y}) ${Math.round(n.w * v.scale)}x${Math.round(n.h * v.scale)}${bits.length ? ` [${bits.join(', ')}]` : ''}${n.value && !n.password ? ` value="${n.value.replace(/\s+/g, ' ')}"` : ''}`
      })
      const note = [r.truncated ? `Cut after ${r.nodes.length} controls; ask for another window or raise max_nodes.` : '', r.error ? `(${r.error})` : '', win.focused ? '' : 'This window is not in front.'].filter(Boolean).join(' ')
      return text(`Controls of "${win.title}" (${win.exe}); @(x, y) is the center in screenshot pixels${s.view ? '' : ' of the primary display (take a screenshot before clicking)'}:\n${lines.join('\n') || '(none exposed)'}`, note)
    }
  },
  {
    name: 'computer_wait',
    description: 'Waits (for a window to open, a page to load) up to 30 seconds. Take a screenshot afterwards.',
    inputSchema: obj({ seconds: { type: 'number', description: '0.2 to 30' } }, ['seconds']),
    annotations: READ,
    async run(svc, s, a) {
      await svc.begin(s, 'read')
      const total = num(a.seconds, 'seconds', { min: 0.2, max: 30 }) * 1000
      for (let t = 0; t < total; t += 500) {
        await svc.sleep(Math.min(500, total - t))
        if (svc.stopped(s.sid)) throw new UserError('Stopped.')
      }
      return text(`Waited ${(total / 1000).toFixed(1)} s.`)
    }
  },
  {
    name: 'computer_clipboard',
    description: 'Reads the clipboard text, or replaces it. Asks the user every time.',
    inputSchema: obj({ action: { type: 'string', enum: ['read', 'write'] }, text: { type: 'string', description: 'The text to put on the clipboard (write)' } }, ['action']),
    async run(svc, s, a) {
      await svc.begin(s, 'act')
      const write = a.action === 'write'
      if (!write && a.action !== 'read') throw new UserError('"action" is read or write')
      const body = write ? str(a.text, 'text') : ''
      await svc.confirmEach(s, { title: write ? 'Replace the clipboard' : 'Read the clipboard', detail: write ? body.slice(0, 400) : undefined })
      svc.acted(s)
      if (write) {
        await svc.host.clipboard.writeText(body)
        return text(`Clipboard replaced (${body.length} characters).`)
      }
      const t = await svc.host.clipboard.readText()
      return text(t ? `Clipboard text (${t.length} characters):\n${t.length > 20000 ? t.slice(0, 20000) + '\n[cut]' : t}` : (await svc.host.clipboard.hasImage()) ? 'The clipboard holds an image, not text.' : 'The clipboard is empty.')
    }
  },
  ...ACT_TOOLS
]

