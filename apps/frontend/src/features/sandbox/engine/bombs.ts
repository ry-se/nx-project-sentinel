import {
  BoxGeometry,
  BufferAttribute,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Raycaster,
  RingGeometry,
  Scene,
  SphereGeometry,
  Vector3,
} from 'three'

import type { BombDrop } from './vehicles'

import { BOMB } from '@/constants'

// const BOMB.GRAVITY = -28          // m/s²
// const BOMB.BLAST_RADIUS = 120     // metres for debris scatter
// const BOMB.DOWN = new Vector3(0, -1, 0)

// ─── tile mesh deformation ─────────────────────────────────────────────────

// const BOMB.CRATER_R    = 28   // radius of full depression (m)
// const BOMB.DAMAGE_R    = 85   // outer blast wave radius (m)
// const BOMB.CRATER_D    = 22   // max downward displacement at crater center (m)
// const BOMB.DAMAGE_RISE = 15   // max outward + upward displacement in damage ring (m)

/**
 * Deforms the vertex positions of any tile mesh within the blast radius.
 * Inner ring: vertices pushed DOWN → creates a crater.
 * Outer ring: vertices pushed OUTWARD + UP → buildings lean and crumble.
 * Modification persists until the tile is unloaded by TilesRenderer (fly away
 * far enough and the city "resets" — intentional, tile reload is free repairs).
 */
function deformTiles(blast: Vector3, terrain: Object3D): void {
  // Reusable vectors to avoid GC churn in the hot inner loop
  const vWorld  = new Vector3()
  const outDir  = new Vector3()
  const newWorld = new Vector3()

  terrain.traverse((obj) => {
    const mesh = obj as Mesh
    if (!mesh.isMesh || !mesh.geometry) return

    // Quick bounding-sphere pre-check in world space
    mesh.geometry.computeBoundingSphere()
    const bs = mesh.geometry.boundingSphere
    if (bs) {
      const meshCenter = bs.center.clone().applyMatrix4(mesh.matrixWorld)
      if (meshCenter.distanceTo(blast) > bs.radius + BOMB.DAMAGE_R) return
    }

    // Ensure we have a plain BufferAttribute (GLB tiles sometimes use
    // InterleavedBufferAttribute, which doesn't support setXYZ in-place).
    let posAttr = mesh.geometry.attributes.position
    if (!posAttr) return
    if (!(posAttr instanceof BufferAttribute)) {
      // Convert interleaved → regular so we can write back
      const arr = new Float32Array(posAttr.count * 3)
      for (let i = 0; i < posAttr.count; i++) {
        arr[i * 3]     = posAttr.getX(i)
        arr[i * 3 + 1] = posAttr.getY(i)
        arr[i * 3 + 2] = posAttr.getZ(i)
      }
      posAttr = new BufferAttribute(arr, 3)
      mesh.geometry.setAttribute('position', posAttr)
    }

    mesh.updateMatrixWorld(true)
    const invMatrix = mesh.matrixWorld.clone().invert()
    let modified = false

    for (let i = 0; i < posAttr.count; i++) {
      vWorld.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i))
      vWorld.applyMatrix4(mesh.matrixWorld)

      const dist = vWorld.distanceTo(blast)
      if (dist >= BOMB.DAMAGE_R) continue

      // Horizontal push direction (ignore Y so vertical faces collapse correctly)
      outDir.set(vWorld.x - blast.x, 0, vWorld.z - blast.z)
      const hDist = outDir.length()
      if (hDist > 0.001) outDir.divideScalar(hDist); else outDir.set(1, 0, 0)

      let dy = 0
      let dhoriz = 0

      if (dist < BOMB.CRATER_R) {
        // Crater: push DOWN, slight outward shove
        const t = 1 - dist / BOMB.CRATER_R
        dy     = -BOMB.CRATER_D * t * t
        dhoriz =  BOMB.DAMAGE_RISE * 0.25 * t
      } else {
        // Damage ring: push OUT and UP like a shockwave
        const t = 1 - (dist - BOMB.CRATER_R) / (BOMB.DAMAGE_R - BOMB.CRATER_R)
        dy     = BOMB.DAMAGE_RISE * t * 0.4
        dhoriz = BOMB.DAMAGE_RISE * t
      }

      newWorld.set(
        vWorld.x + outDir.x * dhoriz,
        vWorld.y + dy,
        vWorld.z + outDir.z * dhoriz,
      )

      // Transform displaced world position back to local space
      newWorld.applyMatrix4(invMatrix)
      posAttr.setXYZ(i, newWorld.x, newWorld.y, newWorld.z)
      modified = true
    }

    if (modified) {
      posAttr.needsUpdate = true
      mesh.geometry.computeVertexNormals()
      mesh.geometry.computeBoundingBox()
      mesh.geometry.computeBoundingSphere()
    }
  })
}

// ─── falling bomb ──────────────────────────────────────────────────────────

interface FallingBomb {
  group: Group
  vel: Vector3
  alive: boolean
}

function makeBombMesh(): Group {
  const g = new Group()
  const body = new Mesh(
    new CylinderGeometry(0.35, 0.5, 2.8, 10),
    new MeshStandardMaterial({ color: 0x222222, roughness: 0.6 }),
  )
  body.rotation.x = Math.PI / 2
  const fin1 = new Mesh(
    new BoxGeometry(0.12, 0.9, 0.7),
    new MeshStandardMaterial({ color: 0x333333 }),
  )
  fin1.position.set(0, 0.5, -1.2)
  const fin2 = fin1.clone()
  fin2.rotation.z = Math.PI / 2
  g.add(body, fin1, fin2)
  return g
}

// ─── explosion VFX ────────────────────────────────────────────────────────

interface DebrisChunk {
  mesh: Mesh
  vel: Vector3
  spin: Vector3
  age: number
  life: number
}

interface ExplosionState {
  flash:       Mesh     // white → gone in 0.3 s
  fireball:    Mesh     // orange, expands 0→80 m in 1.5 s
  smoke:       Mesh     // grey, expands 0→130 m in 4 s
  shockwave:   Mesh     // flat ring expands 0→300 m in 2 s
  fires:       Mesh[]   // 8 small secondary fireballs
  debris:      DebrisChunk[]
  crater:      Mesh
  center:      Vector3
  age:         number   // seconds since detonation
  alive:       boolean
}

const FLASH_LIFE     = 0.4
const FIREBALL_LIFE  = 2.5
const SMOKE_LIFE     = 6.0
const SHOCK_LIFE     = 2.2
const DEBRIS_LIFE    = 5.0

function createExplosion(pos: Vector3, terrain: Object3D, scene: Scene): ExplosionState {
  const mat = (col: number, emissive = 0x000000, opacity = 1) =>
    new MeshStandardMaterial({
      color: col, emissive, emissiveIntensity: 1.2,
      transparent: true, opacity,
      depthWrite: false,
    })

  // flash — bright white sphere
  const flash = new Mesh(new SphereGeometry(1, 16, 12), mat(0xffffff, 0xffffff))
  flash.position.copy(pos)
  flash.position.y += 4
  flash.traverse(o => o.layers.set(1))
  scene.add(flash)

  // fireball
  const fireball = new Mesh(new SphereGeometry(1, 20, 16), mat(0xff6000, 0xff3300))
  fireball.position.copy(pos)
  fireball.position.y += 6
  fireball.traverse(o => o.layers.set(1))
  scene.add(fireball)

  // smoke column
  const smoke = new Mesh(new SphereGeometry(1, 16, 12), mat(0x444444, 0x000000, 0.65))
  smoke.position.copy(pos)
  smoke.position.y += 30
  smoke.traverse(o => o.layers.set(1))
  scene.add(smoke)

  // ground shockwave ring
  const shockwave = new Mesh(
    new RingGeometry(0.5, 1, 64),
    mat(0xffffff, 0xdddddd, 0.7),
  )
  shockwave.rotation.x = -Math.PI / 2
  shockwave.position.copy(pos)
  shockwave.position.y += 0.3
  shockwave.traverse(o => o.layers.set(1))
  scene.add(shockwave)

  // 8 secondary fires scattered within blast radius
  const fires: Mesh[] = []
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2
    const dist  = 15 + Math.random() * 45
    const f = new Mesh(new SphereGeometry(0.5 + Math.random() * 2, 10, 8), mat(0xff4400, 0xff2200))
    f.position.set(
      pos.x + Math.cos(angle) * dist,
      pos.y + 1 + Math.random() * 6,
      pos.z + Math.sin(angle) * dist,
    )
    f.traverse(o => o.layers.set(1))
    scene.add(f)
    fires.push(f)
  }

  // debris — sample hit points on surrounding tile mesh, spawn flying chunks
  const debris: DebrisChunk[] = []
  const rc = new Raycaster()
  ;(rc as unknown as { firstHitOnly: boolean }).firstHitOnly = true

  for (let i = 0; i < 40; i++) {
    const angle  = Math.random() * Math.PI * 2
    const elev   = Math.random() * Math.PI * 0.55  // mostly upward hemisphere
    const outDir = new Vector3(
      Math.cos(elev) * Math.cos(angle),
      Math.sin(elev),
      Math.cos(elev) * Math.sin(angle),
    )

    // Find a tile surface near the blast to decide spawn point
    rc.set(pos.clone().add(new Vector3(0, 3, 0)), outDir)
    rc.far = BOMB.BLAST_RADIUS
    const hits = rc.intersectObject(terrain, true)
    const spawnPt = hits.length > 0
      ? hits[0].point.clone().add(new Vector3(0, 0.5, 0))
      : pos.clone().addScaledVector(outDir, 5 + Math.random() * 30)

    const w = 0.8 + Math.random() * 3.5
    const h = 0.5 + Math.random() * 2.5
    const grey = 0x888888 + Math.floor(Math.random() * 0x333333)
    const chunk = new Mesh(
      new BoxGeometry(w, h, w * (0.5 + Math.random())),
      new MeshStandardMaterial({ color: grey, roughness: 0.85, transparent: true }),
    )
    chunk.position.copy(spawnPt)
    chunk.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI)
    chunk.traverse(o => o.layers.set(1))
    scene.add(chunk)

    const speed = 15 + Math.random() * 55
    debris.push({
      mesh: chunk,
      vel: outDir.clone().multiplyScalar(speed),
      spin: new Vector3(
        (Math.random() - 0.5) * 8,
        (Math.random() - 0.5) * 8,
        (Math.random() - 0.5) * 8,
      ),
      age: 0,
      life: DEBRIS_LIFE * (0.6 + Math.random() * 0.8),
    })
  }

  // persistent crater disc
  const crater = new Mesh(
    new CylinderGeometry(22, 28, 0.6, 32),
    new MeshStandardMaterial({ color: 0x111111, roughness: 1, transparent: true, opacity: 0.9 }),
  )
  crater.position.copy(pos)
  crater.position.y += 0.2
  crater.traverse(o => o.layers.set(1))
  scene.add(crater)

  return {
    flash, fireball, smoke, shockwave, fires, debris, crater,
    center: pos.clone(), age: 0, alive: true,
  }
}

function tickExplosion(e: ExplosionState, dt: number, scene: Scene): void {
  e.age += dt

  // --- flash ---
  if (e.age < FLASH_LIFE) {
    const t = e.age / FLASH_LIFE
    const r = 3 + t * 55
    e.flash.scale.setScalar(r)
    ;(e.flash.material as MeshStandardMaterial).opacity = 1 - t
  } else if (e.flash.parent) {
    scene.remove(e.flash)
  }

  // --- fireball ---
  if (e.age < FIREBALL_LIFE) {
    const t = e.age / FIREBALL_LIFE
    const r = 5 + t * 75
    e.fireball.scale.setScalar(r)
    e.fireball.position.y = e.center.y + 6 + t * 60
    const mat = e.fireball.material as MeshStandardMaterial
    mat.opacity = t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4
    mat.color.setHSL(0.06 - t * 0.05, 1, 0.5 - t * 0.2)
  } else if (e.fireball.parent) {
    scene.remove(e.fireball)
  }

  // --- smoke ---
  if (e.age < SMOKE_LIFE) {
    const t = e.age / SMOKE_LIFE
    e.smoke.scale.setScalar(1 + t * 130)
    e.smoke.position.y = e.center.y + 30 + t * 120
    ;(e.smoke.material as MeshStandardMaterial).opacity = t < 0.2
      ? t / 0.2 * 0.65
      : 0.65 * (1 - (t - 0.2) / 0.8)
  } else if (e.smoke.parent) {
    scene.remove(e.smoke)
  }

  // --- shockwave ring ---
  if (e.age < SHOCK_LIFE) {
    const t = e.age / SHOCK_LIFE
    e.shockwave.scale.setScalar(1 + t * 300)
    ;(e.shockwave.material as MeshStandardMaterial).opacity = 0.7 * (1 - t)
  } else if (e.shockwave.parent) {
    scene.remove(e.shockwave)
  }

  // --- secondary fires ---
  for (const f of e.fires) {
    if (!f.parent) continue
    const t = e.age / 3.5
    f.scale.setScalar(Math.sin(t * Math.PI) * (1 + Math.random() * 0.3) * 3)
    ;(f.material as MeshStandardMaterial).opacity = t < 1 ? 1 : Math.max(0, 1 - (t - 1) / 0.4)
    if (t >= 1.4) scene.remove(f)
  }

  // --- debris ---
  for (const d of e.debris) {
    if (!d.mesh.parent) continue
    d.age += dt
    d.vel.y += BOMB.GRAVITY * dt
    d.mesh.position.addScaledVector(d.vel, dt)
    d.mesh.rotation.x += d.spin.x * dt
    d.mesh.rotation.y += d.spin.y * dt
    d.mesh.rotation.z += d.spin.z * dt
    d.vel.x *= 0.995
    d.vel.z *= 0.995
    const lifeT = d.age / d.life
    ;(d.mesh.material as MeshStandardMaterial).opacity = Math.max(0, 1 - lifeT * lifeT)
    if (d.age >= d.life) scene.remove(d.mesh)
  }

  // done when smoke is gone
  if (e.age >= SMOKE_LIFE) {
    e.alive = false
  }
}

// ─── public manager ───────────────────────────────────────────────────────

export class BombManager {
  private scene: Scene
  private active: FallingBomb[] = []
  private explosions: ExplosionState[] = []
  private rc = new Raycaster()

  constructor(scene: Scene) {
    this.scene = scene
    ;(this.rc as unknown as { firstHitOnly: boolean }).firstHitOnly = true
  }

  public drop(drop: BombDrop): void {
    const group = makeBombMesh()
    group.position.copy(drop.pos)
    group.traverse(o => o.layers.set(1))
    this.scene.add(group)
    this.active.push({ group, vel: drop.vel.clone(), alive: true })
  }

  /**
   * Advance physics + VFX. Returns camera-shake magnitude (0 = no shake).
   */
  public update(dt: number, terrain: Object3D): number {
    let shake = 0

    // falling bombs
    for (const b of this.active) {
      b.vel.y += BOMB.GRAVITY * dt
      b.group.position.addScaledVector(b.vel, dt)
      b.group.rotation.x += dt * 2.5
      b.group.rotation.z += dt * 1.8

      // impact check: cast downward from just above
      this.rc.set(b.group.position.clone().setY(b.group.position.y + 3), BOMB.DOWN)
      this.rc.far = 8
      const hits = this.rc.intersectObject(terrain, true)
      if (hits.length > 0) {
        const pt = hits[0].point
        this.scene.remove(b.group)
        b.alive = false
        deformTiles(pt, terrain)
        this.explosions.push(createExplosion(pt, terrain, this.scene))
        shake = Math.max(shake, 2.5)
      }
    }
    this.active = this.active.filter(b => b.alive)

    // explosion VFX tick
    for (const e of this.explosions) {
      if (e.alive) tickExplosion(e, dt, this.scene)
    }
    this.explosions = this.explosions.filter(e => e.alive)

    return shake
  }

  public dispose(): void {
    for (const b of this.active) this.scene.remove(b.group)
    this.active = []
    // craters and remaining meshes left in scene intentionally
  }
}
