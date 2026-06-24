import {
  BoxGeometry, CylinderGeometry, Group, Mesh, MeshStandardMaterial,
  Object3D, Scene, Vector3,
} from 'three'

import type { ProjectileManager } from './projectiles'
import type { ModelLibrary } from './modelCatalog'
import { type BombDrop, Vehicle, type VehicleState, type VehicleType } from './vehicleBase'
import { SpiderVehicle } from './spiderman'

export { Vehicle, DOWN } from './vehicleBase'
export type { VehicleType, VehicleState, BombDrop } from './vehicleBase'

// ---------- TANK ----------

class TankVehicle extends Vehicle {
  public readonly label = 'M1 TANK'
  public readonly cameraDist = 45
  public override readonly fireCooldown = 0.9
  private grounded = false

  constructor(keys: Set<string>, lib: ModelLibrary) {
    super(keys)
    this.object.add(lib.instance('tank', buildTankPrimitive))
  }

  public override update(dt: number, terrain: Object3D): void {
    groundDrive(this, dt, terrain, {
      maxSpeed: 18, accel: 10, brake: 8, reverseFactor: 0.5,
      turnRate: 1.4, damping: 0.88, clearance: 0.9, maxClimb: 3,
      grounded: this.grounded, setGrounded: g => { this.grounded = g },
    })
  }

  public override fireRay() {
    const dir = this.forwardXZ()
    dir.y = 0.10
    const origin = this.position.clone()
      .addScaledVector(this.forwardXZ(), 4.6)
    origin.y += 1.8
    return { origin, direction: dir, speed: 130 }
  }
}

// ---------- SPORTS CAR ----------

class CarVehicle extends Vehicle {
  public readonly label = 'GT SPORTS'
  public readonly cameraDist = 22
  private grounded = false

  constructor(keys: Set<string>, lib: ModelLibrary) {
    super(keys)
    this.object.add(lib.instance('car', buildCarPrimitive))
  }

  public override update(dt: number, terrain: Object3D): void {
    // speed-sensitive steering: nimble in town, stable at 250 km/h
    const speedFrac = Math.abs(this._speed) / 70
    groundDrive(this, dt, terrain, {
      maxSpeed: 70, accel: 22, brake: 35, reverseFactor: 0.25,
      turnRate: 2.2 - 1.5 * Math.min(speedFrac, 1), damping: 0.985, clearance: 0.45, maxClimb: 2,
      grounded: this.grounded, setGrounded: g => { this.grounded = g },
    })
  }
}

// ---------- JET ----------

const AFTERBURNER_MAX = 580   // m/s (~Mach 1.7)
const NORMAL_MAX = 170
const ROLL_SPEED = (Math.PI * 2) / 1.1  // full barrel roll in 1.1 s

class JetVehicle extends Vehicle {
  public readonly label = 'F-16 JET'
  public readonly cameraDist = 90
  public override readonly fireCooldown = 0.28
  private pitch = 0
  private bank = 0
  private altitude = 0

  // barrel roll state
  private rollPhase = 0   // remaining radians to rotate (0 = not rolling)
  private rollDir = 1     // +1 = left roll, -1 = right roll
  private rollOffset = 0  // cumulative Z rotation from barrel roll

  // bomb cooldown
  private bombCooldown = 0

  constructor(keys: Set<string>, lib: ModelLibrary) {
    super(keys)
    this.object.add(lib.instance('jet', buildJetPrimitive))
    this._speed = 80
  }

  public override update(dt: number, terrain: Object3D): void {
    const throttleUp   = this.keys.has('w')
    const throttleDown = this.keys.has('s')
    const left         = this.keys.has('a')
    const right        = this.keys.has('d')
    const pitchDown    = this.keys.has('arrowup')
    const pitchUp      = this.keys.has('arrowdown')
    const afterburner  = this.keys.has('shift')
    const rollLeft     = this.keys.has('q')
    const rollRight    = this.keys.has('e')

    // --- throttle ---
    const maxSpd = afterburner ? AFTERBURNER_MAX : NORMAL_MAX
    const accel  = afterburner ? 280 : 30
    if (throttleUp)   this._speed = Math.min(this._speed + accel * dt, maxSpd)
    if (throttleDown) this._speed = Math.max(this._speed - 50 * dt, 35)
    if (!throttleUp && !afterburner) {
      // decay back toward cruise when not actively burning
      if (this._speed > NORMAL_MAX) this._speed = Math.max(this._speed - 120 * dt, NORMAL_MAX)
    }

    // --- yaw / bank ---
    const turnInput = (left ? 1 : 0) - (right ? 1 : 0)
    const turnRate = afterburner ? 0.4 : 0.9  // less nimble at hypersonic speed
    this._heading += turnInput * turnRate * dt
    this.bank += (turnInput * -0.7 - this.bank) * Math.min(1, dt * 3)

    // --- pitch ---
    const pitchInput = (pitchUp ? 1 : 0) - (pitchDown ? 1 : 0)
    this.pitch += (pitchInput * 0.5 - this.pitch * 0.4) * Math.min(1, dt * 2.5)
    this.pitch = Math.max(-0.9, Math.min(0.9, this.pitch))

    // --- barrel roll (Q / E) ---
    if (this.rollPhase <= 0 && (rollLeft || rollRight)) {
      this.rollPhase = Math.PI * 2
      this.rollDir   = rollLeft ? 1 : -1
    }
    if (this.rollPhase > 0) {
      const step = Math.min(ROLL_SPEED * dt, this.rollPhase)
      this.rollOffset += this.rollDir * step
      this.rollPhase  -= step
    } else {
      // decay roll offset back to neutral when not rolling
      this.rollOffset *= Math.pow(0.05, dt)
    }

    // --- movement ---
    const dir = new Vector3(
      Math.sin(this._heading) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      Math.cos(this._heading) * Math.cos(this.pitch),
    )
    this.object.position.addScaledVector(dir, this._speed * dt)

    // --- terrain avoidance (filter overhead structures like bridges) ---
    const groundY = this.sampleGround(
      this.position.x, this.position.z, terrain,
      this.position.y + 600, this.position.y,
    )
    this.altitude = groundY !== null ? this.position.y - groundY : this.position.y
    if (groundY !== null && this.position.y < groundY + 10) {
      this.position.y = groundY + 10
      if (this.pitch < 0) this.pitch = 0.1
    }

    // --- apply rotation ---
    this.object.rotation.set(0, 0, 0)
    this.object.rotateY(this._heading)
    this.object.rotateX(-this.pitch)
    this.object.rotateZ(this.bank + this.rollOffset)

    // --- bomb drop (B) ---
    if (this.bombCooldown > 0) this.bombCooldown -= dt
    if (this.keys.has('b') && this.bombCooldown <= 0) {
      this.bombDrops.push({
        pos: this.position.clone().addScaledVector(dir, -4), // drop from belly
        vel: dir.clone().multiplyScalar(this._speed * 0.9),
      })
      this.bombCooldown = 1.2
    }
  }

  public override get state(): VehicleState {
    return {
      label: this.label,
      speed: this._speed,
      heading: this._heading,
      altitude: this.altitude,
      afterburner: this.keys.has('shift'),
      rolling: this.rollPhase > 0,
    }
  }

  public override fireRay() {
    const dir = new Vector3(
      Math.sin(this._heading) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      Math.cos(this._heading) * Math.cos(this.pitch),
    )
    const origin = this.position.clone().addScaledVector(dir, 9)
    return { origin, direction: dir, speed: this._speed + 150 }
  }
}

// ---------- shared ground driving ----------

interface DriveParams {
  maxSpeed: number
  accel: number
  brake: number
  reverseFactor: number
  turnRate: number
  damping: number
  clearance: number
  maxClimb: number
  grounded: boolean
  setGrounded: (g: boolean) => void
}

function groundDrive(v: Vehicle, dt: number, terrain: Object3D, p: DriveParams): void {
  const self = v as unknown as {
    keys: Set<string>
    _speed: number
    _heading: number
    object: Group
    sampleGround: (x: number, z: number, t: Object3D, from: number, floorY?: number) => number | null
  }
  const keys = self.keys

  const forward = keys.has('w') || keys.has('arrowup')
  const backward = keys.has('s') || keys.has('arrowdown')
  const left = keys.has('a') || keys.has('arrowleft')
  const right = keys.has('d') || keys.has('arrowright')

  if (forward) self._speed = Math.min(self._speed + p.accel * dt, p.maxSpeed)
  else if (backward) self._speed = Math.max(self._speed - p.brake * dt, -p.maxSpeed * p.reverseFactor)
  else self._speed *= p.damping

  if (Math.abs(self._speed) > 0.3) {
    if (left) self._heading += p.turnRate * dt * Math.sign(self._speed)
    if (right) self._heading -= p.turnRate * dt * Math.sign(self._speed)
  }
  self.object.rotation.set(0, self._heading, 0)

  const step = self._speed * dt
  const nx = self.object.position.x + Math.sin(self._heading) * step
  const nz = self.object.position.z + Math.cos(self._heading) * step

  const groundY = self.sampleGround(nx, nz, terrain, self.object.position.y + 80, self.object.position.y - p.clearance)
  if (groundY === null) {
    self.object.position.x = nx
    self.object.position.z = nz
    return
  }

  const rise = groundY - (self.object.position.y - p.clearance)
  if (p.grounded && rise > p.maxClimb) {
    self._speed = 0
    return
  }

  self.object.position.x = nx
  self.object.position.z = nz
  const targetY = groundY + p.clearance
  self.object.position.y = p.grounded
    ? self.object.position.y + (targetY - self.object.position.y) * Math.min(1, dt * 10)
    : targetY
  p.setGrounded(true)
}

// ---------- MANAGER ----------

export class VehicleManager {
  private vehicles: Record<VehicleType, Vehicle>
  private activeType: VehicleType = 'tank'
  private keys = new Set<string>()
  private projectiles: ProjectileManager
  private lastFiredAt = 0

  constructor(scene: Scene, projectiles: ProjectileManager, lib: ModelLibrary) {
    this.projectiles = projectiles
    this.vehicles = {
      tank: new TankVehicle(this.keys, lib),
      car: new CarVehicle(this.keys, lib),
      jet: new JetVehicle(this.keys, lib),
      spider: new SpiderVehicle(this.keys, lib),
    }
    for (const v of Object.values(this.vehicles)) {
      v.object.traverse(o => o.layers.set(1))
      v.object.visible = false
      scene.add(v.object)
    }
    this.vehicles.tank.object.visible = true

    window.addEventListener('keydown', e => {
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      this.keys.add(e.key.toLowerCase())
    })
    window.addEventListener('keyup', e => this.keys.delete(e.key.toLowerCase()))
  }

  public get active(): Vehicle {
    return this.vehicles[this.activeType]
  }

  /** Live key state (lowercased), for camera control in the render loop. */
  public held(key: string): boolean {
    return this.keys.has(key)
  }

  /** Feed the follow-camera azimuth to the spider so its ground locomotion is
   * camera-relative (no-op for the other vehicles). Call before update(). */
  public setCameraYaw(yaw: number): void {
    ;(this.vehicles.spider as SpiderVehicle).setCameraYaw(yaw)
  }

  public get position(): Vector3 {
    return this.active.position
  }

  public get state(): VehicleState {
    return this.active.state
  }

  public get cameraDist(): number {
    return this.active.cameraDist
  }

  public switchTo(type: VehicleType): void {
    if (type === this.activeType) return
    const from = this.active
    // clear any pending bombs from the old vehicle
    from.bombDrops.length = 0
    const to = this.vehicles[type]
    to.object.position.copy(from.object.position)
    if (type === 'jet') to.object.position.y += 60 // takeoff boost
    if (type === 'spider') {
      to.object.position.y += 10 // drop-in entrance
      ;(to as SpiderVehicle).onSpawn()
    }
    from.object.visible = false
    to.object.visible = true
    this.activeType = type
  }

  /** Returns and clears any bombs queued by the active vehicle this frame. */
  public drainBombs(): BombDrop[] {
    return this.active.bombDrops.splice(0)
  }

  public update(dt: number, terrain: Object3D): void {
    this.active.update(dt, terrain)

    if (this.keys.has(' ') && this.active.fireCooldown > 0) {
      const now = performance.now() / 1000
      if (now - this.lastFiredAt >= this.active.fireCooldown) {
        const ray = this.active.fireRay()
        if (ray) {
          this.projectiles.fire(ray.origin, ray.direction, ray.speed)
          this.lastFiredAt = now
        }
      }
    }
  }

  public hudText(): string {
    const s = this.state
    const kmh = Math.abs(s.speed) * 3.6
    const heading = ((s.heading * 180 / Math.PI) % 360 + 360) % 360
    let text = `${s.label}\nSpeed: ${kmh.toFixed(0)} km/h\nHeading: ${heading.toFixed(0)}°`
    if (s.altitude !== null) text += `\nAlt: ${s.altitude.toFixed(0)} m`
    if (s.afterburner) text += '\n🔥 AFTERBURNER'
    if (s.rolling)     text += '\n↻ BARREL ROLL'
    if (s.mode)        text += `\n🕸 ${s.mode}`
    return text
  }
}

// ---------- primitive fallbacks (used until catalogue GLBs load) ----------

export function buildTankPrimitive(): Group {
  const g = new Group()
  const hull = new MeshStandardMaterial({ color: 0x3d4a2e, roughness: 0.8 })
  const dark = new MeshStandardMaterial({ color: 0x2a3320, roughness: 0.9 })

  const body = new Mesh(new BoxGeometry(3.5, 1.2, 6.0), hull)
  body.position.y = 0.6
  const trackL = new Mesh(new BoxGeometry(0.9, 0.9, 6.4), dark)
  trackL.position.set(-1.7, 0.45, 0)
  const trackR = trackL.clone()
  trackR.position.x = 1.7
  const turret = new Mesh(new BoxGeometry(2.4, 0.8, 3.0), hull)
  turret.position.set(0, 1.6, -0.3)
  const barrel = new Mesh(new CylinderGeometry(0.14, 0.16, 4.2, 12), dark)
  barrel.rotation.x = Math.PI / 2
  barrel.position.set(0, 1.7, 2.4)
  g.add(body, trackL, trackR, turret, barrel)
  return g
}

export function buildCarPrimitive(): Group {
  const g = new Group()
  const paint = new MeshStandardMaterial({ color: 0xd32f2f, roughness: 0.25, metalness: 0.7 })
  const glass = new MeshStandardMaterial({ color: 0x222a33, roughness: 0.1, metalness: 0.4 })
  const dark = new MeshStandardMaterial({ color: 0x141414, roughness: 0.9 })

  const body = new Mesh(new BoxGeometry(2.0, 0.55, 4.6), paint)
  body.position.y = 0.55
  const cabin = new Mesh(new BoxGeometry(1.7, 0.45, 2.0), glass)
  cabin.position.set(0, 1.0, -0.2)
  const spoiler = new Mesh(new BoxGeometry(1.9, 0.08, 0.5), dark)
  spoiler.position.set(0, 1.0, -2.2)

  const wheelGeo = new CylinderGeometry(0.38, 0.38, 0.3, 16)
  wheelGeo.rotateZ(Math.PI / 2)
  for (const [x, z] of [[-1.0, 1.5], [1.0, 1.5], [-1.0, -1.5], [1.0, -1.5]]) {
    const w = new Mesh(wheelGeo, dark)
    w.position.set(x, 0.38, z)
    g.add(w)
  }
  g.add(body, cabin, spoiler)
  return g
}

export function buildJetPrimitive(): Group {
  const g = new Group()
  const grey = new MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.4, metalness: 0.5 })
  const dark = new MeshStandardMaterial({ color: 0x2c3338, roughness: 0.6 })

  const fuselage = new Mesh(new CylinderGeometry(0.6, 0.35, 9, 12), grey)
  fuselage.rotation.x = Math.PI / 2
  fuselage.position.y = 0.5
  const nose = new Mesh(new CylinderGeometry(0.05, 0.6, 2.2, 12), grey)
  nose.rotation.x = Math.PI / 2
  nose.position.set(0, 0.5, 5.5)
  const wing = new Mesh(new BoxGeometry(9, 0.12, 2.6), grey)
  wing.position.set(0, 0.3, -0.4)
  const tailWing = new Mesh(new BoxGeometry(3.4, 0.1, 1.2), grey)
  tailWing.position.set(0, 0.5, -4.0)
  const fin = new Mesh(new BoxGeometry(0.12, 1.8, 1.5), dark)
  fin.position.set(0, 1.3, -4.0)
  g.add(fuselage, nose, wing, tailWing, fin)
  return g
}
