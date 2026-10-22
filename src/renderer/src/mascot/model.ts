import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
// inlined: the page is a file:// URL in the packaged app, where fetch cannot read it
import glbUrl from './jolty.glb?inline'
import { polishGeometry } from './smooth'
import { Hand } from './hand'

/**
 * Jolty in 3D: the approved render turned into a mesh (docs/mascot/v3: finish.py adds the bolt, rig.py paints
 * the eyes out, bakes the glow and binds a skeleton). Units: 132 tall with the bolt, feet on y = 0, facing +z.
 * Rig3D turns the joint groups below as if each were a plain group sitting on its joint; sync() hands those
 * turns to the skeleton's bones. The eyes are drawn here, not in the texture, so they can blink and change.
 */
export interface Joints {
  /** the right hand: a glove with every finger on its own joints (hand.ts) */
  handR: Hand
  /** the skinned body, to measure where its lowest point is */
  skin: THREE.SkinnedMesh
  root: THREE.Group
  hang: THREE.Group
  torso: THREE.Group
  /** the upper spine: arms and head hang from it */
  chest: THREE.Group
  head: THREE.Group
  bolt: THREE.Group
  armL: THREE.Group
  /** forearms (elbows) and shins (knees) */
  foreL: THREE.Group
  foreR: THREE.Group
  shinL: THREE.Group
  shinR: THREE.Group
  armR: THREE.Group
  legL: THREE.Group
  legR: THREE.Group
  eyes: THREE.Group
  faces: Record<string, THREE.Group>
  laptop: THREE.Group
  /** the laptop's lid, hinged on its far edge: opens toward us */
  lid: THREE.Group
  /** a magnifying glass in the right glove, shown while the model searches */
  glass: THREE.Group
  /** a stool he slides out of the composer to sit on when he is on the floor */
  stool: THREE.Group
  shadow: THREE.Mesh
  /** copies the joint groups' turns onto the bones */
  sync(): void
}

const VOLT = new THREE.Color('#d4ff00')
/** the model is in metres, 1.32 tall; the app works in units of 1/100 of that */
const UNIT = 100

function radialTexture(inner: string, outer: string): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')!
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32)
  grad.addColorStop(0, inner)
  grad.addColorStop(1, outer)
  g.fillStyle = grad
  g.fillRect(0, 0, 64, 64)
  return new THREE.CanvasTexture(c)
}

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat)
  m.position.set(x, y, z)
  return m
}

function joint(parent: THREE.Object3D, x: number, y: number, z = 0): THREE.Group {
  const g = new THREE.Group()
  g.position.set(x, y, z)
  parent.add(g)
  return g
}

/**
 * The right arm in a search (Rig3D): up and in, so the glove is in front of his face (worked out from the
 * shoulder at (17.7, 53) and an arm of about 24). The lens is turned by the inverse, so it then faces us.
 */
export const SEARCH_ARM = { x: -2.15, z: -0.62 }
/** elbow to glove, in app units (rig.py's forearm bones); the search keeps the elbow straight */
const FORE = 11.7

const BOLT = [[-0.5, 26], [13, 26], [7, 15.5], [17, 16], [0, -1], [3, 11.5], [-6.5, 11]]

function glb(): ArrayBuffer {
  const bin = atob(glbUrl.slice(glbUrl.indexOf(',') + 1))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes.buffer
}

/** The eyes on the visor: one group per face, all the same size as the painted ones they replace. */
function buildEyes(eyes: THREE.Group, half: number): Record<string, THREE.Group> {
  const glow = new THREE.MeshBasicMaterial({ color: VOLT, toneMapped: false })
  const glowSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: radialTexture('rgba(212,255,0,0.55)', 'rgba(212,255,0,0)'), blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }))
  // a faint halo: the visor stays black around the eyes, like in the render
  glowSprite.material.opacity = 0.45
  glowSprite.scale.set(half * 3.4, 17, 1)
  glowSprite.position.z = 0.5
  eyes.add(glowSprite)
  const pair = (make: (side: number) => THREE.Object3D): THREE.Group => {
    const g = new THREE.Group()
    for (const side of [-1, 1]) {
      const e = make(side)
      e.position.x += side * half
      e.rotation.y = side * 0.36
      g.add(e)
    }
    eyes.add(g)
    return g
  }
  const pill = (h: number, y = 0) => () => {
    const m = mesh(new THREE.CapsuleGeometry(3.1, h, 6, 16), glow, 0, y)
    m.scale.z = 0.45
    return m
  }
  const arc = (up: boolean) => () =>
    mesh(new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(new THREE.Vector3(-4, up ? -2 : 1, 0), new THREE.Vector3(0, up ? 6 : -2.5, 0), new THREE.Vector3(4, up ? -2 : 1, 0)), 12, 1.7, 8), glow)
  return {
    open: pair(pill(6.6)),
    focus: pair(pill(0.8, -3.5)),
    worried: pair((side) => {
      const m = pill(5)()
      m.rotation.z = side * -0.26
      return m
    }),
    happy: pair(arc(true)),
    sleepy: pair(arc(false)),
    dizzy: pair(() => {
      const g = new THREE.Group()
      for (const r of [0.785, -0.785]) {
        const bar = mesh(new RoundedBoxGeometry(10, 2.6, 1.6, 2, 0.8), glow)
        bar.rotation.z = r
        g.add(bar)
      }
      return g
    })
  }
}

/** along the forearm, in app units, where the sleeve ends and the hand begins */
const WRIST = 11.2

/** drops every triangle that touches a vertex of the hand (the forearm bone's, farther than `from` along it) */
function cutHand(skin: THREE.SkinnedMesh, bone: string, elbow: THREE.Vector3, along: THREE.Vector3, from: number): void {
  const geo = skin.geometry
  const bi = skin.skeleton.bones.findIndex((b) => b.name === bone)
  const si = geo.attributes.skinIndex
  const sw = geo.attributes.skinWeight
  const pos = geo.attributes.position
  const hand = new Uint8Array(pos.count)
  const p = new THREE.Vector3()
  for (let i = 0; i < pos.count; i++) {
    let best = 0
    let bw = -1
    for (let k = 0; k < 4; k++) {
      if (sw.getComponent(i, k) > bw) {
        bw = sw.getComponent(i, k)
        best = si.getComponent(i, k)
      }
    }
    if (best !== bi) continue
    p.set(pos.getX(i) * UNIT, pos.getY(i) * UNIT, pos.getZ(i) * UNIT)
    if (p.sub(elbow).dot(along) >= from) hand[i] = 1
  }
  const src = geo.index ? Array.from(geo.index.array) : Array.from({ length: pos.count }, (_, i) => i)
  const keep: number[] = []
  for (let t = 0; t < src.length; t += 3) {
    if (!hand[src[t]] && !hand[src[t + 1]] && !hand[src[t + 2]]) keep.push(src[t], src[t + 1], src[t + 2])
  }
  geo.setIndex(keep)
}

/**
 * The scan's colour map has its lighting baked in, with cold blue-grey blotches on the hood and creases that read
 * as stains. The reference is matte charcoal fabric: here the dull pixels lose most of their colour and a good part
 * of their contrast (the volt ones, drawstrings and shoe outlines, are left alone).
 */
function calmTexture(tex: THREE.Texture): THREE.Texture {
  const img = tex.image as ImageBitmap
  const c = document.createElement('canvas')
  c.width = img.width
  c.height = img.height
  const g = c.getContext('2d', { willReadFrequently: true })!
  g.drawImage(img, 0, 0)
  const d = g.getImageData(0, 0, c.width, c.height)
  const px = d.data
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i]
    const gr = px[i + 1]
    const b = px[i + 2]
    // volt: strongly green-yellow
    if (gr > 110 && gr > b * 1.6 && r > b * 1.2) continue
    const l = (r + gr + b) / 3
    // toward a neutral charcoal, and the light/dark swings pulled in around a dark middle
    const t = 0.22 + 0.78 * Math.min(1, l / 120) * 0.0
    const lc = 34 + (l - 34) * 0.62
    px[i] = lc + (r - l) * 0.28 * (1 - t * 0)
    px[i + 1] = lc + (gr - l) * 0.28
    px[i + 2] = lc + (b - l) * 0.28
  }
  g.putImageData(d, 0, 0)
  const out = new THREE.CanvasTexture(c)
  out.colorSpace = tex.colorSpace
  out.flipY = tex.flipY
  out.wrapS = tex.wrapS
  out.wrapT = tex.wrapT
  out.anisotropy = tex.anisotropy
  tex.dispose()
  return out
}

export async function loadJolty(scene: THREE.Scene): Promise<Joints> {
  const gltf = await new GLTFLoader().parseAsync(glb(), '')
  const model = gltf.scene
  model.scale.setScalar(UNIT)
  model.updateMatrixWorld(true)
  const node = (name: string): THREE.Object3D => {
    const o = model.getObjectByName(name)
    if (!o) throw new Error(`jolty.glb has no ${name}`)
    return o
  }
  const skin = model.getObjectByProperty('type', 'SkinnedMesh') as THREE.SkinnedMesh
  skin.geometry.computeBoundingBox()
  const hoodTop = skin.geometry.boundingBox!.max.y * UNIT
  // smooth cloth instead of a faceted scan, and a round hood top instead of a pinch under the bolt
  polishGeometry(skin.geometry, (hoodTop / UNIT) * 0.8, hoodTop / UNIT)
  // the scan's lighting is in its texture already; the env light only adds a soft sheen
  const fleece = skin.material as THREE.MeshStandardMaterial
  fleece.envMapIntensity = 0.9
  if (fleece.map) fleece.map = calmTexture(fleece.map)
  fleece.emissiveIntensity = 1.4
  skin.frustumCulled = false
  const boltMesh = node('Bolt') as THREE.Mesh
  ;(boltMesh.material as THREE.Material).dispose()
  // not tone mapped, or ACES washes the volt out to pale yellow
  boltMesh.material = new THREE.MeshStandardMaterial({ color: VOLT, emissive: VOLT, emissiveIntensity: 0.35, roughness: 0.4, toneMapped: false })

  const shadow = mesh(new THREE.PlaneGeometry(64, 16), new THREE.MeshBasicMaterial({ map: radialTexture('rgba(212,255,0,0.2)', 'rgba(212,255,0,0)'), transparent: true, depthWrite: false }), 0, 0.2, 0)
  shadow.rotation.x = -Math.PI / 2
  scene.add(shadow)

  const root = joint(scene, 0, 0)
  // held by the hood: the hang joint sits on the hood top and carries everything else
  const hang = joint(root, 0, hoodTop)
  const body = joint(hang, 0, -hoodTop)
  body.add(model)
  root.updateMatrixWorld(true)

  // eyes where the painted ones were, riding on the head bone
  const at = (name: string): THREE.Vector3 => node(name).getWorldPosition(new THREE.Vector3())
  const l = at('eyeL')
  const r = at('eyeR')
  const mount = new THREE.Group()
  mount.position.copy(l).add(r).multiplyScalar(0.5)
  mount.position.z += 1.2
  root.add(mount)
  root.updateMatrixWorld(true)
  node('head').attach(mount)
  const eyes = new THREE.Group()
  mount.add(eyes)
  const faces = buildEyes(eyes, (r.x - l.x) / 2)

  // the slot the bolt comes out of, as in the reference: a dark opening in the hood top with a thin volt glow
  // around the bolt's foot (the scan only has the bolt pushed into the cloth)
  {
    const foot = boltMesh.localToWorld(new THREE.Vector3(-0.023, hoodTop / UNIT - 0.004, 0.042))
    const slot = new THREE.Group()
    slot.position.copy(foot)
    const dark = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.5, 40), new THREE.MeshStandardMaterial({ color: '#030304', roughness: 0.55, metalness: 0 }))
    dark.scale.set(9, 1, 5.2)
    const glow = new THREE.Mesh(new THREE.RingGeometry(0.62, 0.9, 40), new THREE.MeshBasicMaterial({ color: VOLT, transparent: true, opacity: 0.55, toneMapped: false, side: THREE.DoubleSide }))
    glow.rotation.x = -Math.PI / 2
    glow.position.y = 0.3
    glow.scale.set(9, 5.2, 1)
    slot.add(dark, glow)
    root.add(slot)
    root.updateMatrixWorld(true)
    node('head').attach(slot)
  }

  // each bone gets the turn of its group, taken in the model's axes: q = local · world⁻¹ · turn · world
  const names = ['torso', 'chest', 'head', 'bolt', 'armL', 'armR', 'foreL', 'foreR', 'legL', 'legR', 'shinL', 'shinR'] as const
  const groups = Object.fromEntries(names.map((n) => [n, new THREE.Group()])) as Record<(typeof names)[number], THREE.Group>
  const bones = names.map((n) => {
    const b = node(n)
    const world = b.getWorldQuaternion(new THREE.Quaternion())
    return { b, g: groups[n], local: b.quaternion.clone(), world, inv: world.clone().invert() }
  })
  const turn = new THREE.Quaternion()
  const sync = (): void => {
    for (const { b, g, local, world, inv } of bones) {
      turn.setFromEuler(g.rotation)
      b.quaternion.copy(local).multiply(inv).multiply(turn).multiply(world)
      // torso and bolt bones point straight up with no roll, so their y is the model's up
      b.scale.copy(g.scale)
    }
  }

  // a laptop for typing on the lap; its lid faces him, the bolt logo faces us
  const metal = new THREE.MeshStandardMaterial({ color: '#3b3f47', roughness: 0.35, metalness: 0.7 })
  const laptop = joint(root, 0, 31, 30)
  laptop.add(mesh(new RoundedBoxGeometry(34, 2.4, 20, 2, 1), metal))
  const lid = joint(laptop, 0, 1.2, 10)
  lid.rotation.x = 0.28
  lid.add(mesh(new RoundedBoxGeometry(31, 19, 1.4, 2, 0.6), metal, 0, 9.5, 0))
  const logo = new THREE.ExtrudeGeometry(new THREE.Shape(BOLT.map(([x, y]) => new THREE.Vector2(x, y))), { depth: 0.6, bevelEnabled: false })
  logo.scale(0.32, 0.32, 1)
  lid.add(mesh(logo, new THREE.MeshBasicMaterial({ color: VOLT, toneMapped: false }), -1.2, 5.6, 0.8))
  laptop.visible = false

  // the right hand: the scan's mitten is cut off at the wrist and a glove with real fingers takes its place
  const foreRBone = node('foreR')
  const elbowR = foreRBone.getWorldPosition(new THREE.Vector3())
  const alongR = new THREE.Vector3(0, 1, 0).applyQuaternion(foreRBone.getWorldQuaternion(new THREE.Quaternion()))
  cutHand(skin, 'foreR', elbowR, alongR, WRIST)
  const handR = new Hand(1)
  handR.group.position.copy(elbowR).addScaledVector(alongR, WRIST - 0.5)
  handR.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), alongR)
  root.add(handR.group)
  root.updateMatrixWorld(true)
  foreRBone.attach(handR.group)
  handR.snap('relaxed')

  // the magnifying glass rides on the right arm bone, from the glove on along the arm; its lens is turned so
  // that with the arm raised to his face (SEARCH_ARM) it faces us
  // the glove is at the forearm bone's tail: glTF bones run along their +y, FORE long
  const shoulder = node('foreR')
  const glass = new THREE.Group()
  glass.position.copy(at('foreR')).add(new THREE.Vector3(0, FORE, 0).applyQuaternion(shoulder.getWorldQuaternion(new THREE.Quaternion())))
  root.add(glass)
  root.updateMatrixWorld(true)
  shoulder.attach(glass)
  const dark = new THREE.MeshStandardMaterial({ color: '#2a2d33', roughness: 0.4, metalness: 0.6 })
  glass.add(mesh(new THREE.CylinderGeometry(1.3, 1.6, 10, 12), dark, 0, -3, 0))
  const lens = joint(glass, 0, -19, 0)
  lens.quaternion.setFromEuler(new THREE.Euler(SEARCH_ARM.x, 0, SEARCH_ARM.z)).invert()
  lens.add(mesh(new THREE.TorusGeometry(6.2, 1.2, 10, 36), new THREE.MeshStandardMaterial({ color: VOLT, emissive: VOLT, emissiveIntensity: 0.35, roughness: 0.4, toneMapped: false })))
  lens.add(mesh(new THREE.CircleGeometry(6, 32), new THREE.MeshPhysicalMaterial({ color: '#cfeeff', roughness: 0.05, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false })))
  glass.visible = false

  // the stool: a plain wooden three-legged one, seat top at 22: tall enough that he sits on it with his legs dangling and the stool shows below him. Big and light enough to read against the dark app
  // at his size (at 0.6 px a unit a 12-unit seat was a speck hidden under his thighs); a little self-light so
  // the dark scene does not swallow it
  const stool = joint(scene, 0, 0)
  const wood = new THREE.MeshStandardMaterial({ color: '#d99a52', roughness: 0.7, metalness: 0, emissive: '#5a3510', emissiveIntensity: 0.55 })
  const woodDark = new THREE.MeshStandardMaterial({ color: '#b9783a', roughness: 0.75, metalness: 0, emissive: '#3d230a', emissiveIntensity: 0.5 })
  stool.add(mesh(new THREE.CylinderGeometry(19, 18.5, 4.6, 36), wood, 0, 19.7, -3))
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + Math.PI / 6
    const leg = mesh(new THREE.CylinderGeometry(2.3, 3, 20, 12), woodDark, Math.cos(a) * 13, 9.6, -3 + Math.sin(a) * 13)
    // splayed outward, like a milking stool
    leg.rotation.set(Math.sin(a) * 0.16, 0, -Math.cos(a) * 0.16)
    stool.add(leg)
  }
  stool.visible = false

  return { handR, skin, root, hang, ...groups, eyes, faces, laptop, lid, glass, stool, shadow, sync }
}

export function lightStudio(scene: THREE.Scene, renderer: THREE.WebGLRenderer): void {
  const pmrem = new THREE.PMREMGenerator(renderer)
  // a soft grey room for reflections, built in code (no image to load)
  const room = new THREE.Scene()
  room.add(mesh(new THREE.SphereGeometry(500, 16, 8), new THREE.MeshBasicMaterial({ color: '#1c1e22', side: THREE.BackSide })))
  const panel = mesh(new THREE.PlaneGeometry(400, 160), new THREE.MeshBasicMaterial({ color: '#ffffff' }), -150, 300, 250)
  panel.lookAt(0, 0, 0)
  const back = mesh(new THREE.PlaneGeometry(300, 200), new THREE.MeshBasicMaterial({ color: '#7f97b8' }), 250, 150, -300)
  back.lookAt(0, 0, 0)
  room.add(panel, back)
  scene.environment = pmrem.fromScene(room, 0.04).texture
  scene.environmentIntensity = 0.55
  pmrem.dispose()

  scene.add(new THREE.HemisphereLight('#c3cfe0', '#2a2e36', 1))
  const key = new THREE.DirectionalLight('#ffffff', 2.6)
  key.position.set(-120, 220, 240)
  // two cold rims from behind, one per side: they draw his edges, so charcoal reads on a near-black app
  const rimR = new THREE.DirectionalLight('#b8d2ff', 6)
  rimR.position.set(200, 140, -180)
  const rimL = new THREE.DirectionalLight('#dfe8ff', 4.5)
  rimL.position.set(-200, 110, -160)
  scene.add(key, rimR, rimL)
}
