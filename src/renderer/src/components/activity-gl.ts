// The glitter cables on the graphics chip. Each cable is a strip of triangles along its centre line; the shader makes the grain from a
// hash of (distance along the cable minus time x speed, distance across), so the glitter flows from the light to the tiles, the way it does
// in the reference video (measured there: a steady drift of the grain away from the source, each grain twinkling on its own). Nothing is
// computed per frame on the CPU but a few numbers; a strip that changes shape (the live rope while it closes up) is rebuilt, a few hundred
// vertices. With no WebGL the board falls back to the still 2D painting (activity-canvas.ts).

import type { Palette, Pt } from './activity-canvas'

export interface GLRope {
  pts: Pt[]
  /** the cable's full width, in board units */
  width: number
  pal: Palette
  alpha?: number
  /** where along the cable the grain pattern starts; ropes that share a route share it, so they meet without a seam */
  u0?: number
}

const VS = `
attribute vec2 aPos;
attribute float aU;
attribute float aV;
uniform vec2 uView;
varying float vU;
varying float vV;
void main() {
  vU = aU;
  vV = aV;
  vec2 p = aPos / uView * 2.0 - 1.0;
  gl_Position = vec4(p.x, -p.y, 0.0, 1.0);
}`

const FS = `
precision highp float;
uniform vec3 cDark;
uniform vec3 cBase;
uniform vec3 cLight;
uniform vec3 cSpark;
uniform float uHw;
uniform float uLen;
uniform float uAlpha;
uniform float uTime;
uniform float uFlow;
uniform float uCell;
uniform float uAA;
varying float vU;
varying float vV;
float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  float across = vV;
  float r = abs(across);
  if (vU < 0.0) r = length(vec2(vU, across));
  else if (vU > uLen) r = length(vec2(vU - uLen, across));
  float body = 1.0 - smoothstep(uHw - uAA, uHw + uAA, r);
  float rim = 1.0 - smoothstep(uHw + 0.7 - uAA, uHw + 0.7 + uAA, r);
  if (rim <= 0.0) discard;
  // the grain: cells that slide along the cable, each with its own colour, brightness and twinkle
  vec2 cell = floor(vec2(vU - uFlow, across + 40.0) / uCell);
  float a = h(cell);
  float b = h(cell + 17.31);
  float t = h(cell + 5.17);
  vec3 col = a < 0.2 ? cDark : a < 0.58 ? cBase : a < 0.965 ? cLight : cSpark;
  float tw = 0.74 + 0.36 * sin(uTime * (1.6 + t * 4.2) + t * 6.2832);
  float glint = a >= 0.965 ? 0.55 + 0.75 * max(0.0, sin(uTime * (2.4 + t * 3.0) + b * 6.2832)) : 1.0;
  col *= (0.8 + b * 0.32) * tw * glint;
  // a round cable: darker towards the sides, a soft light down the middle
  float q = clamp(r / uHw, 0.0, 1.0);
  col *= 1.0 - 0.38 * q * q;
  col += vec3(0.09) * (1.0 - smoothstep(0.0, 0.42, q));
  vec3 c = mix(vec3(0.024, 0.016, 0.047), col, body);
  float alpha = max(body, rim * 0.72) * uAlpha;
  gl_FragColor = vec4(c * alpha, alpha);
}`

const rgb = (c: string): [number, number, number] => [parseInt(c.slice(1, 3), 16) / 255, parseInt(c.slice(3, 5), 16) / 255, parseInt(c.slice(5, 7), 16) / 255]

/** A strip for one rope: two vertices per point, plus a half-width beyond each end for the round caps. */
function strip(r: GLRope, pad: number): { data: Float32Array; len: number } {
  const p = r.pts
  const n = p.length
  const hw = r.width / 2
  const ext = hw + pad
  const u0 = r.u0 ?? 0
  const lens = [0]
  for (let i = 1; i < n; i++) lens.push(lens[i - 1] + Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y))
  const len = lens[n - 1]
  const out: number[] = []
  const push = (x: number, y: number, nx: number, ny: number, u: number): void => {
    out.push(x + nx * ext, y + ny * ext, u, ext, x - nx * ext, y - ny * ext, u, -ext)
  }
  const dir = (i: number, j: number): Pt => {
    const l = Math.hypot(p[j].x - p[i].x, p[j].y - p[i].y) || 1
    return { x: (p[j].x - p[i].x) / l, y: (p[j].y - p[i].y) / l }
  }
  const d0 = dir(0, 1)
  push(p[0].x - d0.x * ext, p[0].y - d0.y * ext, -d0.y, d0.x, u0 - ext)
  for (let i = 0; i < n; i++) {
    const a = dir(Math.max(0, i - 1), Math.max(1, i))
    const b = dir(Math.min(n - 2, i), Math.min(n - 1, i + 1))
    let nx = -(a.y + b.y)
    let ny = a.x + b.x
    const l = Math.hypot(nx, ny) || 1
    nx /= l
    ny /= l
    push(p[i].x, p[i].y, nx, ny, u0 + lens[i])
  }
  const d1 = dir(n - 2, n - 1)
  push(p[n - 1].x + d1.x * ext, p[n - 1].y + d1.y * ext, -d1.y, d1.x, u0 + len + ext)
  return { data: new Float32Array(out), len }
}

export class CableGL {
  private gl: WebGLRenderingContext
  private prog: WebGLProgram
  private buf: WebGLBuffer
  private loc: Record<string, WebGLUniformLocation | null> = {}
  private attr: { pos: number; u: number; v: number }
  private stat: { first: number; count: number; rope: GLRope; len: number }[] = []
  private statData = new Float32Array(0)

  static create(canvas: HTMLCanvasElement): CableGL | null {
    try {
      const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, powerPreference: 'low-power' })
      return gl ? new CableGL(gl) : null
    } catch {
      return null
    }
  }

  private constructor(gl: WebGLRenderingContext) {
    this.gl = gl
    const sh = (type: number, src: string): WebGLShader => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, src)
      gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader')
      return s
    }
    const prog = gl.createProgram()!
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS))
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS))
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link')
    this.prog = prog
    this.buf = gl.createBuffer()!
    for (const k of ['uView', 'cDark', 'cBase', 'cLight', 'cSpark', 'uHw', 'uLen', 'uAlpha', 'uTime', 'uFlow', 'uCell', 'uAA']) this.loc[k] = gl.getUniformLocation(prog, k)
    this.attr = { pos: gl.getAttribLocation(prog, 'aPos'), u: gl.getAttribLocation(prog, 'aU'), v: gl.getAttribLocation(prog, 'aV') }
  }

  /** The cables that do not change; built once (and again when the size changes the edge padding). */
  setStatic(ropes: GLRope[], pad: number): void {
    const parts = ropes.map((r) => ({ r, s: strip(r, pad) }))
    let first = 0
    this.stat = parts.map(({ r, s }) => {
      const e = { first, count: s.data.length / 4, rope: r, len: s.len }
      first += e.count
      return e
    })
    const all = new Float32Array(first * 4)
    let o = 0
    for (const { s } of parts) {
      all.set(s.data, o)
      o += s.data.length
    }
    this.statData = all
  }

  /** One frame: `under` (the live rope) first, then the still cables over it. */
  frame(o: { time: number; flow: number; k: number; width: number; height: number; under: GLRope[] }): void {
    const { gl } = this
    gl.viewport(0, 0, o.width, o.height)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.useProgram(this.prog)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.uniform2f(this.loc.uView, o.width / o.k, o.height / o.k)
    gl.uniform1f(this.loc.uTime, o.time)
    gl.uniform1f(this.loc.uFlow, o.flow)
    // grain of about 0.9 css pixel at the default size, never finer than one device pixel
    gl.uniform1f(this.loc.uCell, Math.max(0.95, 1.1 / o.k))
    gl.uniform1f(this.loc.uAA, 0.75 / o.k)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf)
    const bind = (): void => {
      gl.enableVertexAttribArray(this.attr.pos)
      gl.vertexAttribPointer(this.attr.pos, 2, gl.FLOAT, false, 16, 0)
      gl.enableVertexAttribArray(this.attr.u)
      gl.vertexAttribPointer(this.attr.u, 1, gl.FLOAT, false, 16, 8)
      gl.enableVertexAttribArray(this.attr.v)
      gl.vertexAttribPointer(this.attr.v, 1, gl.FLOAT, false, 16, 12)
    }
    const draw = (r: GLRope, len: number, first: number, count: number): void => {
      const [d, b, l, s] = [rgb(r.pal.dark), rgb(r.pal.base), rgb(r.pal.light), rgb(r.pal.spark)]
      gl.uniform3f(this.loc.cDark, ...d)
      gl.uniform3f(this.loc.cBase, ...b)
      gl.uniform3f(this.loc.cLight, ...l)
      gl.uniform3f(this.loc.cSpark, ...s)
      gl.uniform1f(this.loc.uHw, r.width / 2)
      gl.uniform1f(this.loc.uLen, (r.u0 ?? 0) + len)
      gl.uniform1f(this.loc.uAlpha, r.alpha ?? 1)
      gl.drawArrays(gl.TRIANGLE_STRIP, first, count)
    }
    const pad = 0.7 + 2 / o.k
    if (o.under.length) {
      const parts = o.under.map((r) => ({ r, s: strip(r, pad) }))
      for (const { r, s } of parts) {
        gl.bufferData(gl.ARRAY_BUFFER, s.data, gl.STREAM_DRAW)
        bind()
        draw(r, s.len, 0, s.data.length / 4)
      }
    }
    gl.bufferData(gl.ARRAY_BUFFER, this.statData, gl.STATIC_DRAW)
    bind()
    for (const e of this.stat) draw(e.rope, e.len, e.first, e.count)
  }
}

/** The points of an SVG path, every `step` units (measured by the browser, so arcs come out exact). */
let probe: SVGPathElement | null = null
export function sample(d: string, step = 0.8): Pt[] {
  if (!probe) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('width', '0')
    svg.setAttribute('height', '0')
    svg.style.position = 'absolute'
    svg.style.visibility = 'hidden'
    probe = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    svg.appendChild(probe)
    document.body.appendChild(svg)
  }
  probe.setAttribute('d', d)
  const len = probe.getTotalLength()
  const n = Math.max(2, Math.ceil(len / step) + 1)
  return Array.from({ length: n }, (_, i) => {
    const q = probe!.getPointAtLength((len * i) / (n - 1))
    return { x: q.x, y: q.y }
  })
}
