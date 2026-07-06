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

import { BOMB, SANDBOX_BOMB } from '@/constants'

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
      const arr = new Float32Array(posAttr.count * SANDBOX_BOMB.BUFFER_ATTRIBUTE_ITEM_SIZE)
      for (let i = 0; i < posAttr.count; i++) {
        arr[i * SANDBOX_BOMB.BUFFER_ATTRIBUTE_ITEM_SIZE]     = posAttr.getX(i)
        arr[i * SANDBOX_BOMB.BUFFER_ATTRIBUTE_ITEM_SIZE + 1] = posAttr.getY(i)
        arr[i * SANDBOX_BOMB.BUFFER_ATTRIBUTE_ITEM_SIZE + 2] = posAttr.getZ(i)
      }
      posAttr = new BufferAttribute(arr, SANDBOX_BOMB.BUFFER_ATTRIBUTE_ITEM_SIZE)
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
      if (hDist > SANDBOX_BOMB.HORIZONTAL_EPSILON) outDir.divideScalar(hDist); else outDir.set(1, 0, 0)

      let dy = 0
      let dhoriz = 0

      if (dist < BOMB.CRATER_R) {
        // Crater: push DOWN, slight outward shove
        const t = 1 - dist / BOMB.CRATER_R
        dy     = -BOMB.CRATER_D * t * t
        dhoriz =  BOMB.DAMAGE_RISE * SANDBOX_BOMB.CRATER_HORIZONTAL_FACTOR * t
      } else {
        // Damage ring: push OUT and UP like a shockwave
        const t = 1 - (dist - BOMB.CRATER_R) / (BOMB.DAMAGE_R - BOMB.CRATER_R)
        dy     = BOMB.DAMAGE_RISE * t * SANDBOX_BOMB.DAMAGE_VERTICAL_FACTOR
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
    new CylinderGeometry(
      SANDBOX_BOMB.BODY_RADIUS_TOP,
      SANDBOX_BOMB.BODY_RADIUS_BOTTOM,
      SANDBOX_BOMB.BODY_LENGTH,
      SANDBOX_BOMB.BODY_SEGMENTS,
    ),
    new MeshStandardMaterial({ color: SANDBOX_BOMB.BODY_COLOR, roughness: SANDBOX_BOMB.BODY_ROUGHNESS }),
  )
  body.rotation.x = Math.PI / 2
  const fin1 = new Mesh(
    new BoxGeometry(SANDBOX_BOMB.FIN_W, SANDBOX_BOMB.FIN_H, SANDBOX_BOMB.FIN_D),
    new MeshStandardMaterial({ color: SANDBOX_BOMB.FIN_COLOR }),
  )
  fin1.position.set(0, SANDBOX_BOMB.FIN_Y, SANDBOX_BOMB.FIN_Z)
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
  const flash = new Mesh(
    new SphereGeometry(1, SANDBOX_BOMB.FLASH_SEGMENTS, SANDBOX_BOMB.FLASH_RINGS),
    mat(SANDBOX_BOMB.FLASH_COLOR, SANDBOX_BOMB.FLASH_EMISSIVE),
  )
  flash.position.copy(pos)
  flash.position.y += SANDBOX_BOMB.FLASH_HEIGHT
  flash.traverse(o => o.layers.set(1))
  scene.add(flash)

  // fireball
  const fireball = new Mesh(
    new SphereGeometry(1, SANDBOX_BOMB.FIREBALL_SEGMENTS, SANDBOX_BOMB.FIREBALL_RINGS),
    mat(SANDBOX_BOMB.FIREBALL_COLOR, SANDBOX_BOMB.FIREBALL_EMISSIVE),
  )
  fireball.position.copy(pos)
  fireball.position.y += SANDBOX_BOMB.FIREBALL_HEIGHT
  fireball.traverse(o => o.layers.set(1))
  scene.add(fireball)

  // smoke column
  const smoke = new Mesh(
    new SphereGeometry(1, SANDBOX_BOMB.SMOKE_SEGMENTS, SANDBOX_BOMB.SMOKE_RINGS),
    mat(SANDBOX_BOMB.SMOKE_COLOR, 0x000000, SANDBOX_BOMB.SMOKE_OPACITY),
  )
  smoke.position.copy(pos)
  smoke.position.y += SANDBOX_BOMB.SMOKE_HEIGHT
  smoke.traverse(o => o.layers.set(1))
  scene.add(smoke)

  // ground shockwave ring
  const shockwave = new Mesh(
    new RingGeometry(
      SANDBOX_BOMB.SHOCK_INNER_RADIUS,
      SANDBOX_BOMB.SHOCK_OUTER_RADIUS,
      SANDBOX_BOMB.SHOCK_SEGMENTS,
    ),
    mat(SANDBOX_BOMB.SHOCK_COLOR, SANDBOX_BOMB.SHOCK_EMISSIVE, SANDBOX_BOMB.SHOCK_OPACITY),
  )
  shockwave.rotation.x = -Math.PI / 2
  shockwave.position.copy(pos)
  shockwave.position.y += SANDBOX_BOMB.SHOCK_HEIGHT
  shockwave.traverse(o => o.layers.set(1))
  scene.add(shockwave)

  // Secondary fires scattered within blast radius
  const fires: Mesh[] = []
  for (let i = 0; i < SANDBOX_BOMB.SECONDARY_FIRE_COUNT; i++) {
    const angle = (i / SANDBOX_BOMB.SECONDARY_FIRE_COUNT) * Math.PI * 2
    const dist  = SANDBOX_BOMB.SECONDARY_FIRE_MIN_DISTANCE + Math.random() * SANDBOX_BOMB.SECONDARY_FIRE_RANDOM_DISTANCE
    const f = new Mesh(
      new SphereGeometry(
        SANDBOX_BOMB.SECONDARY_FIRE_RADIUS_BASE +
          Math.random() * SANDBOX_BOMB.SECONDARY_FIRE_RADIUS_RANDOM,
        SANDBOX_BOMB.SECONDARY_FIRE_SEGMENTS,
        SANDBOX_BOMB.SECONDARY_FIRE_RINGS,
      ),
      mat(SANDBOX_BOMB.SECONDARY_FIRE_COLOR, SANDBOX_BOMB.SECONDARY_FIRE_EMISSIVE),
    )
    f.position.set(
      pos.x + Math.cos(angle) * dist,
      pos.y + SANDBOX_BOMB.SECONDARY_FIRE_HEIGHT_BASE + Math.random() * SANDBOX_BOMB.SECONDARY_FIRE_HEIGHT_RANDOM,
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

  for (let i = 0; i < SANDBOX_BOMB.DEBRIS_COUNT; i++) {
    const angle  = Math.random() * Math.PI * 2
    const elev   = Math.random() * Math.PI * SANDBOX_BOMB.DEBRIS_ELEVATION_FACTOR  // mostly upward hemisphere
    const outDir = new Vector3(
      Math.cos(elev) * Math.cos(angle),
      Math.sin(elev),
      Math.cos(elev) * Math.sin(angle),
    )

    // Find a tile surface near the blast to decide spawn point
    rc.set(pos.clone().add(new Vector3(0, SANDBOX_BOMB.DEBRIS_RAYCAST_HEIGHT, 0)), outDir)
    rc.far = BOMB.BLAST_RADIUS
    const hits = rc.intersectObject(terrain, true)
    const spawnPt = hits.length > 0
      ? hits[0].point.clone().add(new Vector3(0, SANDBOX_BOMB.DEBRIS_SPAWN_Y_OFFSET, 0))
      : pos.clone().addScaledVector(
          outDir,
          SANDBOX_BOMB.DEBRIS_FALLBACK_MIN_DISTANCE +
            Math.random() * SANDBOX_BOMB.DEBRIS_FALLBACK_RANDOM_DISTANCE,
        )

    const w = SANDBOX_BOMB.DEBRIS_WIDTH_BASE + Math.random() * SANDBOX_BOMB.DEBRIS_WIDTH_RANDOM
    const h = SANDBOX_BOMB.DEBRIS_HEIGHT_BASE + Math.random() * SANDBOX_BOMB.DEBRIS_HEIGHT_RANDOM
    const grey = SANDBOX_BOMB.DEBRIS_GREY_BASE + Math.floor(Math.random() * SANDBOX_BOMB.DEBRIS_GREY_RANDOM)
    const chunk = new Mesh(
      new BoxGeometry(w, h, w * (SANDBOX_BOMB.DEBRIS_DEPTH_BASE + Math.random())),
      new MeshStandardMaterial({ color: grey, roughness: 0.85, transparent: true }),
    )
    chunk.position.copy(spawnPt)
    chunk.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI)
    chunk.traverse(o => o.layers.set(1))
    scene.add(chunk)

    const speed = SANDBOX_BOMB.DEBRIS_SPEED_BASE + Math.random() * SANDBOX_BOMB.DEBRIS_SPEED_RANDOM
    debris.push({
      mesh: chunk,
      vel: outDir.clone().multiplyScalar(speed),
      spin: new Vector3(
        (Math.random() - SANDBOX_BOMB.DEBRIS_SPIN_CENTER) * SANDBOX_BOMB.DEBRIS_SPIN_RANGE,
        (Math.random() - SANDBOX_BOMB.DEBRIS_SPIN_CENTER) * SANDBOX_BOMB.DEBRIS_SPIN_RANGE,
        (Math.random() - SANDBOX_BOMB.DEBRIS_SPIN_CENTER) * SANDBOX_BOMB.DEBRIS_SPIN_RANGE,
      ),
      age: 0,
      life: DEBRIS_LIFE * (SANDBOX_BOMB.DEBRIS_LIFE_BASE + Math.random() * SANDBOX_BOMB.DEBRIS_LIFE_RANDOM),
    })
  }

  // persistent crater disc
  const crater = new Mesh(
    new CylinderGeometry(
      SANDBOX_BOMB.CRATER_RADIUS_TOP,
      SANDBOX_BOMB.CRATER_RADIUS_BOTTOM,
      SANDBOX_BOMB.CRATER_DEPTH,
      SANDBOX_BOMB.CRATER_SEGMENTS,
    ),
    new MeshStandardMaterial({
      color: SANDBOX_BOMB.CRATER_COLOR,
      roughness: 1,
      transparent: true,
      opacity: SANDBOX_BOMB.CRATER_OPACITY,
    }),
  )
  crater.position.copy(pos)
  crater.position.y += SANDBOX_BOMB.CRATER_Y_OFFSET
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
    const r = SANDBOX_BOMB.FLASH_GROWTH_BASE + t * SANDBOX_BOMB.FLASH_GROWTH
    e.flash.scale.setScalar(r)
    ;(e.flash.material as MeshStandardMaterial).opacity = 1 - t
  } else if (e.flash.parent) {
    scene.remove(e.flash)
  }

  // --- fireball ---
  if (e.age < FIREBALL_LIFE) {
    const t = e.age / FIREBALL_LIFE
    const r = SANDBOX_BOMB.FIREBALL_GROWTH_BASE + t * SANDBOX_BOMB.FIREBALL_GROWTH
    e.fireball.scale.setScalar(r)
    e.fireball.position.y = e.center.y + SANDBOX_BOMB.FIREBALL_HEIGHT + t * SANDBOX_BOMB.FIREBALL_RISE
    const mat = e.fireball.material as MeshStandardMaterial
    mat.opacity =
      t < SANDBOX_BOMB.FIREBALL_FADE_START
        ? 1
        : 1 - (t - SANDBOX_BOMB.FIREBALL_FADE_START) / SANDBOX_BOMB.FIREBALL_FADE_RANGE
    mat.color.setHSL(
      SANDBOX_BOMB.FIREBALL_HUE_BASE - t * SANDBOX_BOMB.FIREBALL_HUE_SHIFT,
      1,
      SANDBOX_BOMB.FIREBALL_LIGHTNESS_BASE - t * SANDBOX_BOMB.FIREBALL_LIGHTNESS_SHIFT,
    )
  } else if (e.fireball.parent) {
    scene.remove(e.fireball)
  }

  // --- smoke ---
  if (e.age < SMOKE_LIFE) {
    const t = e.age / SMOKE_LIFE
    e.smoke.scale.setScalar(1 + t * SANDBOX_BOMB.SMOKE_GROWTH)
    e.smoke.position.y = e.center.y + SANDBOX_BOMB.SMOKE_HEIGHT + t * SANDBOX_BOMB.SMOKE_RISE
    ;(e.smoke.material as MeshStandardMaterial).opacity = t < SANDBOX_BOMB.SMOKE_FADE_IN
      ? t / SANDBOX_BOMB.SMOKE_FADE_IN * SANDBOX_BOMB.SMOKE_OPACITY
      : SANDBOX_BOMB.SMOKE_OPACITY *
        (1 - (t - SANDBOX_BOMB.SMOKE_FADE_IN) / SANDBOX_BOMB.SMOKE_FADE_OUT_RANGE)
  } else if (e.smoke.parent) {
    scene.remove(e.smoke)
  }

  // --- shockwave ring ---
  if (e.age < SHOCK_LIFE) {
    const t = e.age / SHOCK_LIFE
    e.shockwave.scale.setScalar(1 + t * SANDBOX_BOMB.SHOCK_GROWTH)
    ;(e.shockwave.material as MeshStandardMaterial).opacity = SANDBOX_BOMB.SHOCK_OPACITY * (1 - t)
  } else if (e.shockwave.parent) {
    scene.remove(e.shockwave)
  }

  // --- secondary fires ---
  for (const f of e.fires) {
    if (!f.parent) continue
    const t = e.age / SANDBOX_BOMB.FIRE_LIFE
    f.scale.setScalar(
      Math.sin(t * Math.PI) *
        (1 + Math.random() * SANDBOX_BOMB.FIRE_FLICKER_RANDOM) *
        SANDBOX_BOMB.FIRE_FLICKER_SCALE,
    )
    ;(f.material as MeshStandardMaterial).opacity =
      t < SANDBOX_BOMB.FIRE_FADE_START
        ? 1
        : Math.max(0, 1 - (t - SANDBOX_BOMB.FIRE_FADE_START) / SANDBOX_BOMB.FIRE_FADE_RANGE)
    if (t >= SANDBOX_BOMB.FIRE_REMOVE_T) scene.remove(f)
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
    d.vel.x *= SANDBOX_BOMB.DEBRIS_DAMPING
    d.vel.z *= SANDBOX_BOMB.DEBRIS_DAMPING
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
      b.group.rotation.x += dt * SANDBOX_BOMB.FALL_ROTATION_X
      b.group.rotation.z += dt * SANDBOX_BOMB.FALL_ROTATION_Z

      // impact check: cast downward from just above
      this.rc.set(
        b.group.position.clone().setY(b.group.position.y + SANDBOX_BOMB.IMPACT_RAY_HEIGHT),
        BOMB.DOWN,
      )
      this.rc.far = SANDBOX_BOMB.IMPACT_RAY_DISTANCE
      const hits = this.rc.intersectObject(terrain, true)
      if (hits.length > 0) {
        const pt = hits[0].point
        this.scene.remove(b.group)
        b.alive = false
        deformTiles(pt, terrain)
        this.explosions.push(createExplosion(pt, terrain, this.scene))
        shake = Math.max(shake, SANDBOX_BOMB.IMPACT_SHAKE)
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
