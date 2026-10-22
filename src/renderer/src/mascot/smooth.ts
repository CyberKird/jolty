import * as THREE from 'three'

/**
 * Cleans up the scan: every triangle of it is its own island, so the stock normals are flat per face and the hood
 * looks faceted, and the apex is a pinched fan of creases where the cloth was gathered under the bolt.
 *  - normals: each vertex averages the faces around its welded position that lean the same way (within `crease`
 *    radians of its own face), so smooth cloth is smooth and real folds stay sharp;
 *  - apex: the top of the hood (above `fromY`) is relaxed with a few Taubin steps (a smooth, then a slight
 *    inflate, so it does not shrink), strongest at the very top, which rounds the pinch into a dome.
 * Run once at load, on the bind pose; the skin weights stay as they are.
 */
export function polishGeometry(geo: THREE.BufferGeometry, fromY: number, topY: number, crease = 0.95): void {
  const pos = geo.attributes.position as THREE.BufferAttribute
  const n = pos.count
  const index = geo.index ? Array.from(geo.index.array) : Array.from({ length: n }, (_, i) => i)
  const tri = index.length / 3

  // weld: vertices at the same place share one id
  const key = (i: number): string => `${Math.round(pos.getX(i) * 4000)},${Math.round(pos.getY(i) * 4000)},${Math.round(pos.getZ(i) * 4000)}`
  const ids = new Map<string, number>()
  const weld = new Int32Array(n)
  for (let i = 0; i < n; i++) {
    const k = key(i)
    let id = ids.get(k)
    if (id === undefined) ids.set(k, (id = ids.size))
    weld[i] = id
  }
  const m = ids.size

  // the relaxed apex
  const p = new Float32Array(m * 3)
  for (let i = 0; i < n; i++) {
    const w = weld[i] * 3
    p[w] = pos.getX(i)
    p[w + 1] = pos.getY(i)
    p[w + 2] = pos.getZ(i)
  }
  const nb: Set<number>[] = Array.from({ length: m }, () => new Set())
  for (let t = 0; t < tri; t++) {
    const a = weld[index[t * 3]]
    const b = weld[index[t * 3 + 1]]
    const c = weld[index[t * 3 + 2]]
    nb[a].add(b).add(c)
    nb[b].add(a).add(c)
    nb[c].add(a).add(b)
  }
  const span = Math.max(1e-6, topY - fromY)
  const weight = new Float32Array(m)
  for (let i = 0; i < m; i++) {
    const u = Math.min(1, Math.max(0, (p[i * 3 + 1] - fromY) / span))
    weight[i] = u * u * (3 - 2 * u)
  }
  const q = new Float32Array(p.length)
  const step = (lambda: number): void => {
    q.set(p)
    for (let i = 0; i < m; i++) {
      if (weight[i] <= 0 || nb[i].size === 0) continue
      let x = 0
      let y = 0
      let z = 0
      for (const j of nb[i]) {
        x += p[j * 3]
        y += p[j * 3 + 1]
        z += p[j * 3 + 2]
      }
      const k = nb[i].size
      const l = lambda * weight[i]
      q[i * 3] += (x / k - p[i * 3]) * l
      q[i * 3 + 1] += (y / k - p[i * 3 + 1]) * l
      q[i * 3 + 2] += (z / k - p[i * 3 + 2]) * l
    }
    p.set(q)
  }
  for (let r = 0; r < 8; r++) {
    step(0.6)
    step(-0.63)
  }
  for (let i = 0; i < n; i++) pos.setXYZ(i, p[weld[i] * 3], p[weld[i] * 3 + 1], p[weld[i] * 3 + 2])
  pos.needsUpdate = true

  // normals: area-weighted, over the faces of the welded position that agree with the vertex's own face
  const fn = new Float32Array(tri * 3)
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  const e1 = new THREE.Vector3()
  const e2 = new THREE.Vector3()
  for (let t = 0; t < tri; t++) {
    a.fromBufferAttribute(pos, index[t * 3])
    b.fromBufferAttribute(pos, index[t * 3 + 1])
    c.fromBufferAttribute(pos, index[t * 3 + 2])
    e1.subVectors(b, a)
    e2.subVectors(c, a)
    e1.cross(e2) // length = twice the area
    fn[t * 3] = e1.x
    fn[t * 3 + 1] = e1.y
    fn[t * 3 + 2] = e1.z
  }
  const around: number[][] = Array.from({ length: m }, () => [])
  for (let t = 0; t < tri; t++) for (let k = 0; k < 3; k++) around[weld[index[t * 3 + k]]].push(t)
  const own = new Int32Array(n).fill(-1)
  for (let t = 0; t < tri; t++) for (let k = 0; k < 3; k++) own[index[t * 3 + k]] = t
  const cosMin = Math.cos(crease)
  const normals = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const t0 = own[i]
    if (t0 < 0) continue
    const l0 = Math.hypot(fn[t0 * 3], fn[t0 * 3 + 1], fn[t0 * 3 + 2]) || 1
    let x = 0
    let y = 0
    let z = 0
    for (const t of around[weld[i]]) {
      const dot = (fn[t * 3] * fn[t0 * 3] + fn[t * 3 + 1] * fn[t0 * 3 + 1] + fn[t * 3 + 2] * fn[t0 * 3 + 2]) / (l0 * (Math.hypot(fn[t * 3], fn[t * 3 + 1], fn[t * 3 + 2]) || 1))
      if (dot < cosMin) continue
      x += fn[t * 3]
      y += fn[t * 3 + 1]
      z += fn[t * 3 + 2]
    }
    const l = Math.hypot(x, y, z) || 1
    normals[i * 3] = x / l
    normals[i * 3 + 1] = y / l
    normals[i * 3 + 2] = z / l
  }
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  geo.computeBoundingBox()
}
