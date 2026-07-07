import {
  AdditiveBlending, CanvasTexture, CircleGeometry, Group, Mesh,
  MeshBasicMaterial, Object3D, Raycaster, Scene, SphereGeometry, Sprite,
  SpriteMaterial, Vector3,
} from 'three'

import { disposeObject3D } from './disposeThree'

import { SANDBOX_PROJECTILES } from '@/constants/sandbox'

const GRAVITY = SANDBOX_PROJECTILES.GRAVITY
const MAX_LIFE = SANDBOX_PROJECTILES.MAX_LIFE
const MAX_SCORCH = SANDBOX_PROJECTILES.MAX_SCORCH

interface Projectile {
  mesh: Mesh
  velocity: Vector3
  life: number
}

interface Particle {
  sprite: Sprite
  velocity: Vector3
  life: number
  maxLife: number
  grow: number
}

export class ProjectileManager {
  private terrain: Object3D
  private raycaster = new Raycaster()
  private projectiles: Projectile[] = []
  private particles: Particle[] = []
  private scorches: Mesh[] = []
  private root = new Group()

  private fireTexture: CanvasTexture
  private smokeTexture: CanvasTexture
  private scorchTexture: CanvasTexture
  private shellGeo = new SphereGeometry(
    SANDBOX_PROJECTILES.SHELL_RADIUS,
    SANDBOX_PROJECTILES.SHELL_SEGMENTS,
    SANDBOX_PROJECTILES.SHELL_SEGMENTS,
  )
  private shellMat = new MeshBasicMaterial({ color: SANDBOX_PROJECTILES.SHELL_COLOR })

  constructor(scene: Scene, terrain: Object3D) {
    this.terrain = terrain
    this.root.traverse(o => o.layers.set(SANDBOX_PROJECTILES.LAYER))
    scene.add(this.root)
    ;(this.raycaster as unknown as { firstHitOnly: boolean }).firstHitOnly = true

    this.fireTexture = radialTexture('rgba(255,220,120,1)', 'rgba(255,80,0,0)')
    this.smokeTexture = radialTexture('rgba(70,70,70,0.85)', 'rgba(40,40,40,0)')
    this.scorchTexture = radialTexture('rgba(10,10,10,0.9)', 'rgba(20,20,20,0)')
  }

  public fire(origin: Vector3, direction: Vector3, speed: number): void {
    const mesh = new Mesh(this.shellGeo, this.shellMat)
    mesh.position.copy(origin)
    mesh.layers.set(SANDBOX_PROJECTILES.LAYER)
    this.root.add(mesh)
    this.projectiles.push({
      mesh,
      velocity: direction.clone().normalize().multiplyScalar(speed),
      life: 0,
    })
  }

  public update(dt: number): void {
    // projectiles: integrate, segment-raycast for impact
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i]
      p.life += dt
      p.velocity.y += GRAVITY * dt

      const prev = p.mesh.position.clone()
      const step = p.velocity.clone().multiplyScalar(dt)
      const next = prev.clone().add(step)

      this.raycaster.set(prev, step.clone().normalize())
      this.raycaster.far = step.length()
      const hits = this.raycaster.intersectObject(this.terrain, true)

      if (hits.length > 0) {
        const hit = hits[0]
        let normal = new Vector3(0, 1, 0)
        if (hit.face) {
          normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld)
        }
        this.explode(hit.point, normal)
        this.root.remove(p.mesh)
        this.projectiles.splice(i, 1)
      } else if (p.life > MAX_LIFE) {
        this.root.remove(p.mesh)
        this.projectiles.splice(i, 1)
      } else {
        p.mesh.position.copy(next)
      }
    }

    // particles: integrate, fade, scale
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const pt = this.particles[i]
      pt.life += dt
      if (pt.life >= pt.maxLife) {
        disposeObject3D(pt.sprite, { disposeTextures: false })
        this.particles.splice(i, 1)
        continue
      }
      const f = pt.life / pt.maxLife
      pt.sprite.position.addScaledVector(pt.velocity, dt)
      pt.velocity.multiplyScalar(1 - SANDBOX_PROJECTILES.PARTICLE_DRAG * dt)
      pt.velocity.y += SANDBOX_PROJECTILES.SMOKE_RISE * dt // smoke rises
      const mat = pt.sprite.material as SpriteMaterial
      mat.opacity = 1 - f
      pt.sprite.scale.setScalar(pt.sprite.scale.x + pt.grow * dt)
    }
  }

  public explode(at: Vector3, normal: Vector3): void {
    // flash
    this.spawnParticle(
      at,
      new Vector3(),
      SANDBOX_PROJECTILES.FLASH_LIFE,
      SANDBOX_PROJECTILES.FLASH_SIZE,
      this.fireTexture,
      true,
      SANDBOX_PROJECTILES.FLASH_GROW,
    )
    // fireball
    for (let i = 0; i < SANDBOX_PROJECTILES.FIREBALL_COUNT; i++) {
      this.spawnParticle(
        at,
        randomDir().multiplyScalar(
          SANDBOX_PROJECTILES.FIREBALL_SPEED_BASE +
            Math.random() * SANDBOX_PROJECTILES.FIREBALL_SPEED_RANDOM,
        ),
        SANDBOX_PROJECTILES.FIREBALL_LIFE_BASE +
          Math.random() * SANDBOX_PROJECTILES.FIREBALL_LIFE_RANDOM,
        SANDBOX_PROJECTILES.FIREBALL_SIZE_BASE +
          Math.random() * SANDBOX_PROJECTILES.FIREBALL_SIZE_RANDOM,
        this.fireTexture,
        true,
        SANDBOX_PROJECTILES.FIREBALL_GROW,
      )
    }
    // smoke
    for (let i = 0; i < SANDBOX_PROJECTILES.SMOKE_COUNT; i++) {
      this.spawnParticle(
        at.clone().addScaledVector(normal, SANDBOX_PROJECTILES.SMOKE_NORMAL_OFFSET),
        randomDir().multiplyScalar(
          SANDBOX_PROJECTILES.SMOKE_SPEED_BASE +
            Math.random() * SANDBOX_PROJECTILES.SMOKE_SPEED_RANDOM,
        ),
        SANDBOX_PROJECTILES.SMOKE_LIFE_BASE +
          Math.random() * SANDBOX_PROJECTILES.SMOKE_LIFE_RANDOM,
        SANDBOX_PROJECTILES.SMOKE_SIZE_BASE +
          Math.random() * SANDBOX_PROJECTILES.SMOKE_SIZE_RANDOM,
        this.smokeTexture,
        false,
        SANDBOX_PROJECTILES.SMOKE_GROW,
      )
    }
    // persistent scorch decal on the surface
    const scorch = new Mesh(
      new CircleGeometry(
        SANDBOX_PROJECTILES.SCORCH_RADIUS_BASE +
          Math.random() * SANDBOX_PROJECTILES.SCORCH_RADIUS_RANDOM,
        SANDBOX_PROJECTILES.SCORCH_SEGMENTS,
      ),
      new MeshBasicMaterial({
        map: this.scorchTexture, transparent: true, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: SANDBOX_PROJECTILES.SCORCH_POLYGON_OFFSET_FACTOR,
      }),
    )
    scorch.position.copy(at).addScaledVector(normal, SANDBOX_PROJECTILES.SCORCH_NORMAL_OFFSET)
    scorch.lookAt(at.clone().add(normal))
    scorch.layers.set(SANDBOX_PROJECTILES.LAYER)
    this.root.add(scorch)
    this.scorches.push(scorch)
    if (this.scorches.length > MAX_SCORCH) {
      const old = this.scorches.shift()
      if (old) disposeObject3D(old, { disposeTextures: false })
    }
  }

  public dispose(): void {
    for (const projectile of this.projectiles) {
      this.root.remove(projectile.mesh)
    }
    this.projectiles = []

    for (const particle of this.particles) {
      disposeObject3D(particle.sprite, { disposeTextures: false })
    }
    this.particles = []

    for (const scorch of this.scorches) {
      disposeObject3D(scorch, { disposeTextures: false })
    }
    this.scorches = []

    this.shellGeo.dispose()
    this.shellMat.dispose()
    this.fireTexture.dispose()
    this.smokeTexture.dispose()
    this.scorchTexture.dispose()
    this.root.removeFromParent()
  }

  private spawnParticle(
    at: Vector3, velocity: Vector3, maxLife: number, size: number,
    texture: CanvasTexture, additive: boolean, grow: number,
  ): void {
    const sprite = new Sprite(new SpriteMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      blending: additive ? AdditiveBlending : undefined,
    }))
    sprite.position.copy(at)
    sprite.scale.setScalar(size)
    sprite.layers.set(SANDBOX_PROJECTILES.LAYER)
    sprite.renderOrder = SANDBOX_PROJECTILES.PARTICLE_RENDER_ORDER
    this.root.add(sprite)
    this.particles.push({ sprite, velocity, life: 0, maxLife, grow })
  }
}

function randomDir(): Vector3 {
  return new Vector3(
    Math.random() - SANDBOX_PROJECTILES.RANDOM_DIR_CENTER,
    Math.random() * SANDBOX_PROJECTILES.RANDOM_DIR_Y_SCALE,
    Math.random() - SANDBOX_PROJECTILES.RANDOM_DIR_CENTER,
  ).normalize()
}

function radialTexture(inner: string, outer: string): CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = SANDBOX_PROJECTILES.DECAL_CANVAS_SIZE
  canvas.height = SANDBOX_PROJECTILES.DECAL_CANVAS_SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2D canvas context unavailable')
  const grad = ctx.createRadialGradient(
    SANDBOX_PROJECTILES.DECAL_CANVAS_SIZE / 2,
    SANDBOX_PROJECTILES.DECAL_CANVAS_SIZE / 2,
    SANDBOX_PROJECTILES.DECAL_SIZE,
    SANDBOX_PROJECTILES.DECAL_CANVAS_SIZE / 2,
    SANDBOX_PROJECTILES.DECAL_CANVAS_SIZE / 2,
    SANDBOX_PROJECTILES.DECAL_CANVAS_SIZE / 2,
  )
  grad.addColorStop(0, inner)
  grad.addColorStop(1, outer)
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, SANDBOX_PROJECTILES.DECAL_CANVAS_SIZE, SANDBOX_PROJECTILES.DECAL_CANVAS_SIZE)
  return new CanvasTexture(canvas)
}
