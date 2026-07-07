import {
  BoxGeometry, CylinderGeometry, Group, Mesh, MeshStandardMaterial,
  Object3D, Scene, Vector3,
} from 'three'

import type { ProjectileManager } from './projectiles'
import type { ModelLibrary } from './modelCatalog'
import { type BombDrop, Vehicle, type VehicleState, type VehicleType } from './vehicleBase'
import { SpiderVehicle } from './spiderman'
import { disposeObject3D } from './disposeThree'

import { SANDBOX_COMMON, SANDBOX_VEHICLES } from '@/constants/sandbox'

export { Vehicle, DOWN } from './vehicleBase'
export type { VehicleType, VehicleState, BombDrop } from './vehicleBase'

// ---------- TANK ----------

class TankVehicle extends Vehicle {
  public readonly label = 'M1 TANK'
  public readonly cameraDist = SANDBOX_VEHICLES.TANK_CAMERA_DIST
  public override readonly fireCooldown = SANDBOX_VEHICLES.TANK_FIRE_COOLDOWN
  private grounded = false

  constructor(keys: Set<string>, lib: ModelLibrary) {
    super(keys)
    this.object.add(lib.instance('tank', buildTankPrimitive))
  }

  public override update(dt: number, terrain: Object3D): void {
    groundDrive(this, dt, terrain, {
      maxSpeed: SANDBOX_VEHICLES.TANK_MAX_SPEED,
      accel: SANDBOX_VEHICLES.TANK_ACCEL,
      brake: SANDBOX_VEHICLES.TANK_BRAKE,
      reverseFactor: SANDBOX_VEHICLES.TANK_REVERSE_FACTOR,
      turnRate: SANDBOX_VEHICLES.TANK_TURN_RATE,
      damping: SANDBOX_VEHICLES.TANK_DAMPING,
      clearance: SANDBOX_VEHICLES.TANK_CLEARANCE,
      maxClimb: SANDBOX_VEHICLES.TANK_MAX_CLIMB,
      grounded: this.grounded, setGrounded: g => { this.grounded = g },
    })
  }

  public override fireRay() {
    const dir = this.forwardXZ()
    dir.y = SANDBOX_VEHICLES.TANK_FIRE_DIR_Y
    const origin = this.position.clone()
      .addScaledVector(this.forwardXZ(), SANDBOX_VEHICLES.TANK_FIRE_FORWARD_OFFSET)
    origin.y += SANDBOX_VEHICLES.TANK_FIRE_HEIGHT
    return { origin, direction: dir, speed: SANDBOX_VEHICLES.TANK_FIRE_SPEED }
  }
}

// ---------- SPORTS CAR ----------

class CarVehicle extends Vehicle {
  public readonly label = 'GT SPORTS'
  public readonly cameraDist = SANDBOX_VEHICLES.CAR_CAMERA_DIST
  private grounded = false

  constructor(keys: Set<string>, lib: ModelLibrary) {
    super(keys)
    this.object.add(lib.instance('car', buildCarPrimitive))
  }

  public override update(dt: number, terrain: Object3D): void {
    // speed-sensitive steering: nimble in town, stable at 250 km/h
    const speedFrac = Math.abs(this._speed) / SANDBOX_VEHICLES.CAR_SPEED_FRAC_DENOMINATOR
    groundDrive(this, dt, terrain, {
      maxSpeed: SANDBOX_VEHICLES.CAR_MAX_SPEED,
      accel: SANDBOX_VEHICLES.CAR_ACCEL,
      brake: SANDBOX_VEHICLES.CAR_BRAKE,
      reverseFactor: SANDBOX_VEHICLES.CAR_REVERSE_FACTOR,
      turnRate:
        SANDBOX_VEHICLES.CAR_TURN_RATE -
        SANDBOX_VEHICLES.CAR_TURN_RATE_DROP * Math.min(speedFrac, 1),
      damping: SANDBOX_VEHICLES.CAR_DAMPING,
      clearance: SANDBOX_VEHICLES.CAR_CLEARANCE,
      maxClimb: SANDBOX_VEHICLES.CAR_MAX_CLIMB,
      grounded: this.grounded, setGrounded: g => { this.grounded = g },
    })
  }
}

// ---------- JET ----------

const AFTERBURNER_MAX = SANDBOX_VEHICLES.JET_AFTERBURNER_MAX   // m/s (~Mach 1.7)
const NORMAL_MAX = SANDBOX_VEHICLES.JET_NORMAL_MAX
const ROLL_SPEED = (Math.PI * 2) / SANDBOX_VEHICLES.JET_ROLL_SECONDS  // full barrel roll in 1.1 s

class JetVehicle extends Vehicle {
  public readonly label = 'F-16 JET'
  public readonly cameraDist = SANDBOX_VEHICLES.JET_CAMERA_DIST
  public override readonly fireCooldown = SANDBOX_VEHICLES.JET_FIRE_COOLDOWN
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
    this._speed = SANDBOX_VEHICLES.JET_INITIAL_SPEED
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
    const accel  = afterburner
      ? SANDBOX_VEHICLES.JET_AFTERBURNER_ACCEL
      : SANDBOX_VEHICLES.JET_NORMAL_ACCEL
    if (throttleUp)   this._speed = Math.min(this._speed + accel * dt, maxSpd)
    if (throttleDown)
      this._speed = Math.max(
        this._speed - SANDBOX_VEHICLES.JET_THROTTLE_DOWN_ACCEL * dt,
        SANDBOX_VEHICLES.JET_MIN_SPEED,
      )
    if (!throttleUp && !afterburner) {
      // decay back toward cruise when not actively burning
      if (this._speed > NORMAL_MAX)
        this._speed = Math.max(this._speed - SANDBOX_VEHICLES.JET_CRUISE_DECEL * dt, NORMAL_MAX)
    }

    // --- yaw / bank ---
    const turnInput = (left ? 1 : 0) - (right ? 1 : 0)
    const turnRate = afterburner
      ? SANDBOX_VEHICLES.JET_AFTERBURNER_TURN_RATE
      : SANDBOX_VEHICLES.JET_NORMAL_TURN_RATE  // less nimble at hypersonic speed
    this._heading += turnInput * turnRate * dt
    this.bank +=
      (turnInput * SANDBOX_VEHICLES.JET_BANK_TARGET - this.bank) *
      Math.min(1, dt * SANDBOX_VEHICLES.JET_BANK_LERP_RATE)

    // --- pitch ---
    const pitchInput = (pitchUp ? 1 : 0) - (pitchDown ? 1 : 0)
    this.pitch +=
      (pitchInput * SANDBOX_VEHICLES.JET_PITCH_TARGET -
        this.pitch * SANDBOX_VEHICLES.JET_PITCH_CENTERING) *
      Math.min(1, dt * SANDBOX_VEHICLES.JET_PITCH_LERP_RATE)
    this.pitch = Math.max(
      SANDBOX_VEHICLES.JET_PITCH_MIN,
      Math.min(SANDBOX_VEHICLES.JET_PITCH_MAX, this.pitch),
    )

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
      this.rollOffset *= Math.pow(SANDBOX_VEHICLES.JET_ROLL_DECAY, dt)
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
      this.position.y + SANDBOX_VEHICLES.JET_GROUND_SAMPLE_UP, this.position.y,
    )
    this.altitude = groundY !== null ? this.position.y - groundY : this.position.y
    if (groundY !== null && this.position.y < groundY + SANDBOX_VEHICLES.JET_GROUND_CLEARANCE) {
      this.position.y = groundY + SANDBOX_VEHICLES.JET_GROUND_CLEARANCE
      if (this.pitch < 0) this.pitch = SANDBOX_VEHICLES.JET_GROUND_PITCH_RECOVER
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
        pos: this.position.clone().addScaledVector(dir, SANDBOX_VEHICLES.JET_BOMB_FORWARD_OFFSET), // drop from belly
        vel: dir.clone().multiplyScalar(this._speed * SANDBOX_VEHICLES.JET_BOMB_VELOCITY_FACTOR),
      })
      this.bombCooldown = SANDBOX_VEHICLES.JET_BOMB_COOLDOWN
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
    const origin = this.position.clone().addScaledVector(dir, SANDBOX_VEHICLES.JET_FIRE_FORWARD_OFFSET)
    return { origin, direction: dir, speed: this._speed + SANDBOX_VEHICLES.JET_FIRE_SPEED_ADD }
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

  if (Math.abs(self._speed) > SANDBOX_VEHICLES.GROUND_DRIVE_SPEED_EPSILON) {
    if (left) self._heading += p.turnRate * dt * Math.sign(self._speed)
    if (right) self._heading -= p.turnRate * dt * Math.sign(self._speed)
  }
  self.object.rotation.set(0, self._heading, 0)

  const step = self._speed * dt
  const nx = self.object.position.x + Math.sin(self._heading) * step
  const nz = self.object.position.z + Math.cos(self._heading) * step

  const groundY = self.sampleGround(
    nx,
    nz,
    terrain,
    self.object.position.y + SANDBOX_VEHICLES.GROUND_DRIVE_SAMPLE_UP,
    self.object.position.y - p.clearance,
  )
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
    ? self.object.position.y +
      (targetY - self.object.position.y) * Math.min(1, dt * SANDBOX_VEHICLES.GROUND_DRIVE_Y_LERP_RATE)
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
  private readonly onKeyDown = (e: KeyboardEvent): void => {
    const el = e.target as HTMLElement | null
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
    this.keys.add(e.key.toLowerCase())
  }
  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.key.toLowerCase())
  }

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

    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
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
    if (type === 'jet') to.object.position.y += SANDBOX_VEHICLES.SWITCH_JET_TAKEOFF_BOOST // takeoff boost
    if (type === 'spider') {
      to.object.position.y += SANDBOX_VEHICLES.SWITCH_SPIDER_DROP_IN_BOOST // drop-in entrance
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
      const now = performance.now() / SANDBOX_VEHICLES.FIRE_NOW_SECONDS_DIVISOR
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
    const kmh = Math.abs(s.speed) * SANDBOX_VEHICLES.KMH_PER_MPS
    const heading =
      ((s.heading * SANDBOX_COMMON.DEGREES_HALF_TURN / Math.PI) %
        SANDBOX_COMMON.DEGREES_FULL_CIRCLE +
        SANDBOX_COMMON.DEGREES_FULL_CIRCLE) %
      SANDBOX_COMMON.DEGREES_FULL_CIRCLE
    let text = `${s.label}\nSpeed: ${kmh.toFixed(0)} km/h\nHeading: ${heading.toFixed(0)}°`
    if (s.altitude !== null) text += `\nAlt: ${s.altitude.toFixed(0)} m`
    if (s.afterburner) text += '\n🔥 AFTERBURNER'
    if (s.rolling)     text += '\n↻ BARREL ROLL'
    if (s.mode)        text += `\n🕸 ${s.mode}`
    return text
  }

  public dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    this.keys.clear()
    for (const vehicle of Object.values(this.vehicles)) {
      disposeObject3D(vehicle.object)
    }
  }
}

// ---------- primitive fallbacks (used until catalogue GLBs load) ----------

export function buildTankPrimitive(): Group {
  const g = new Group()
  const hull = new MeshStandardMaterial({
    color: SANDBOX_VEHICLES.TANK_COLOR,
    roughness: SANDBOX_VEHICLES.TANK_ROUGHNESS,
  })
  const dark = new MeshStandardMaterial({
    color: SANDBOX_VEHICLES.TANK_DARK_COLOR,
    roughness: SANDBOX_VEHICLES.TANK_DARK_ROUGHNESS,
  })

  const body = new Mesh(
    new BoxGeometry(
      SANDBOX_VEHICLES.TANK_HULL_W,
      SANDBOX_VEHICLES.TANK_HULL_H,
      SANDBOX_VEHICLES.TANK_HULL_D,
    ),
    hull,
  )
  body.position.y = SANDBOX_VEHICLES.TANK_HULL_Y
  const trackL = new Mesh(
    new BoxGeometry(
      SANDBOX_VEHICLES.TANK_TRACK_W,
      SANDBOX_VEHICLES.TANK_TRACK_H,
      SANDBOX_VEHICLES.TANK_TRACK_D,
    ),
    dark,
  )
  trackL.position.set(-SANDBOX_VEHICLES.TANK_TRACK_X, SANDBOX_VEHICLES.TANK_TRACK_Y, 0)
  const trackR = trackL.clone()
  trackR.position.x = SANDBOX_VEHICLES.TANK_TRACK_X
  const turret = new Mesh(
    new BoxGeometry(
      SANDBOX_VEHICLES.TANK_TURRET_W,
      SANDBOX_VEHICLES.TANK_TURRET_H,
      SANDBOX_VEHICLES.TANK_TURRET_D,
    ),
    hull,
  )
  turret.position.set(0, SANDBOX_VEHICLES.TANK_TURRET_Y, SANDBOX_VEHICLES.TANK_TURRET_Z)
  const barrel = new Mesh(
    new CylinderGeometry(
      SANDBOX_VEHICLES.TANK_BARREL_RADIUS_TOP,
      SANDBOX_VEHICLES.TANK_BARREL_RADIUS_BOTTOM,
      SANDBOX_VEHICLES.TANK_BARREL_LENGTH,
      SANDBOX_VEHICLES.TANK_BARREL_SEGMENTS,
    ),
    dark,
  )
  barrel.rotation.x = Math.PI / 2
  barrel.position.set(0, SANDBOX_VEHICLES.TANK_BARREL_Y, SANDBOX_VEHICLES.TANK_BARREL_Z)
  g.add(body, trackL, trackR, turret, barrel)
  return g
}

export function buildCarPrimitive(): Group {
  const g = new Group()
  const paint = new MeshStandardMaterial({
    color: SANDBOX_VEHICLES.CAR_PAINT_COLOR,
    roughness: SANDBOX_VEHICLES.CAR_PAINT_ROUGHNESS,
    metalness: SANDBOX_VEHICLES.CAR_PAINT_METALNESS,
  })
  const glass = new MeshStandardMaterial({
    color: SANDBOX_VEHICLES.CAR_GLASS_COLOR,
    roughness: SANDBOX_VEHICLES.CAR_GLASS_ROUGHNESS,
    metalness: SANDBOX_VEHICLES.CAR_GLASS_METALNESS,
  })
  const dark = new MeshStandardMaterial({
    color: SANDBOX_VEHICLES.CAR_DARK_COLOR,
    roughness: SANDBOX_VEHICLES.CAR_DARK_ROUGHNESS,
  })

  const body = new Mesh(
    new BoxGeometry(SANDBOX_VEHICLES.CAR_BODY_W, SANDBOX_VEHICLES.CAR_BODY_H, SANDBOX_VEHICLES.CAR_BODY_D),
    paint,
  )
  body.position.y = SANDBOX_VEHICLES.CAR_BODY_Y
  const cabin = new Mesh(
    new BoxGeometry(SANDBOX_VEHICLES.CAR_CABIN_W, SANDBOX_VEHICLES.CAR_CABIN_H, SANDBOX_VEHICLES.CAR_CABIN_D),
    glass,
  )
  cabin.position.set(0, SANDBOX_VEHICLES.CAR_CABIN_Y, SANDBOX_VEHICLES.CAR_CABIN_Z)
  const spoiler = new Mesh(
    new BoxGeometry(
      SANDBOX_VEHICLES.CAR_SPOILER_W,
      SANDBOX_VEHICLES.CAR_SPOILER_H,
      SANDBOX_VEHICLES.CAR_SPOILER_D,
    ),
    dark,
  )
  spoiler.position.set(0, SANDBOX_VEHICLES.CAR_SPOILER_Y, SANDBOX_VEHICLES.CAR_SPOILER_Z)

  const wheelGeo = new CylinderGeometry(
    SANDBOX_VEHICLES.CAR_WHEEL_RADIUS,
    SANDBOX_VEHICLES.CAR_WHEEL_RADIUS,
    SANDBOX_VEHICLES.CAR_WHEEL_DEPTH,
    SANDBOX_VEHICLES.CAR_WHEEL_SEGMENTS,
  )
  wheelGeo.rotateZ(Math.PI / 2)
  for (const [x, z] of [
    [-SANDBOX_VEHICLES.CAR_WHEEL_X, SANDBOX_VEHICLES.CAR_WHEEL_Z],
    [SANDBOX_VEHICLES.CAR_WHEEL_X, SANDBOX_VEHICLES.CAR_WHEEL_Z],
    [-SANDBOX_VEHICLES.CAR_WHEEL_X, -SANDBOX_VEHICLES.CAR_WHEEL_Z],
    [SANDBOX_VEHICLES.CAR_WHEEL_X, -SANDBOX_VEHICLES.CAR_WHEEL_Z],
  ]) {
    const w = new Mesh(wheelGeo, dark)
    w.position.set(x, SANDBOX_VEHICLES.CAR_WHEEL_Y, z)
    g.add(w)
  }
  g.add(body, cabin, spoiler)
  return g
}

export function buildJetPrimitive(): Group {
  const g = new Group()
  const grey = new MeshStandardMaterial({
    color: SANDBOX_VEHICLES.JET_GREY_COLOR,
    roughness: SANDBOX_VEHICLES.JET_GREY_ROUGHNESS,
    metalness: SANDBOX_VEHICLES.JET_GREY_METALNESS,
  })
  const dark = new MeshStandardMaterial({
    color: SANDBOX_VEHICLES.JET_DARK_COLOR,
    roughness: SANDBOX_VEHICLES.JET_DARK_ROUGHNESS,
  })

  const fuselage = new Mesh(
    new CylinderGeometry(
      SANDBOX_VEHICLES.JET_FUSELAGE_RADIUS_TOP,
      SANDBOX_VEHICLES.JET_FUSELAGE_RADIUS_BOTTOM,
      SANDBOX_VEHICLES.JET_FUSELAGE_LENGTH,
      SANDBOX_VEHICLES.JET_FUSELAGE_SEGMENTS,
    ),
    grey,
  )
  fuselage.rotation.x = Math.PI / 2
  fuselage.position.y = SANDBOX_VEHICLES.JET_FUSELAGE_Y
  const nose = new Mesh(
    new CylinderGeometry(
      SANDBOX_VEHICLES.JET_NOSE_RADIUS_TOP,
      SANDBOX_VEHICLES.JET_NOSE_RADIUS_BOTTOM,
      SANDBOX_VEHICLES.JET_NOSE_LENGTH,
      SANDBOX_VEHICLES.JET_NOSE_SEGMENTS,
    ),
    grey,
  )
  nose.rotation.x = Math.PI / 2
  nose.position.set(0, SANDBOX_VEHICLES.JET_NOSE_Y, SANDBOX_VEHICLES.JET_NOSE_Z)
  const wing = new Mesh(
    new BoxGeometry(SANDBOX_VEHICLES.JET_WING_W, SANDBOX_VEHICLES.JET_WING_H, SANDBOX_VEHICLES.JET_WING_D),
    grey,
  )
  wing.position.set(0, SANDBOX_VEHICLES.JET_WING_Y, SANDBOX_VEHICLES.JET_WING_Z)
  const tailWing = new Mesh(
    new BoxGeometry(SANDBOX_VEHICLES.JET_TAIL_W, SANDBOX_VEHICLES.JET_TAIL_H, SANDBOX_VEHICLES.JET_TAIL_D),
    grey,
  )
  tailWing.position.set(0, SANDBOX_VEHICLES.JET_TAIL_Y, SANDBOX_VEHICLES.JET_TAIL_Z)
  const fin = new Mesh(
    new BoxGeometry(SANDBOX_VEHICLES.JET_FIN_W, SANDBOX_VEHICLES.JET_FIN_H, SANDBOX_VEHICLES.JET_FIN_D),
    dark,
  )
  fin.position.set(0, SANDBOX_VEHICLES.JET_FIN_Y, SANDBOX_VEHICLES.JET_FIN_Z)
  g.add(fuselage, nose, wing, tailWing, fin)
  return g
}
