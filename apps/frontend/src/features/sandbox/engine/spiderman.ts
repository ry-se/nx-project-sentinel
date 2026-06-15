import {
  BoxGeometry,
  CanvasTexture,
  CylinderGeometry,
  Euler,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  Raycaster,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Vector3,
} from 'three'

import { Vehicle, type VehicleState } from './vehicleBase'
import type { ModelLibrary } from './modelCatalog'

// ─── tuning table (tweak these first — they define the whole feel) ──────────
// Asymmetric gravity is the classic weight trick: rise slowly, fall hard —
// no floaty apex hang. The swing uses its own (heaviest) g so the pendulum is
// the speed ENGINE: v_bottom = √(v₀² + 2·g·h). Heavier g → more speed per drop.
const G_RISE       = -38    // m/s² airborne while moving up
const G_FALL       = -56    // m/s² airborne while moving down (he DROPS, no hang)
const G_SWING      = -48    // m/s² while attached — the pendulum engine
const RUN_SPEED    = 20     // m/s full sprint (SHIFT+W)
const JOG_SPEED    = 8      // m/s jog (W alone, no SHIFT)
const RUN_ACCEL    = 60
// Fraction of speed lost per second while coasting (not pressing W).
// Applied as Math.pow(COAST_FRICTION, dt) so it's frame-rate independent.
// 0.05 = 95% decay/s: you stop in ~0.5 s — running feels distinct from
// standing (not an ice-rink coast), so the sprint-jump launch is earned.
const COAST_FRICTION = 0.05
const JUMP_V       = 18     // m/s base vertical jump (standing hop ≈ 4.3 m apex)
const JUMP_V_PER_SPD = 0.35 // extra vertical per m/s of run speed (full sprint ≈ 25 m/s up)
const AIR_TURN     = 2.1    // rad/s — A/D rotates the flight direction in the air
const SWING_TURN   = 1.3    // rad/s — A/D bends the swing plane
const DIVE_ACCEL   = 30     // m/s² extra downward when holding W airborne (G_FALL does the rest)
const AIR_BRAKE    = 0.97   // horizontal drag per frame when holding S in air
const SWING_DIVE   = 20     // m/s² extra DOWNWARD on the descending half when holding W (steepens arc)
const SWING_PUMP   = 3      // m/s² gentle tangential boost — only while descending (real leg-pump)
const RELEASE_BOOST = 1.0   // no free energy on release — timing the upswing IS the skill
const MAX_SWING    = 74     // m/s soft cap while attached (~265 km/h)
const MAX_FALL     = 88     // m/s terminal velocity
const ZIP_SPEED    = 58     // m/s web-zip travel speed
const ZIP_RANGE    = 130    // m max zip raycast
const ZIP_TIMEOUT  = 1.5    // s
const AIR_DASH_V   = 13     // m/s impulse for the no-anchor recovery dash
const PULL_RANGE   = 85     // m max web-pull raycast
const PULL_CHARGES = 2      // pulls per airtime; recharged by landing or attaching
const PULL_COOLDOWN = 0.30  // s between pulls
const PULL_DURATION = 0.35  // s — straight-line yank window (gravity suppressed)
const PULL_SPEED    = 52    // m/s travel speed during the straight-line pull
const PULL_MIN_UP   = 0.22  // floor on the pull direction's vertical component (slight lift)
// Run velocity is ALREADY carried into the jump via vel; this only adds a
// small extra nudge on top (was 1.5 = double-counting → 50 m/s, 110 m jumps).
const JUMP_FWD     = 0.15   // total forward ≈ 1.15× run speed
const ANCHOR_MIN_UP = 4     // anchor must be ≥ this many m above player (low rooftops OK)
const ANCHOR_UP_SWEET = 25  // preferred anchor height above player — not the skyscraper top
const ANCHOR_RANGE = 95     // m max web length
const ANCHOR_SWEET = 40     // m preferred web length
const ROPE_IDEAL   = 38     // m — long ropes reel toward this (short rope = fast pendulum)
const GROUND_CLEAR = 4      // swing arc must clear ground by this margin (m)
const COM_HEIGHT   = 1.0    // torso-origin height above feet (m)
const ATTACH_RETRY = 0.1    // s between anchor scans while SPACE held in air
const ATTACH_MIN_AIR = 0.12 // s airborne before a web can attach (jump-tap ≠ web)
const REEL_RATE    = 18     // m/s — rope shortens gradually toward its target length

// ─── quadratic air drag (the SM2 model — slide 51) ──────────────────────────
// Drag accel = k·v² opposite velocity, applied in air AND swing. Quadratic so
// it's negligible when slow (easy to build speed from a standstill) but strong
// when fast (a natural top-speed cap with no hard clamp). The momentum meter
// scales drag DOWN (the deck's "aero meter") so skilled play holds speed longer.
const DRAG_K        = 0.0016 // base quadratic drag coefficient
const DRAG_MIN_MULT = 0.4    // drag multiplier at full momentum (0.4 = 60% less)

// ─── momentum meter (slides 52-54) ──────────────────────────────────────────
// 0..1, built by skillful traversal (good swings, wall climbs, flings), decays
// over time, NEVER slows you. Governs fling boost size + reduces air drag.
const MOM_DECAY     = 0.10   // /s passive decay
const MOM_PER_SWING = 0.30   // gained on a fast swing release (× speed fraction)
const MOM_PER_CLIMB = 0.25   // /s gained while actively wall-climbing
const MOM_PER_ZIP   = 0.12   // gained ending a zip

// ─── wall-run / cling ───────────────────────────────────────────────────────
// Photogrammetry walls are noisy, so the outward normal is approximated as the
// horizontal vector from the wall hit back to the player (robust to mesh lumps).
const WALL_RANGE     = 3.5   // m — cling if a wall is this close ahead
const WALL_MIN_SPEED = 6     // m/s — need some speed to stick (else just fall)
// Fraction of incoming speed REDIRECTED onto the wall plane on cling (not
// discarded). Lets you slam a wall head-on and convert that speed into an
// up-the-wall run — no need to graze in perfectly parallel.
const WALL_CARRY     = 0.9
const WALL_CLIMB     = 36    // m/s² up-the-wall accel (W)
const WALL_TRAVERSE  = 24    // m/s² sideways accel along the wall (A/D)
// He's a SPIDER — no gravity slide. With no climb/traverse input the velocity
// decays toward zero so he sticks where he is (0.05 = 95%/s → settles in ~0.5s).
const WALL_STICK     = 0.05  // velocity retention/s when no wall input (cling)
const WALL_MAX       = 42    // m/s cap on wall speed
const WALL_GIVEUP    = 12.0  // s max idle cling before auto-detach (lumpy snag guard)
const WALL_JUMP_OUT  = 16    // m/s push off the wall on SPACE
const WALL_JUMP_UP   = 14    // m/s upward on a wall jump-off
const WALL_CLING_DIST = 1.4  // m — held distance off the wall face
const WALL_EDGE_OUT  = 7     // m/s outward kick when you run off an edge (arc away, not straight down)

// ─── web-fling / slingshot (slides 46, 52-54) ───────────────────────────────
const FLING_UP    = 22   // m/s up on a wall fling (the V-catapult boost), × meter
const FLING_FWD   = 30   // m/s forward-OVER-the-top on a near-top wall fling, × meter
const FLING_BOOST = 28   // m/s point-launch boost along travel at full momentum
const FLING_DRAIN = 0.5  // momentum spent per fling
const FLING_TOP_REACH = 9  // m — wall top within this → "over the top" fling, else V-boost
const FLING_WEB_LEN   = 7  // m — length of the visual catapult web lines
// Walk off a drop TALLER than this and you fall (gravity) instead of snapping
// down to the street far below — the "teleport to the next surface" walk-off bug.
const STEP_DOWN   = 2.5  // m

// Ground turn rate toward the camera-relative push direction (rad/s-ish lerp).
const GROUND_TURN = 12
const UP = new Vector3(0, 1, 0)

/** Wrap an angle delta into [-π, π] so heading lerps take the short way round. */
function shortAngle(a: number): number {
  a %= Math.PI * 2
  if (a > Math.PI) a -= Math.PI * 2
  if (a < -Math.PI) a += Math.PI * 2
  return a
}

type SpiderState = 'ground' | 'air' | 'swing' | 'zip' | 'pull' | 'wall'

const STATE_LABEL: Record<SpiderState, string> = {
  ground: 'GROUND',
  air: 'FALLING',
  swing: 'SWINGING',
  zip: 'ZIP',
  pull: 'PULL',
  wall: 'WALL-RUN',
}

export class SpiderVehicle extends Vehicle {
  public readonly label = 'SPIDER'
  public readonly cameraDist = 14 // close camera — speed feels 3x faster
  // fireCooldown stays 0 → VehicleManager never fires on SPACE. SPACE is ours.

  private vel = new Vector3()
  private spiderState: SpiderState = 'air'

  // web / swing
  private anchor = new Vector3()
  private ropeLen = 0
  private targetRopeLen = 0 // clearance-adjusted length the rope reels toward
  private attachCooldown = 0
  private airTime = 0       // seconds since leaving the ground
  private lastSide = 1 // alternates the anchor bias left/right each swing

  // zip
  private zipTarget = new Vector3()
  private zipElapsed = 0
  private airDashUsed = false

  // web pull (E) — straight-line yank
  private pullCharges = PULL_CHARGES
  private pullCooldown = 0
  private pullElapsed = 0      // s into the active pull window
  private pullPoint = new Vector3() // surface anchor for the pull web line

  // wall-run / cling
  private wallNormal = new Vector3() // smoothed outward (horizontal) wall normal
  private wallTime = 0               // s clung (give-up timer)

  // momentum meter (built by skillful traversal, decays, never slows you)
  private momentum = 0

  // Camera azimuth (radians) fed in each frame by the follow camera. Ground
  // locomotion is interpreted in THIS frame so WASD is camera-relative —
  // pushing W always goes "into the screen", never along a stale heading.
  private cameraYaw = 0

  // input edge detection
  private prevSpace = false
  private prevShift = false
  private prevE = false
  private prevF = false

  // sub-objects (object itself only translates — never rotates — so its
  // children live effectively in world space for the web line)
  private bodyGroup = new Group()
  private web: Mesh
  private reticle: Sprite
  private anchorRay = new Raycaster()

  // web-fling visuals — transient lines shown for flingFlash seconds after F.
  // flingCount 2 = V-catapult (mid-wall), 1 = single over-the-top web.
  private flingWebA: Mesh
  private flingWebB: Mesh
  private flingAnchorA = new Vector3()
  private flingAnchorB = new Vector3()
  private flingCount = 0
  private flingFlash = 0

  constructor(keys: Set<string>, lib: ModelLibrary) {
    super(keys)
    ;(this.anchorRay as unknown as { firstHitOnly: boolean }).firstHitOnly = true

    this.bodyGroup.add(lib.instance('spider', buildSpiderPrimitive))
    this.object.add(this.bodyGroup)

    this.web = new Mesh(
      new CylinderGeometry(0.06, 0.06, 1, 6),
      new MeshStandardMaterial({ color: 0xffffff, roughness: 0.4, emissive: 0x888888 }),
    )
    this.web.visible = false
    this.object.add(this.web)

    const mkFlingWeb = (): Mesh => {
      const m = new Mesh(
        new CylinderGeometry(0.05, 0.05, 1, 6),
        new MeshStandardMaterial({ color: 0xffffff, roughness: 0.4, emissive: 0xaaaaaa }),
      )
      m.visible = false
      this.object.add(m)
      return m
    }
    this.flingWebA = mkFlingWeb()
    this.flingWebB = mkFlingWeb()

    this.reticle = buildZipReticle()
    this.object.add(this.reticle)
  }

  /** Fed by the follow camera each frame (createSandbox) so ground movement
   * is relative to where the camera points, not a stored heading. */
  public setCameraYaw(yaw: number): void {
    this.cameraYaw = yaw
  }

  /** Reset state when (re)selected. Called by VehicleManager.switchTo. */
  public onSpawn(): void {
    this.vel.set(0, 0, 0)
    this.spiderState = 'air'
    this.attachCooldown = 0
    this.airTime = 0
    this.targetRopeLen = 0
    this.zipElapsed = 0
    this.airDashUsed = false
    this.pullCharges = PULL_CHARGES
    this.pullCooldown = 0
    this.pullElapsed = 0
    this.wallTime = 0
    this.momentum = 0
    this.prevSpace = false
    this.prevShift = false
    this.prevE = false
    this.prevF = false
    this.web.visible = false
    this.reticle.visible = false
    this.flingWebA.visible = false
    this.flingWebB.visible = false
    this.flingFlash = 0
    this.object.rotation.set(0, 0, 0)
  }

  public override update(dt: number, terrain: Object3D): void {
    const space = this.keys.has(' ')
    const shift = this.keys.has('shift')
    const w = this.keys.has('w')
    const s = this.keys.has('s')
    const a = this.keys.has('a')
    const d = this.keys.has('d')
    const e = this.keys.has('e')
    const f = this.keys.has('f')
    const spacePressed = space && !this.prevSpace
    const shiftPressed = shift && !this.prevShift
    const ePressed = e && !this.prevE
    const fPressed = f && !this.prevF

    if (this.attachCooldown > 0) this.attachCooldown -= dt
    if (this.pullCooldown > 0) this.pullCooldown -= dt
    // Momentum meter decays passively; gains happen in the moves themselves.
    this.momentum = Math.max(0, this.momentum - MOM_DECAY * dt)

    // F — web-fling: edge-slingshot off a wall, or a point-launch boost
    // mid-air/swing. Checked before the switch so an edge-fling sees wall state.
    if (fPressed) this.tryFling(terrain)

    switch (this.spiderState) {
      case 'ground': this.updateGround(dt, terrain, { w, s, a, d, shift, spacePressed }); break
      case 'air':    this.updateAir(dt, terrain, { w, s, a, d, space }); break
      case 'swing':  this.updateSwing(dt, terrain, { w, s, a, d, space }); break
      case 'zip':    this.updateZip(dt, spacePressed); break
      case 'pull':   this.updatePull(dt, terrain); break
      case 'wall':   this.updateWall(dt, terrain, { w, s, a, d, spacePressed }); break
    }

    // Wall cling: swing/fall INTO a wall with speed → stick and run it. Gated
    // tight (speed + head-on) so it only triggers when you mean it.
    if (this.spiderState === 'air' || this.spiderState === 'swing') {
      this.tryWallCling(terrain)
    }

    // SHIFT (zip / dash): air, swing — and W+SHIFT zips near-vertical
    if (shiftPressed && (this.spiderState === 'air' || this.spiderState === 'swing')) {
      this.tryZip(terrain, w)
    }

    // E (web pull): straight-line yank toward a surface ahead — momentum builder.
    // Allowed from air or swing (swinging releases the web and pulls).
    if (ePressed && (this.spiderState === 'air' || this.spiderState === 'swing')) {
      this.tryPull(terrain)
    }

    // zip target reticle: shows where SHIFT will take you (hidden = dash only)
    if (this.spiderState === 'air' || this.spiderState === 'swing') {
      const tgt = this.computeZipTarget(terrain, w)
      if (tgt) {
        // local space == world delta (object never rotates); pull the marker
        // 1.5 m toward the player so it doesn't z-fight the wall
        const local = tgt.sub(this.object.position)
        const len = local.length()
        if (len > 2) local.multiplyScalar((len - 1.5) / len)
        this.reticle.position.copy(local)
        this.reticle.visible = true
      } else {
        this.reticle.visible = false
      }
    } else {
      this.reticle.visible = false
    }

    // Derive heading from horizontal velocity so the follow camera trails
    // motion — but NOT on the ground, where heading is player-driven via A/D
    // (overwriting it here was eating the turn input while moving).
    const horizSpeed = Math.hypot(this.vel.x, this.vel.z)
    if (this.spiderState !== 'ground' && horizSpeed > 0.5) {
      this._heading = Math.atan2(this.vel.x, this.vel.z)
    }
    this._speed = this.vel.length()

    this.updateBodyPose(dt)
    this.updateWeb()
    this.updateFlingWebs(dt)

    this.prevSpace = space
    this.prevShift = shift
    this.prevE = e
    this.prevF = f
  }

  // ── GROUND ────────────────────────────────────────────────────────────────
  private updateGround(
    dt: number, terrain: Object3D,
    k: { w: boolean; s: boolean; a: boolean; d: boolean; shift: boolean; spacePressed: boolean },
  ): void {
    // Camera-relative locomotion (the Insomniac / SM2 model): WASD pushes
    // relative to where the CAMERA points, and the body turns to face the
    // push. W = into the screen, S = toward camera, A/D = screen-left/right.
    // No more "rotate heading then wait for the camera to catch up".
    const az = this.cameraYaw
    const camFwd = new Vector3(-Math.sin(az), 0, -Math.cos(az)) // into the screen
    const camRight = new Vector3(-camFwd.z, 0, camFwd.x)        // screen-right
    const ix = (k.d ? 1 : 0) - (k.a ? 1 : 0)
    const iz = (k.w ? 1 : 0) - (k.s ? 1 : 0)
    const move = new Vector3()
      .addScaledVector(camFwd, iz)
      .addScaledVector(camRight, ix)
    const moving = move.lengthSq() > 1e-4

    if (moving) {
      move.normalize()
      // Turn the body toward the push direction (brisk, not instant — reads as
      // a real pivot). Heading drives both the body pose and the jump launch.
      const targetH = Math.atan2(move.x, move.z)
      this._heading += shortAngle(targetH - this._heading) * Math.min(1, GROUND_TURN * dt)

      // SHIFT = sprint, otherwise jog. Accelerate along the push, soft-cap speed.
      const topSpeed = k.shift ? RUN_SPEED : JOG_SPEED
      this.vel.addScaledVector(move, RUN_ACCEL * dt)
      const hs = Math.hypot(this.vel.x, this.vel.z)
      if (hs > topSpeed) {
        const f = topSpeed / hs
        this.vel.x *= f; this.vel.z *= f
      }
    } else {
      // Frame-rate independent friction: full-sprint → ~35% speed remaining after 1s.
      const friction = Math.pow(COAST_FRICTION, dt)
      this.vel.x *= friction
      this.vel.z *= friction
    }

    this.object.position.x += this.vel.x * dt
    this.object.position.z += this.vel.z * dt

    // jump — sprint speed converts into BOTH higher apex and forward launch.
    // Standstill = modest hop (≈4.3 m); full sprint = tall, far arc (≈8 m, the
    // real lift-off to start a swing chain). The run velocity is ALREADY in
    // vel, so JUMP_FWD only adds a small extra nudge — not a second full copy.
    if (k.spacePressed) {
      const hSpeed = Math.hypot(this.vel.x, this.vel.z)
      const fwd = this.forwardXZ() // faces travel direction (heading == push dir)
      this.vel.y = JUMP_V + hSpeed * JUMP_V_PER_SPD // ~18 standing → ~25 at full sprint
      this.vel.addScaledVector(fwd, hSpeed * JUMP_FWD) // small top-up on carried speed
      this.object.position.addScaledVector(fwd, 0.3) // small forward hop
      this.spiderState = 'air'
      this.airTime = 0
      this.airDashUsed = false
      return
    }

    // snap to ground — but ONLY if it's within a step. Walking off a rooftop
    // used to find the street 50 m below and teleport you onto it; now a drop
    // taller than STEP_DOWN drops you into AIR so you fall under gravity.
    const g = this.sampleGround(
      this.object.position.x, this.object.position.z, terrain,
      this.object.position.y + 8, this.object.position.y,
    )
    const feetY = this.object.position.y - COM_HEIGHT
    if (g !== null && feetY - g <= STEP_DOWN) {
      this.object.position.y = g + COM_HEIGHT
      this.vel.y = 0
    } else {
      // walked off an edge (or off a tall drop) into open air → fall
      this.spiderState = 'air'
      this.airTime = 0
      this.airDashUsed = false
    }
  }

  // ── AIR ─────────────────────────────────────────────────────────────────
  private updateAir(
    dt: number, terrain: Object3D,
    k: { w: boolean; s: boolean; a: boolean; d: boolean; space: boolean },
  ): void {
    this.airTime += dt
    // Asymmetric gravity: rise slow, fall hard — kills the floaty apex hang
    // that made him feel weightless. He drops with conviction.
    this.vel.y += (this.vel.y > 0 ? G_RISE : G_FALL) * dt
    if (this.vel.y < -MAX_FALL) this.vel.y = -MAX_FALL

    // Turn: ROTATE the flight direction (not a weak lateral force) — full
    // directional control in the air, SM2-style. The camera follows heading,
    // so turning left also points the next web to the left.
    const steer = (k.a ? 1 : 0) - (k.d ? 1 : 0)
    if (steer !== 0) {
      if (Math.hypot(this.vel.x, this.vel.z) > 0.5) {
        this.rotateVelXZ(steer * AIR_TURN * dt)
      } else {
        this._heading += steer * AIR_TURN * dt // falling straight: aim only
      }
    }

    const horiz = new Vector3(this.vel.x, 0, this.vel.z)
    const hs = horiz.length()
    const hdir = hs > 0.01 ? horiz.clone().divideScalar(hs) : this.forwardXZ()

    // dive (W) trades height for speed; air-brake (S)
    if (k.w) {
      const dive = hdir.clone().add(new Vector3(0, -1.1, 0)).normalize()
      this.vel.addScaledVector(dive, DIVE_ACCEL * dt)
    } else if (k.s) {
      this.vel.x *= AIR_BRAKE; this.vel.z *= AIR_BRAKE
    }

    this.applyAirDrag(dt)
    this.object.position.addScaledVector(this.vel, dt)

    // try to attach while SPACE is held (throttled; brief delay so a jump
    // tap doesn't instantly become a web)
    if (k.space && this.attachCooldown <= 0 && this.airTime >= ATTACH_MIN_AIR) {
      this.attachCooldown = ATTACH_RETRY
      if (this.tryAttach(terrain, k.a, k.d)) return
    }

    // landing (ray from +15 m so a dt spike at terminal velocity can't
    // tunnel the origin below the surface)
    const g = this.sampleGround(
      this.object.position.x, this.object.position.z, terrain,
      this.object.position.y + 15, this.object.position.y,
    )
    if (g !== null && this.vel.y < 0 && this.object.position.y - COM_HEIGHT <= g + 0.5) {
      this.object.position.y = g + COM_HEIGHT
      this.vel.y = 0
      this.airTime = 0
      this.airDashUsed = false
      this.pullCharges = PULL_CHARGES // landing recharges pulls
      this.spiderState = 'ground'
    }
  }

  // ── SWING ─────────────────────────────────────────────────────────────────
  private updateSwing(
    dt: number, terrain: Object3D,
    k: { w: boolean; s: boolean; a: boolean; d: boolean; space: boolean },
  ): void {
    if (!k.space) {
      // release — fling, with a boost. A fast release banks momentum (the
      // deck's "timely point launch" feeds the meter, which powers F-flings).
      this.vel.multiplyScalar(RELEASE_BOOST)
      this.momentum = Math.min(1, this.momentum + MOM_PER_SWING * Math.min(this.vel.length() / MAX_SWING, 1))
      this.spiderState = 'air'
      this.web.visible = false
      return
    }

    // Gravity is the engine — the pendulum converts the drop into speed
    // (v_bottom = √(v₀² + 2·g·h)). No more tangential "motor" that made the
    // swing feel weightless and the dive speed up unnaturally.
    this.vel.y += G_SWING * dt

    const descending = this.vel.y < 0
    if (descending) {
      // W on the downswing = a real DIVE: extra downward force steepens the
      // arc, so the speed you gain arrives through the pendulum (weighted),
      // not injected straight into your velocity. S bleeds it back off.
      if (k.w) this.vel.y -= SWING_DIVE * dt
      else if (k.s) this.vel.y += SWING_DIVE * 0.6 * dt
      // gentle leg-pump along travel — only while descending, so it can never
      // motor you uphill against gravity (that's what killed the rhythm)
      const speed = this.vel.length()
      if (speed > 0.01) this.vel.addScaledVector(this.vel.clone().divideScalar(speed), SWING_PUMP * dt)
    }

    // steer: rotate the horizontal velocity — bends the swing plane toward
    // where the player wants to go without bleeding speed
    const steer = (k.a ? 1 : 0) - (k.d ? 1 : 0)
    if (steer !== 0) this.rotateVelXZ(steer * SWING_TURN * dt)

    // quadratic drag on the swing line too (deck: applied on AND off the line)
    this.applyAirDrag(dt)

    this.object.position.addScaledVector(this.vel, dt)

    // Reel the rope toward the clearance-adjusted length GRADUALLY. The rope
    // starts taut at the attach distance — shortening it instantly via the
    // constraint below teleport-yanked the player toward the building.
    if (this.ropeLen > this.targetRopeLen) {
      this.ropeLen = Math.max(this.targetRopeLen, this.ropeLen - REEL_RATE * dt)
    }

    // rope constraint: project onto sphere, kill outward velocity
    const toAnchor = this.object.position.clone().sub(this.anchor)
    const d = toAnchor.length()
    if (d > this.ropeLen) {
      const n = toAnchor.divideScalar(d)
      this.object.position.copy(this.anchor).addScaledVector(n, this.ropeLen)
      const radial = n.dot(this.vel)
      if (radial > 0) this.vel.addScaledVector(n, -radial)
    }

    if (this.vel.length() > MAX_SWING) this.vel.setLength(MAX_SWING)

    // ground-skim protection — only while descending, so the upswing through
    // a low point doesn't spuriously cut the web
    const g = this.sampleGround(
      this.object.position.x, this.object.position.z, terrain,
      this.object.position.y + 5, this.object.position.y,
    )
    if (g !== null && this.vel.y < 0 && this.object.position.y - COM_HEIGHT < g + 2) {
      // too low — auto-release so we don't faceplant
      this.spiderState = 'air'
      this.web.visible = false
    }
  }

  // ── ZIP ─────────────────────────────────────────────────────────────────
  private updateZip(dt: number, cancel: boolean): void {
    // SPACE mid-zip: cancel and KEEP the full zip velocity — release timing
    // turns zips into momentum tools (hold SPACE to chain straight into a swing)
    if (cancel) {
      this.spiderState = 'air'
      this.web.visible = false
      return
    }

    this.zipElapsed += dt
    this.object.position.addScaledVector(this.vel, dt)
    const reached = this.object.position.distanceTo(this.zipTarget) < 4
    if (reached || this.zipElapsed >= ZIP_TIMEOUT) {
      this.vel.multiplyScalar(0.6)
      this.vel.y += 6 // the SM2 "pop" at the end of a zip
      this.momentum = Math.min(1, this.momentum + MOM_PER_ZIP)
      this.spiderState = 'air'
      this.web.visible = false
    }
  }

  // ── anchor selection ──────────────────────────────────────────────────────
  private tryAttach(terrain: Object3D, holdA: boolean, holdD: boolean): boolean {
    const pos = this.object.position
    const horiz = new Vector3(this.vel.x, 0, this.vel.z)
    const hs = horiz.length()
    const hdir = hs > 0.01 ? horiz.clone().divideScalar(hs) : this.forwardXZ()
    const baseHeading = Math.atan2(hdir.x, hdir.z)

    // Speed-adaptive sweet spots — the non-copout swing assist: slow → close,
    // low anchors (tight quick pendulum that actually gets you moving);
    // fast → the long cinematic band. The picker behaves like a skilled
    // Spidey; the rope itself never cheats for you.
    const spdT = Math.min(hs / 40, 1)
    const upSweet = 12 + (ANCHOR_UP_SWEET - 12) * spdT
    const distSweet = 22 + (ANCHOR_SWEET - 22) * spdT
    const ropeIdeal = 16 + (ROPE_IDEAL - 16) * spdT

    // azimuth offsets, biased toward steering input or alternating each swing
    let azimuths: number[]
    if (holdA && !holdD)      azimuths = [-0.44, -0.26, 0]
    else if (holdD && !holdA) azimuths = [0.44, 0.26, 0]
    else                      azimuths = [0, this.lastSide * 0.35, -this.lastSide * 0.18]
    // 20° ray finds low rooftops; 65° covers towers directly overhead
    const elevations = [0.35, 0.61, 0.87, 1.13] // ~20°, 35°, 50°, 65°

    let best: Vector3 | null = null
    let bestScore = -Infinity
    let bestDist = 0

    for (const az of azimuths) {
      const h = baseHeading + az
      const hx = Math.sin(h)
      const hz = Math.cos(h)
      for (const el of elevations) {
        const dir = new Vector3(hx * Math.cos(el), Math.sin(el), hz * Math.cos(el))
        this.anchorRay.set(pos, dir)
        this.anchorRay.far = ANCHOR_RANGE
        const hits = this.anchorRay.intersectObject(terrain, true)
        if (hits.length === 0) continue
        const hit = hits[0].point
        const up = hit.y - pos.y
        if (up < ANCHOR_MIN_UP) continue
        const dist = pos.distanceTo(hit)
        const toHit = new Vector3(hit.x - pos.x, 0, hit.z - pos.z).normalize()
        const fwdDot = toHit.dot(hdir)
        // Adaptive: prefer a sweet BAND of height above the player rather
        // than rewarding raw height — on a skyscraper this used to pick the
        // very top, giving a 90 m rope with a slow, momentum-killing arc.
        // On low blocks, the nearest-to-band anchor still wins even at +5 m.
        const score =
          -Math.abs(up - upSweet) * 1.2
          - Math.abs(dist - distSweet) * 0.5
          + fwdDot * 15
        if (score > bestScore) {
          bestScore = score
          best = hit.clone()
          bestDist = dist
        }
      }
    }

    if (!best) return false

    // The rope starts TAUT at the attach distance — no positional snap on
    // attach. The ground-clearance assist (arc must never clip the street)
    // only sets the target the rope reels toward during the swing.
    let clearanceLen = bestDist
    const groundY = this.sampleGround(pos.x, pos.z, terrain, pos.y + 5, pos.y)
    if (groundY !== null) {
      const arcBottom = best.y - clearanceLen
      const minBottom = groundY + GROUND_CLEAR + COM_HEIGHT
      if (arcBottom < minBottom) clearanceLen = best.y - minBottom
    }

    this.anchor.copy(best)
    this.ropeLen = bestDist
    // Reel toward the shortest of: ground clearance, attach distance, and the
    // (speed-scaled) ideal length — a long rope on a tall attach reels down to
    // a tight, fast pendulum instead of a slow 90 m arc (reeling in adds speed).
    this.targetRopeLen = Math.max(Math.min(clearanceLen, bestDist, ropeIdeal), 6)
    this.spiderState = 'swing'
    this.web.visible = true
    this.lastSide = -this.lastSide
    this.airDashUsed = false
    this.pullCharges = PULL_CHARGES // attaching a swing recharges pulls
    return true
  }

  // ── zip / air-dash ──────────────────────────────────────────────────────

  /**
   * Where SHIFT would zip to right now — shared by the reticle and tryZip.
   * Casts a fan of elevations and picks the HIGHEST hit (not the first), so
   * you zip to rooftops instead of getting stuck on a wall base. Holding W
   * adds a near-vertical ray so W+SHIFT zips straight up to a ledge overhead.
   */
  private computeZipTarget(terrain: Object3D, vertical = false): Vector3 | null {
    const horiz = new Vector3(this.vel.x, 0, this.vel.z)
    const hs = horiz.length()
    const hdir = hs > 0.01 ? horiz.divideScalar(hs) : this.forwardXZ()
    const elevations = vertical
      ? [0.44, 0.79, 1.22, 1.48] // + ~85° for W+SHIFT vertical zips
      : [0.44, 0.79, 1.22]       // ~25°, 45°, 70°
    let best: Vector3 | null = null
    for (const el of elevations) {
      const dir = new Vector3(hdir.x * Math.cos(el), Math.sin(el), hdir.z * Math.cos(el))
      this.anchorRay.set(this.object.position, dir)
      this.anchorRay.far = ZIP_RANGE
      const hits = this.anchorRay.intersectObject(terrain, true)
      if (hits.length > 0 && (!best || hits[0].point.y > best.y)) {
        best = hits[0].point.clone()
      }
    }
    return best
  }

  private tryZip(terrain: Object3D, vertical: boolean): void {
    const tgt = this.computeZipTarget(terrain, vertical)
    if (tgt) {
      this.zipTarget.copy(tgt)
      this.zipElapsed = 0
      this.vel.copy(this.zipTarget).sub(this.object.position).normalize().multiplyScalar(ZIP_SPEED)
      this.spiderState = 'zip'
      this.web.visible = true
      return
    }

    // no anchor — one air dash to recover (the over-water escape hatch)
    if (!this.airDashUsed && this.spiderState === 'air') {
      const horiz = new Vector3(this.vel.x, 0, this.vel.z)
      const hs = horiz.length()
      const hdir = hs > 0.01 ? horiz.divideScalar(hs) : this.forwardXZ()
      this.vel.addScaledVector(hdir, AIR_DASH_V)
      this.airDashUsed = true
    }
  }

  /**
   * E — web pull: a STRAIGHT-LINE yank toward a surface ahead (not a pendulum).
   * Fires a web at the surface, then for PULL_DURATION the player travels in a
   * straight line toward it at PULL_SPEED with gravity suppressed — a Spidey
   * "web-zip-lite" to build momentum or close distance, angled slightly up.
   * Needs a real surface hit (the charge is spent on luck-free aim); 2 charges
   * per airtime, recharged on land/attach.
   */
  private tryPull(terrain: Object3D): void {
    if (this.pullCharges <= 0 || this.pullCooldown > 0) return

    const horiz = new Vector3(this.vel.x, 0, this.vel.z)
    const hs = horiz.length()
    const hdir = hs > 0.01 ? horiz.divideScalar(hs) : this.forwardXZ()

    // Try 10°, 25°, 45° — take the first hit (this is a forward speed tool,
    // so a low/flat ray is preferred over reaching for rooftops)
    let hitPoint: Vector3 | null = null
    for (const el of [0.17, 0.44, 0.79]) {
      const dir = new Vector3(hdir.x * Math.cos(el), Math.sin(el), hdir.z * Math.cos(el))
      this.anchorRay.set(this.object.position, dir)
      this.anchorRay.far = PULL_RANGE
      const hits = this.anchorRay.intersectObject(terrain, true)
      if (hits.length > 0) { hitPoint = hits[0].point.clone(); break }
    }
    if (!hitPoint) return // no surface → no pull, charge preserved

    // Straight-line velocity toward the hit, with a floor on the vertical
    // component so the pull always lifts slightly rather than dragging down.
    const dir = hitPoint.clone().sub(this.object.position).normalize()
    dir.y = Math.max(dir.y, PULL_MIN_UP)
    dir.normalize()
    this.vel.copy(dir).multiplyScalar(PULL_SPEED)

    this.pullPoint.copy(hitPoint)
    this.pullElapsed = 0
    this.spiderState = 'pull'
    this.web.visible = true
    this.pullCharges--
    this.pullCooldown = PULL_COOLDOWN
  }

  /** Active straight-line pull: constant-velocity travel, gravity suppressed. */
  private updatePull(dt: number, terrain: Object3D): void {
    this.pullElapsed += dt
    this.object.position.addScaledVector(this.vel, dt)

    // End the pull on timeout, on reaching the anchor, or on a ground hit.
    const reached = this.object.position.distanceTo(this.pullPoint) < 3
    if (reached || this.pullElapsed >= PULL_DURATION) {
      // Exit carrying full momentum — chain straight into a swing or another pull.
      this.spiderState = 'air'
      this.web.visible = false
      this.airTime = ATTACH_MIN_AIR // allow an immediate re-attach
      return
    }

    // bail if we'd tunnel into terrain mid-pull
    const g = this.sampleGround(
      this.object.position.x, this.object.position.z, terrain,
      this.object.position.y + 5, this.object.position.y,
    )
    if (g !== null && this.object.position.y - COM_HEIGHT <= g + 0.5) {
      this.object.position.y = g + COM_HEIGHT
      this.vel.y = 0
      this.spiderState = 'ground'
      this.pullCharges = PULL_CHARGES
      this.web.visible = false
    }
  }

  // ── air drag (quadratic) ──────────────────────────────────────────────────
  /** Bleed speed ∝ v², opposite velocity. Momentum meter reduces it (aero). */
  private applyAirDrag(dt: number): void {
    const speed = this.vel.length()
    if (speed < 0.01) return
    const k = DRAG_K * (1 - (1 - DRAG_MIN_MULT) * this.momentum)
    const newSpeed = Math.max(0, speed - k * speed * speed * dt)
    this.vel.multiplyScalar(newSpeed / speed)
  }

  // ── wall-run / cling ──────────────────────────────────────────────────────
  /**
   * Stick to a wall you're moving INTO with speed, carrying that momentum onto
   * the face. Returns true if it clung this frame. The outward normal is taken
   * as the horizontalized vector from the wall hit back to the player — robust
   * to the lumpy normals of Google's photogrammetry meshes.
   */
  private tryWallCling(terrain: Object3D): boolean {
    const hs = Math.hypot(this.vel.x, this.vel.z)
    if (hs < WALL_MIN_SPEED) return false
    const into = new Vector3(this.vel.x / hs, 0, this.vel.z / hs)

    // Wide ray fan so you don't have to aim dead-on at the façade — any wall
    // roughly ahead grabs. Closest azimuth wins (first hit).
    let hit: Vector3 | null = null
    for (const az of [0, 0.3, -0.3, 0.55, -0.55]) {
      const c = Math.cos(az), s = Math.sin(az)
      const dir = new Vector3(into.x * c + into.z * s, 0, into.z * c - into.x * s)
      this.anchorRay.set(this.object.position, dir)
      this.anchorRay.far = WALL_RANGE
      const hits = this.anchorRay.intersectObject(terrain, true)
      if (hits.length > 0) { hit = hits[0].point.clone(); break }
    }
    if (!hit) return false

    const n = new Vector3(this.object.position.x - hit.x, 0, this.object.position.z - hit.z)
    if (n.lengthSq() < 1e-4) return false
    n.normalize()
    // Only need to be heading toward the wall at all (not parallel/away). Loose
    // so head-on AND angled approaches both stick.
    if (into.dot(n) > -0.15) return false

    this.wallNormal.copy(n)
    this.wallTime = 0
    // REDIRECT the full speed onto the wall plane instead of deleting the
    // into-wall part. Keep the along-wall direction if there was real sideways
    // motion; otherwise (a head-on slam) launch straight UP into a climb. This
    // is the forgiving carry — you keep your momentum from any approach angle.
    const speed = this.vel.length()
    const plane = this.vel.clone().addScaledVector(n, -this.vel.dot(n))
    const dir = plane.lengthSq() > 4 ? plane.normalize() : UP.clone()
    // Never START a wall-run sliding DOWN: if the approach was descending (you
    // almost always are by the time you reach a wall), floor the vertical so a
    // sideways approach stays level and a forward one heads up — no fighting
    // your own downward inertia before the climb can win.
    dir.y = Math.max(dir.y, 0)
    if (dir.lengthSq() < 1e-4) dir.copy(UP)
    dir.normalize()
    this.vel.copy(dir).multiplyScalar(speed * WALL_CARRY)
    this.spiderState = 'wall'
    this.web.visible = false
    return true
  }

  private updateWall(
    dt: number, terrain: Object3D,
    k: { w: boolean; s: boolean; a: boolean; d: boolean; spacePressed: boolean },
  ): void {
    this.wallTime += dt

    const tangent = new Vector3(this.wallNormal.z, 0, -this.wallNormal.x) // along the face

    // jump off the wall (away + up), CARRYING the along-wall run momentum so a
    // sideways sprint launches into a fast diagonal leap instead of dying. Use
    // max(vy,0) so a downward slide can't eat the jump height (bug: speed loss).
    if (k.spacePressed) {
      this.vel.addScaledVector(this.wallNormal, WALL_JUMP_OUT)
      this.vel.y = Math.max(this.vel.y, 0) + WALL_JUMP_UP
      this.spiderState = 'air'
      this.airTime = 0
      this.airDashUsed = false
      return
    }

    // climb (W) / descend (S); A/D traverse along the wall tangent. No constant
    // gravity — a spider clings. With NO input, velocity decays toward zero so
    // he sticks in place rather than sliding down the face.
    if (k.w) {
      this.vel.y += WALL_CLIMB * dt
      this.momentum = Math.min(1, this.momentum + MOM_PER_CLIMB * dt)
    } else if (k.s) {
      this.vel.y -= WALL_CLIMB * 0.5 * dt
    } else {
      this.vel.y *= Math.pow(WALL_STICK, dt) // arrest vertical drift → stick
    }
    // D = screen-right, A = screen-left. The wall camera looks at the face from
    // the outward normal, so +tangent (n.z,0,-n.x) IS screen-right — D must be +.
    const tIn = (k.d ? 1 : 0) - (k.a ? 1 : 0)
    if (tIn !== 0) {
      this.vel.addScaledVector(tangent, tIn * WALL_TRAVERSE * dt)
    } else {
      // no traverse input → bleed the along-wall drift so idle = stick (not a
      // perpetual sideways slide carried over from the last run).
      const tv = this.vel.dot(tangent)
      this.vel.addScaledVector(tangent, -tv * (1 - Math.pow(WALL_STICK, dt)))
    }

    if (this.vel.length() > WALL_MAX) this.vel.setLength(WALL_MAX)
    this.object.position.addScaledVector(this.vel, dt)

    // Land when the wall meets the street: without this, running DOWN to the
    // base kept us in 'wall' state, sinking the origin through the building
    // floor until the wall probe missed — dropping us inside the mesh and out
    // of the world. Snap to ground and hand off to 'ground'.
    const groundY = this.sampleGround(
      this.object.position.x, this.object.position.z, terrain,
      this.object.position.y + 5, this.object.position.y,
    )
    if (groundY !== null && this.object.position.y - COM_HEIGHT <= groundY + 0.5) {
      this.object.position.y = groundY + COM_HEIGHT
      this.vel.y = 0
      this.airTime = 0
      this.airDashUsed = false
      this.pullCharges = PULL_CHARGES
      this.spiderState = 'ground'
      this.web.visible = false
      return
    }

    // re-stick: probe the wall again. Keep the range TIGHT so it can't reach
    // across a gap and yank you onto a far surface (the "teleport to the next
    // building" bug). A miss — or a hit too far to be the same face — means you
    // ran off an edge (top, side, or bottom).
    this.anchorRay.set(this.object.position, this.wallNormal.clone().negate())
    this.anchorRay.far = WALL_RANGE * 1.3
    const hits = this.anchorRay.intersectObject(terrain, true)
    const offWall = hits.length === 0 || hits[0].distance > WALL_RANGE * 1.3
    if (offWall) {
      if (this.vel.y > 2) {
        // Crested the TOP while climbing → MANTLE onto the roof (step forward
        // over the lip onto the building top), instead of bouncing backward off
        // the wall. The air state then lands you on the roof.
        const onto = this.wallNormal.clone().negate() // toward the roof, over the lip
        this.object.position.addScaledVector(onto, 1.8)
        this.object.position.y += 1.0
        this.vel.x = onto.x * 8
        this.vel.z = onto.z * 8
        this.vel.y = Math.max(this.vel.y, 4)
      } else {
        // Ran off the SIDE or bottom → kick outward and fall under gravity (no
        // scraping straight down the face).
        this.vel.addScaledVector(this.wallNormal, WALL_EDGE_OUT)
      }
      this.spiderState = 'air'
      this.airTime = 0
      this.airDashUsed = false
      return
    }
    const hit = hits[0].point
    // refresh + smooth the outward normal so it follows wall curvature
    const n = new Vector3(this.object.position.x - hit.x, 0, this.object.position.z - hit.z)
    if (n.lengthSq() > 1e-4) {
      n.normalize()
      this.wallNormal.lerp(n, Math.min(1, dt * 8)).normalize()
    }
    // pin the cling distance and kill any residual into/out-of-wall velocity.
    // Clamp the correction so a lumpy photogrammetry façade can't teleport-snap
    // you frame to frame — it eases instead.
    const vn = this.vel.dot(this.wallNormal)
    this.vel.addScaledVector(this.wallNormal, -vn)
    const corr = Math.max(-1.5, Math.min(1.5, this.object.position.distanceTo(hit) - WALL_CLING_DIST))
    this.object.position.addScaledVector(this.wallNormal, -corr)

    // give up if we've been stuck without climbing (lumpy façade snag)
    if (this.wallTime > WALL_GIVEUP && !k.w && Math.abs(this.vel.y) < 2) {
      this.spiderState = 'air'
      this.airTime = 0
    }
  }

  /**
   * Probe upward along the wall for the top edge. Returns metres above the
   * player to the lip, or null if the top is farther than ~11 m (mid-wall).
   * Works by casting INTO the wall at rising heights — the first height that
   * misses is roughly where the façade ends.
   */
  private wallTopHeight(terrain: Object3D): number | null {
    const into = this.wallNormal.clone().negate()
    for (const h of [1, 3, 5, 7, 9, 11]) {
      const from = this.object.position.clone()
      from.y += h
      this.anchorRay.set(from, into)
      this.anchorRay.far = WALL_RANGE * 1.6
      if (this.anchorRay.intersectObject(terrain, true).length === 0) return h
    }
    return null
  }

  // ── web-fling / slingshot ─────────────────────────────────────────────────
  /**
   * F — web-fling.
   *  • On a wall, MID-FACE: two webs fire up-left & up-right (a V) and catapult
   *    you straight UP — a short propulsion boost to gain height fast.
   *  • On a wall, NEAR THE TOP: a web grabs the lip and slings you UP and
   *    FORWARD *over* the building (over-the-top, to carry speed onward) — not
   *    the old backward kick away from the wall.
   *  • In air/swing: a point-launch speed boost along travel.
   * Either spends momentum. Wall flings flash visible web lines (flingFlash).
   */
  private tryFling(terrain: Object3D): void {
    if (this.spiderState === 'wall') {
      const boost = 0.7 + 0.6 * this.momentum
      const tangent = new Vector3(this.wallNormal.z, 0, -this.wallNormal.x)
      const toTop = this.wallTopHeight(terrain)

      if (toTop !== null && toTop <= FLING_TOP_REACH) {
        // NEAR TOP → over-the-top fling: up + FORWARD across the roof.
        const over = this.wallNormal.clone().negate() // toward/over the building
        this.object.position.y += toTop * 0.4 // hop toward the lip
        this.vel.x = over.x * FLING_FWD * boost
        this.vel.z = over.z * FLING_FWD * boost
        this.vel.y = Math.max(this.vel.y, 0) + FLING_UP * 0.7 * boost
        // single web to the lip ahead
        this.flingAnchorA.copy(this.object.position)
          .addScaledVector(UP, toTop + 1)
          .addScaledVector(over, 2)
        this.flingCount = 1
      } else {
        // MID-WALL → V-catapult: two webs up the face, straight-up boost.
        this.vel.y = Math.max(this.vel.y, 0) + FLING_UP * boost
        this.flingAnchorA.copy(this.object.position)
          .addScaledVector(UP, FLING_WEB_LEN).addScaledVector(tangent, 4)
        this.flingAnchorB.copy(this.object.position)
          .addScaledVector(UP, FLING_WEB_LEN).addScaledVector(tangent, -4)
        this.flingCount = 2
      }

      this.flingFlash = 0.22
      this.momentum = Math.max(0, this.momentum - FLING_DRAIN)
      this.spiderState = 'air'
      this.airTime = 0
      this.airDashUsed = false
      this.web.visible = false
      return
    }
    if (this.spiderState === 'air' || this.spiderState === 'swing') {
      const hs = Math.hypot(this.vel.x, this.vel.z)
      const dir = hs > 0.5 ? new Vector3(this.vel.x / hs, 0, this.vel.z / hs) : this.forwardXZ()
      this.vel.addScaledVector(dir, FLING_BOOST * (0.3 + 0.7 * this.momentum))
      this.vel.y += 4 // slight lift so the point-launch clears the next gap
      this.momentum = Math.max(0, this.momentum - FLING_DRAIN)
      this.spiderState = 'air'
      this.web.visible = false
    }
  }

  /** Rotate the horizontal velocity by `ang` radians (+ = left). */
  private rotateVelXZ(ang: number): void {
    const c = Math.cos(ang)
    const s = Math.sin(ang)
    const vx = this.vel.x
    const vz = this.vel.z
    this.vel.x = vx * c + vz * s
    this.vel.z = vz * c - vx * s
  }

  // ── visuals ───────────────────────────────────────────────────────────────
  private updateBodyPose(dt: number): void {
    const target = new Quaternion()
    if (this.spiderState === 'wall') {
      // Cling: belly flat against the wall (body +Z = into the wall), and the
      // body's "up" axis points along the direction of travel ON the wall. So
      // climbing → head points up (upright climb); a sideways run → head leads
      // and the body lies HORIZONTAL against the face (Insomniac's slanted
      // wall-run). Built as an explicit orthonormal basis so both read cleanly.
      const n = this.wallNormal // outward, horizontal
      const along = this.vel.clone().addScaledVector(n, -this.vel.dot(n)) // travel in wall plane
      const yAxis = along.lengthSq() > 1 ? along.normalize() : UP.clone() // idle → stand upright
      const zAxis = n.clone().negate() // belly faces into the wall
      const xAxis = new Vector3().crossVectors(yAxis, zAxis).normalize()
      zAxis.crossVectors(xAxis, yAxis).normalize() // re-orthogonalize
      target.setFromRotationMatrix(new Matrix4().makeBasis(xAxis, yAxis, zAxis))
    } else if (this.spiderState === 'swing' || this.spiderState === 'zip') {
      // hang from the web: local +Y points toward the web's far end
      // (zip uses zipTarget — anchor would be stale from the previous swing)
      const ref = this.spiderState === 'zip' ? this.zipTarget : this.anchor
      const up = ref.clone().sub(this.object.position)
      if (up.lengthSq() > 0.001) {
        up.normalize()
        target.setFromUnitVectors(new Vector3(0, 1, 0), up)
      }
    } else {
      // ground / air: orient along the full velocity vector so the body
      // visually dives when moving downward and glides when horizontal.
      // Hold W → downward velocity → he pitches nose-down into a dive.
      // Release → velocity flattens → he returns upright. Pure physics-driven.
      let lean = 0
      if (this.spiderState === 'air') {
        const horizSpeed = Math.hypot(this.vel.x, this.vel.z)
        const vertSpeed = this.vel.y
        // pitch = angle from horizontal: diving → positive lean (forward/down tilt)
        lean = Math.atan2(-vertSpeed, Math.max(horizSpeed, 1)) * 0.65
        lean = Math.max(-1.3, Math.min(1.3, lean))
      }
      target.setFromEuler(new Euler(lean, this._heading, 0, 'YXZ'))
    }
    this.bodyGroup.quaternion.slerp(target, Math.min(1, dt * 6))
  }

  private updateWeb(): void {
    if (!this.web.visible) return
    const to = this.spiderState === 'zip' ? this.zipTarget
      : this.spiderState === 'swing' ? this.anchor
      : this.pullPoint // air: brief pull-flash line
    if (!this.orientWeb(this.web, to)) this.web.visible = false
  }

  /**
   * Stretch/orient a web cylinder from the player to a WORLD point. Children of
   * `object` live in object-local space (the object never rotates), so local
   * coords == the world delta. Returns false if the span is ~zero.
   */
  private orientWeb(mesh: Mesh, worldTo: Vector3): boolean {
    const delta = worldTo.clone().sub(this.object.position)
    const len = delta.length()
    if (len < 0.01) return false
    mesh.position.copy(delta.clone().multiplyScalar(0.5))
    mesh.scale.set(1, len, 1)
    mesh.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), delta.divideScalar(len))
    return true
  }

  /** Flash the fling web line(s) for a fraction of a second after an F-fling. */
  private updateFlingWebs(dt: number): void {
    if (this.flingFlash <= 0) {
      this.flingWebA.visible = false
      this.flingWebB.visible = false
      return
    }
    this.flingFlash -= dt
    this.flingWebA.visible = this.orientWeb(this.flingWebA, this.flingAnchorA)
    this.flingWebB.visible =
      this.flingCount >= 2 && this.orientWeb(this.flingWebB, this.flingAnchorB)
  }

  public override get state(): VehicleState {
    return {
      label: this.label,
      speed: this._speed,
      heading: this._heading,
      altitude: null,
      mode: `${STATE_LABEL[this.spiderState]} · pull×${this.pullCharges} · mom ${Math.round(this.momentum * 100)}%`,
      fovBoost: Math.min(this._speed / MAX_SWING, 1),
      // Only while clung — lets the follow camera frame the wall face.
      wallNormal: this.spiderState === 'wall'
        ? [this.wallNormal.x, this.wallNormal.y, this.wallNormal.z]
        : undefined,
    }
  }
}

// ─── zip target reticle (billboard sprite) ──────────────────────────────────
function buildZipReticle(): Sprite {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 64
  const ctx = canvas.getContext('2d')!
  ctx.strokeStyle = '#7dd3fc'
  ctx.lineWidth = 5
  ctx.beginPath()
  ctx.arc(32, 32, 24, 0, Math.PI * 2)
  ctx.stroke()
  ctx.fillStyle = '#e0f2fe'
  ctx.beginPath()
  ctx.arc(32, 32, 5, 0, Math.PI * 2)
  ctx.fill()

  const sprite = new Sprite(
    new SpriteMaterial({
      map: new CanvasTexture(canvas),
      transparent: true,
      depthTest: false,
    }),
  )
  sprite.scale.set(4, 4, 1)
  sprite.renderOrder = 950
  sprite.visible = false
  return sprite
}

// ─── primitive stickman (origin at torso centre, ~1.8 m tall) ───────────────
// Replaceable later by a rigged GLB via MODEL_CATALOG['spider'].
export function buildSpiderPrimitive(): Group {
  const g = new Group()
  const red = new MeshStandardMaterial({ color: 0xc1121f, roughness: 0.5 })
  const blue = new MeshStandardMaterial({ color: 0x1f3a8c, roughness: 0.5 })

  const head = new Mesh(new SphereGeometry(0.17, 12, 10), red)
  head.position.y = 0.9

  const torso = new Mesh(new BoxGeometry(0.34, 0.6, 0.2), red)
  torso.position.y = 0.4

  const hips = new Mesh(new BoxGeometry(0.3, 0.2, 0.18), blue)
  hips.position.y = 0.05

  const limbGeo = new CylinderGeometry(0.055, 0.055, 0.6, 8)

  const armL = new Mesh(limbGeo, red)
  armL.position.set(-0.26, 0.45, 0)
  armL.rotation.z = 0.35
  const armR = new Mesh(limbGeo, red)
  armR.position.set(0.26, 0.45, 0)
  armR.rotation.z = -0.35

  const legL = new Mesh(limbGeo, blue)
  legL.position.set(-0.11, -0.35, 0)
  const legR = new Mesh(limbGeo, blue)
  legR.position.set(0.11, -0.35, 0)

  g.add(head, torso, hips, armL, armR, legL, legR)
  return g
}
