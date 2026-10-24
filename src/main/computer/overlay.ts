// What the user sees while a model drives the PC: a thin volt glow around the active display and a "Jolty"
// pointer that follows the injected cursor, in the same look as the browser overlay. The windows are click-through,
// never take focus and are excluded from screen capture, so the model's screenshots do not show them.
import { BrowserWindow, screen } from 'electron'
import { tr } from '@shared/i18n'
import type { DisplayInfo } from './geometry'

export interface Overlay {
  /** the model is acting on this display: glow and pointer on */
  active(display: DisplayInfo): void
  /** what the model is doing right now (shown in the pill), and the window it works in (outlined); both clear when it goes quiet */
  say(text: string, win?: { x: number; y: number; w: number; h: number }): void
  /** a click happened at this physical position */
  pulse(x: number, y: number): void
  /** the user took control (or the agent waits for them) */
  paused(on: boolean): void
  /** the model stopped: fade out */
  idle(): void
  destroy(): void
}

const PAGE = String.raw`<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;height:100%;overflow:hidden;background:transparent;font:600 12px/1.3 system-ui,sans-serif}
#g{position:fixed;inset:0;opacity:0;transition:opacity .6s ease;box-shadow:inset 0 0 0 2px rgba(212,255,0,.9),inset 0 0 70px 8px rgba(212,255,0,.26),inset 0 0 180px 24px rgba(212,255,0,.1);animation:p 1.8s ease-in-out infinite alternate}
#g.off{box-shadow:inset 0 0 0 2px rgba(255,170,60,.95),inset 0 0 70px 8px rgba(255,170,60,.28)}
@keyframes p{from{filter:brightness(.65)}to{filter:brightness(1.1)}}
#w{position:fixed;left:0;top:0;width:0;height:0;box-sizing:border-box;border:2px solid rgba(212,255,0,.9);border-radius:10px;opacity:0;pointer-events:none;box-shadow:0 0 0 1px rgba(11,11,11,.55),0 0 30px 2px rgba(212,255,0,.32),inset 0 0 40px rgba(212,255,0,.07);transition:left .4s cubic-bezier(.22,1,.36,1),top .4s cubic-bezier(.22,1,.36,1),width .4s cubic-bezier(.22,1,.36,1),height .4s cubic-bezier(.22,1,.36,1),opacity .3s}
#c{position:fixed;left:0;top:0;opacity:0;transition:opacity .3s,transform 70ms linear;will-change:transform}
#cs{transform-origin:3px 3px}
#c b{position:absolute;left:16px;top:20px;padding:2px 7px;border-radius:9px;background:#d4ff00;color:#0b0b0b;white-space:nowrap}
#s{position:fixed;top:14px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:8px;padding:6px 14px 6px 10px;border-radius:16px;background:rgba(11,11,11,.86);color:#d4ff00;opacity:0;transition:opacity .4s,box-shadow .3s;white-space:nowrap;box-shadow:0 0 0 1px rgba(212,255,0,.5),0 6px 22px rgba(0,0,0,.4)}
#s.off{color:#ffaa3c;box-shadow:0 0 0 1px rgba(255,170,60,.6),0 6px 22px rgba(0,0,0,.4)}
#s svg{flex:none;animation:z 1.4s ease-in-out infinite}
@keyframes z{50%{transform:scale(1.18);filter:drop-shadow(0 0 4px rgba(212,255,0,.9))}}
#s.off svg{animation:none;opacity:.7}
#a{font-weight:700;display:none}
#k{font-weight:500;opacity:.62}
#s[data-act="1"] #a{display:inline}
#s[data-act="1"] #k{padding-left:8px;border-left:1px solid rgba(212,255,0,.3)}
.r{position:fixed;width:30px;height:30px;box-sizing:border-box;border:2px solid #d4ff00;border-radius:50%;pointer-events:none;box-shadow:0 0 12px rgba(212,255,0,.55)}
</style><div id="g"></div><div id="w"></div><div id="c"><div id="cs"><svg width="20" height="24" viewBox="0 0 13 20" style="display:block;filter:drop-shadow(0 2px 3px rgba(0,0,0,.45))"><path d="M1 1v15l4-3.6 2.8 6.3 2.4-1.1L7.4 11.4H13z" fill="#d4ff00" stroke="#0b0b0b" stroke-width="1.2" stroke-linejoin="round"/></svg></div><b>Jolty</b></div><div id="s"><svg width="12" height="14" viewBox="0 0 32 32"><path d="M18 2 6 18h8l-2 12 14-18h-8z" fill="#d4ff00"/></svg><span id="a"></span><span id="k"></span></div>
<script>
const g=document.getElementById('g'),c=document.getElementById('c'),cs=document.getElementById('cs'),s=document.getElementById('s'),a=document.getElementById('a'),k=document.getElementById('k'),w=document.getElementById('w');
window.__say=(t)=>{if(a.textContent===t)return;a.textContent=t;s.dataset.act=t?'1':'';if(t)s.animate([{transform:'translateX(-50%) scale(.92)',opacity:.35},{transform:'translateX(-50%) scale(1)',opacity:1}],{duration:200,easing:'cubic-bezier(.22,1,.36,1)'})};
window.__on=(h,t)=>{g.style.opacity=1;c.style.opacity=1;s.style.opacity=1;g.className='';s.className='';k.textContent=h;window.__say(t||'')};
window.__off=()=>{g.style.opacity=0;c.style.opacity=0;s.style.opacity=0;w.style.opacity=0;a.textContent='';s.dataset.act=''};
window.__pause=(t)=>{g.className='off';s.className='off';a.textContent='';s.dataset.act='';k.textContent=t;s.style.opacity=1;w.style.opacity=0};
window.__at=(x,y)=>{c.style.transform='translate('+x+'px,'+y+'px)'};
window.__frame=(x,y,fw,fh)=>{w.style.left=x+'px';w.style.top=y+'px';w.style.width=fw+'px';w.style.height=fh+'px';w.style.opacity=1};
window.__unframe=()=>{w.style.opacity=0};
window.__ping=(x,y)=>{cs.animate([{transform:'scale(1)'},{transform:'scale(.72)',offset:.3},{transform:'scale(1)'}],{duration:260,easing:'ease-out'});[0,110].forEach((d,i)=>{const r=document.createElement('div');r.className='r';r.style.left=(x-15)+'px';r.style.top=(y-15)+'px';r.style.opacity=0;document.body.appendChild(r);r.animate([{transform:'scale(.3)',opacity:i?.6:1},{transform:'scale('+(i?2.3:1.7)+')',opacity:0}],{duration:560,delay:d,easing:'ease-out'}).onfinish=()=>r.remove()})};
</script>`

interface Slot {
  win: BrowserWindow
  ready: Promise<void>
}

export class ScreenOverlay implements Overlay {
  private slots = new Map<number, Slot>()
  private timer?: NodeJS.Timeout
  private fade?: NodeJS.Timeout
  private current?: DisplayInfo
  private hint: () => string
  private act = ''
  private win?: { x: number; y: number; w: number; h: number }

  /** `hint` is the text of the pill, with the kill key in it */
  constructor(hint: () => string) {
    this.hint = hint
  }

  private slot(d: DisplayInfo): Slot {
    let s = this.slots.get(d.id)
    if (s && !s.win.isDestroyed()) return s
    const bounds = screen.getAllDisplays().find((x) => x.id === d.id)?.bounds || { x: d.x, y: d.y, width: d.w, height: d.h }
    const win = new BrowserWindow({
      ...bounds,
      show: false,
      frame: false,
      transparent: true,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      alwaysOnTop: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setIgnoreMouseEvents(true)
    // out of desktopCapturer pictures: the model sees the screen, not our decoration
    win.setContentProtection(true)
    const ready = new Promise<void>((resolve) => win.webContents.once('did-finish-load', () => resolve()))
    void win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE))
    s = { win, ready }
    this.slots.set(d.id, s)
    return s
  }

  private run(d: DisplayInfo, js: string): void {
    const s = this.slot(d)
    void s.ready.then(() => (s.win.isDestroyed() ? undefined : s.win.webContents.executeJavaScript(js).catch(() => undefined)))
  }

  active(d: DisplayInfo): void {
    clearTimeout(this.fade)
    if (this.current && this.current.id !== d.id) this.run(this.current, '__off()')
    this.current = d
    const s = this.slot(d)
    if (!s.win.isVisible()) s.win.showInactive()
    this.run(d, this.onJs())
    this.track()
    // quiet again a few seconds after the last action
    this.fade = setTimeout(() => this.idle(), 6000)
  }

  private onJs(): string {
    const d = this.current
    return `__on(${JSON.stringify(this.hint())},${JSON.stringify(this.act)});${d ? this.frameJs(d) : ''}`
  }

  /** The outline of the window being worked in; none for a maximized one, the glow already says it. */
  private frameJs(d: DisplayInfo): string {
    const b = screen.getAllDisplays().find((x) => x.id === d.id)?.bounds
    const w = this.win
    if (!b || !w) return '__unframe()'
    const p = screen.screenToDipPoint({ x: w.x, y: w.y })
    const q = screen.screenToDipPoint({ x: w.x + w.w, y: w.y + w.h })
    const fw = q.x - p.x
    const fh = q.y - p.y
    if (fw >= b.width * 0.97 && fh >= b.height * 0.9) return '__unframe()'
    return `__frame(${p.x - b.x},${p.y - b.y},${fw},${fh})`
  }

  say(text: string, win?: { x: number; y: number; w: number; h: number }): void {
    this.act = text
    this.win = win
    const d = this.current
    if (d) this.run(d, `__say(${JSON.stringify(text)});${this.frameJs(d)}`)
  }

  private track(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      const d = this.current
      if (!d) return
      const p = screen.getCursorScreenPoint()
      const b = screen.getAllDisplays().find((x) => x.id === d.id)?.bounds
      if (b) this.run(d, `__at(${p.x - b.x},${p.y - b.y})`)
    }, 33)
  }

  pulse(x: number, y: number): void {
    const d = this.current
    if (!d) return
    const dip = screen.screenToDipPoint({ x, y })
    const b = screen.getAllDisplays().find((q) => q.id === d.id)?.bounds
    if (b) this.run(d, `__ping(${dip.x - b.x},${dip.y - b.y})`)
  }

  paused(on: boolean): void {
    const d = this.current
    if (!d) return
    clearTimeout(this.fade)
    this.run(d, on ? `__pause(${JSON.stringify(tr("Ai preluat controlul. Jolty așteaptă."))})` : this.onJs())
    if (!on) this.fade = setTimeout(() => this.idle(), 6000)
  }

  idle(): void {
    clearTimeout(this.fade)
    clearInterval(this.timer)
    this.timer = undefined
    const d = this.current
    this.current = undefined
    this.act = ''
    this.win = undefined
    if (!d) return
    this.run(d, '__off()')
    const s = this.slots.get(d.id)
    setTimeout(() => {
      if (!this.current && s && !s.win.isDestroyed()) s.win.hide()
    }, 900)
  }

  destroy(): void {
    clearTimeout(this.fade)
    clearInterval(this.timer)
    this.timer = undefined
    this.current = undefined
    for (const s of this.slots.values()) if (!s.win.isDestroyed()) s.win.destroy()
    this.slots.clear()
  }
}
