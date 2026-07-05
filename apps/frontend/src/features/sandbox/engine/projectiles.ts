import {
  AdditiveBlending, CanvasTexture, CircleGeometry, Group, Mesh,
  MeshBasicMaterial, Object3D, Raycaster, Scene, SphereGeometry, Sprite,
  SpriteMaterial, Vector3,
} from 'three'

const GRAVITY = -25
const MAX_LIFE = 8
const MAX_SCORCH = 25

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
  private shellGeo = new SphereGeometry(0.4, 8, 8)
  private shellMat = new MeshBasicMaterial({ color: 0xffcc66 })

  constructor(scene: Scene, terrain: Object3D) {
    this.terrain = terrain
    this.root.traverse(o => o.layers.set(1))
    scene.add(this.root)
    ;(this.raycaster as unknown as { firstHitOnly: boolean }).firstHitOnly = true

    this.fireTexture = radialTexture('rgba(255,220,120,1)', 'rgba(255,80,0,0)')
    this.smokeTexture = radialTexture('rgba(70,70,70,0.85)', 'rgba(40,40,40,0)')
    this.scorchTexture = radialTexture('rgba(10,10,10,0.9)', 'rgba(20,20,20,0)')
  }

  public fire(origin: Vector3, direction: Vector3, speed: number): void {
    const mesh = new Mesh(this.shellGeo, this.shellMat)
    mesh.position.copy(origin)
    mesh.layers.set(1)
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
        this.root.remove(pt.sprite)
        this.particles.splice(i, 1)
        continue
      }
      const f = pt.life / pt.maxLife
      pt.sprite.position.addScaledVector(pt.velocity, dt)
      pt.velocity.multiplyScalar(1 - 1.5 * dt)
      pt.velocity.y += 6 * dt // smoke rises
      const mat = pt.sprite.material as SpriteMaterial
      mat.opacity = 1 - f
      pt.sprite.scale.setScalar(pt.sprite.scale.x + pt.grow * dt)
    }
  }

  public explode(at: Vector3, normal: Vector3): void {
    // flash
    this.spawnParticle(at, new Vector3(), 0.35, 26, this.fireTexture, true, 70)
    // fireball
    for (let i = 0; i < 14; i++) {
      this.spawnParticle(
        at, randomDir().multiplyScalar(8 + Math.random() * 14),
        0.5 + Math.random() * 0.5, 5 + Math.random() * 6, this.fireTexture, true, 8,
      )
    }
    // smoke
    for (let i = 0; i < 16; i++) {
      this.spawnParticle(
        at.clone().addScaledVector(normal, 1.5),
        randomDir().multiplyScalar(4 + Math.random() * 7),
        1.6 + Math.random() * 1.6, 7 + Math.random() * 8, this.smokeTexture, false, 10,
      )
    }
    // persistent scorch decal on the surface
    const scorch = new Mesh(
      new CircleGeometry(5 + Math.random() * 3, 24),
      new MeshBasicMaterial({
        map: this.scorchTexture, transparent: true, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -2,
      }),
    )
    scorch.position.copy(at).addScaledVector(normal, 0.25)
    scorch.lookAt(at.clone().add(normal))
    scorch.layers.set(1)
    this.root.add(scorch)
    this.scorches.push(scorch)
    if (this.scorches.length > MAX_SCORCH) {
      const old = this.scorches.shift()!
      this.root.remove(old)
    }
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
    sprite.layers.set(1)
    sprite.renderOrder = 900
    this.root.add(sprite)
    this.particles.push({ sprite, velocity, life: 0, maxLife, grow })
  }
}

function randomDir(): Vector3 {
  return new Vector3(Math.random() - 0.5, Math.random() * 0.7, Math.random() - 0.5).normalize()
}

function radialTexture(inner: string, outer: string): CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 128
  const ctx = canvas.getContext('2d')!
  const grad = ctx.createRadialGradient(64, 64, 4, 64, 64, 64)
  grad.addColorStop(0, inner)
  grad.addColorStop(1, outer)
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, 128, 128)
  return new CanvasTexture(canvas)
}
