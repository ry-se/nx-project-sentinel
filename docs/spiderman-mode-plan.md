# Spider-Man Mode — Implementation Plan

Secret 4th vehicle: a web-swinging character, toggled with the hidden key **`5`**
(player mode only, not shown in the sidebar). POC quality: stickman built from
primitives, **no animation rig** — animations come later via Blender MCP.
The goal of v1 is to nail the *swinging feel* of Marvel's Spider-Man 2.

---

## 1. Files

| File | Change |
|---|---|
| `engine/spiderman.ts` | **NEW** — `SpiderVehicle` class (~350 lines): state machine, physics, anchor selection, web line, stickman body |
| `engine/vehicles.ts` | `export` the abstract `Vehicle` class + `DOWN` const; add `'spider'` to `VehicleType`; register in `VehicleManager`; extend `VehicleState` with `mode?: string` and `fovBoost?: number`; hudText shows spider state |
| `engine/createSandbox.ts` | Add `'5': 'spider'` to `typeByKey` (createSandbox.ts:264); camera FOV kick + faster follow lerp at speed (updateCamera, createSandbox.ts:293) |
| `WorldView.tsx` | Status-bar hint when spider is active (mirror the jet pattern, WorldView.tsx:208). Do **not** add to `VEHICLES` list — it stays secret |

No new dependencies. All raycasts go against `tiles.group` (already passed to
`vehicles.update` as `terrain`).

---

## 2. Why spider is different from the other vehicles

Tank/car/jet store `_speed` (scalar) + `_heading`. Spider needs a **full 3D
velocity vector** — swinging is momentum in all axes. Keep `_heading` updated
from horizontal velocity (`Math.atan2(vel.x, vel.z)`) so the existing follow
camera works unchanged. Report `_speed = vel.length()` for the HUD.

```ts
class SpiderVehicle extends Vehicle {
  readonly label = 'SPIDER'
  readonly cameraDist = 14          // close camera — speed feels 3x faster
  // fireCooldown stays 0 → VehicleManager never fires on SPACE. SPACE is ours.
  private vel = new Vector3()
  private state: 'ground' | 'air' | 'swing' | 'zip' = 'air'
  ...
}
```

---

## 3. Constants (single tuning table at top of spiderman.ts)

```ts
const G            = -32    // m/s² — ~3x real gravity. Floaty is the enemy.
const RUN_SPEED    = 14     // m/s ground sprint
const RUN_ACCEL    = 40
const JUMP_V       = 16     // m/s vertical jump impulse
const AIR_STEER    = 14     // m/s² lateral air control
const DIVE_ACCEL   = 50     // m/s² when holding W airborne (pitch down + speed)
const SWING_PUMP   = 9      // m/s² tangential boost while holding SPACE
const SWING_STEER  = 22     // m/s² lateral force from A/D while swinging
const RELEASE_BOOST= 1.06   // velocity multiplier on web release
const MAX_SWING    = 72     // m/s soft cap while attached (~260 km/h)
const MAX_FALL     = 85     // m/s terminal velocity
const ZIP_SPEED    = 55     // m/s web-zip travel speed
const ANCHOR_MIN_UP= 12     // anchor must be ≥ this many m above player
const ANCHOR_RANGE = 95     // max web length
const GROUND_CLEAR = 3      // swing arc must clear ground by this margin
```

Tune `G`, `SWING_PUMP`, `RELEASE_BOOST` first — they define 90% of the feel.

---

## 4. State machine

```
            tap SPACE (jump)                hold SPACE + anchor found
  GROUND ───────────────────► AIR ─────────────────────────────────► SWING
    ▲                          ▲  ◄───────── release SPACE ────────────┘
    │      lands (raycast      │              (× RELEASE_BOOST)
    └────── down, vy < 0) ─────┴──◄── ZIP ends (reach point / 1.5 s timeout)
                                       ▲
                              tap SHIFT in AIR/SWING + zip target found
```

### GROUND
- WASD **camera-relative** (this is critical — not tank controls):
  `moveDir = camForward*inputY + camRight*inputX`, Y zeroed, normalized.
  The camera yaw is available as `state.heading + orbitYaw` — simplest is to
  pass nothing and use the player's `_heading` + input mix; acceptable v1:
  W = current heading, A/D rotate heading at 3 rad/s, like the car but faster.
  (True camera-relative needs camera yaw plumbed into update — optional v1.)
- Friction: `vel.x/z *= 0.85^…` when no input. Snap to ground via existing
  `sampleGround` (pass `vehicleFloorY` to ignore overhead bridges).
- Tap SPACE → `vel.y = JUMP_V` + 0.3×horizontal speed bonus forward → AIR.

### AIR (ballistic)
- `vel.y += G*dt`, clamp fall to MAX_FALL.
- A/D: lateral accel `AIR_STEER` perpendicular to horizontal velocity.
- **Hold W = dive**: accelerate along `(horizontalDir + down).normalize()` at
  `DIVE_ACCEL`. This is the SM2 height→speed trade. Hold S = air brake
  (drag ×0.97/frame).
- **Hold SPACE → try attach** (see §5). Re-try every 0.1 s while held, not
  every frame (throttle the ray fan).
- Land: raycast down 2.5 m; if hit and `vel.y < 0` → GROUND, keep horizontal
  momentum (it decays via friction — feels like a running landing). No fall
  damage.

### SWING (pendulum on a rope)
Semi-implicit Euler + position projection — stable at any dt we'll see:

```ts
vel.y += G * dt
vel.addScaledVector(tangentSteer, SWING_STEER * dt)   // from A/D
vel.addScaledVector(velDir, SWING_PUMP * dt)          // hold-to-pump
pos.addScaledVector(vel, dt)

const toAnchor = pos.clone().sub(anchor)
const d = toAnchor.length()
if (d > ropeLen) {
  const n = toAnchor.divideScalar(d)               // outward normal
  pos.copy(anchor).addScaledVector(n, ropeLen)     // project onto sphere
  const radial = n.dot(vel)
  if (radial > 0) vel.addScaledVector(n, -radial)  // kill outward velocity
}
if (vel.length() > MAX_SWING) vel.setLength(MAX_SWING)
```

- Release SPACE → `vel.multiplyScalar(RELEASE_BOOST)` → AIR. Releasing at the
  bottom of the arc throws you forward; late release flings you up. That
  emerges from the physics — no special code.
- While swinging, if a down-raycast says ground < 2 m → force release (skim
  protection).

### ZIP (tap SHIFT in AIR or SWING)
- Single raycast: direction = horizontal velocity dir pitched up +25°
  (fallback: straight ahead). Range 120 m against tiles.
- Hit → `vel = dirToPoint * ZIP_SPEED`, gravity OFF, fly straight. End when
  within 4 m of point or after 1.5 s → AIR with `vel *= 0.6` + `vel.y += 6`
  (the SM2 "pop" at the end of a zip). No hit → one **air dash** instead
  (`vel += horizontalDir * 12`), max one per airborne period — this is the
  over-water recovery tool. Reset the dash counter on landing or attaching.

---

## 5. Anchor selection (the thing that makes it feel like SM2)

When SPACE is held in AIR, cast a **fan of 9 rays** against `tiles.group`:

- Base azimuth = horizontal velocity direction (player `_heading` if slow).
- Azimuth offsets: `[0°, ±25°]` — but **biased**: if A is held, only try
  left offsets; if D, only right. Otherwise alternate sides each swing
  (`lastSide = -lastSide`) → the natural SM zigzag down a street.
- Elevations: `[35°, 50°, 65°]` up from horizontal.
- `raycaster.far = ANCHOR_RANGE`, `firstHitOnly = true` (9 rays, only on
  attach attempts — negligible cost).

**Score the hits**, pick the best:
```
reject if  hit.y - player.y < ANCHOR_MIN_UP        // too low, useless web
score = (hit.y - player.y)                          // higher is better
      - |dist - 55| * 0.5                           // sweet spot ~55 m away
      + forwardDot * 20                             // prefer ahead of travel
```
No valid hit → stay in AIR (webs need buildings — over Marina Bay water you
must zip/dash or fall. Authentic.)

**Rope length + ground-clearance assist** (Insomniac's most important cheat):
```ts
ropeLen = dist * 0.97                       // slight pre-tension
const groundY = sampleGround(anchor.x, anchor.z, ...) ?? player floor
const arcBottom = anchor.y - ropeLen        // lowest point of the arc
const minBottom = groundY + GROUND_CLEAR + 2
if (arcBottom < minBottom) ropeLen = anchor.y - minBottom   // auto-shorten
```
Without this you faceplant constantly and it feels broken. With it, low
swings skim the road thrillingly and never hit.

Attaching from GROUND: allow if an anchor is found — the projection constraint
with `ropeLen = dist * 0.9` yanks the player off the ground into a swing
(free "kickoff" behavior, matches SM2 swing-from-standstill).

---

## 6. Web line + stickman body

**Web**: one thin white cylinder (`CylinderGeometry(0.05, 0.05, 1)`), scaled
to `|player→anchor|` each frame, positioned at the midpoint, oriented with
`quaternionFromUnitVectors(Y_UP, dir)`. Visible only in SWING/ZIP. Layer 1.

**Body** (all primitives, one `Group`, total ~1.8 m tall, red/blue materials):
- head: `SphereGeometry(0.16)`, torso: `BoxGeometry(0.34, 0.55, 0.2)`,
  4 limbs: `CylinderGeometry(0.05, 0.05, 0.55)` posed statically.
- Procedural orientation per state (this sells it despite zero animation):
  - GROUND: upright, facing heading.
  - AIR: align body's forward axis to velocity (superman dive pose when fast).
  - SWING: body's up-axis points at the anchor (hangs from the web), facing
    travel direction. `Quaternion.slerp` toward the target pose at
    `dt * 6` — never snap.

---

## 7. Camera changes (createSandbox.ts `updateCamera`)

Two additions, both gated on spider being active (expose via
`vehicles.state.fovBoost`):

1. **FOV kick**: `targetFov = 60 + 18 * clamp(speed/MAX_SWING, 0, 1)`;
   lerp `camera.fov` toward it at `dt * 3`, call `updateProjectionMatrix()`
   when it changes by > 0.1. Contributes ~40% of the sensation of speed.
2. **Faster follow**: the current `lerp(dt * 5)` lags too far behind at
   70 m/s — use `dt * 8` when the active vehicle reports a `fovBoost`.
   Also lerp `camTarget` ahead: `t + velDir * speed * 0.25` so the camera
   looks where you're going, not at your feet.

Keep orbit-drag and wheel zoom working as-is.

---

## 8. Integration details

- `VehicleType = 'tank' | 'car' | 'jet' | 'spider'` — check every
  `Record<VehicleType, …>` still compiles (the `typeByKey` map and `VEHICLES`
  array in WorldView use partial lists — `typeByKey` is `Record<string,
  VehicleType>` so adding `'5': 'spider'` is the only change needed there).
- `VehicleManager.switchTo('spider')`: copy position, `+10` m up (drop-in
  entrance), state = AIR.
- `vehicles.ts` keydown already lowercases keys and ignores form fields —
  SHIFT arrives as `'shift'`, already handled the same way the jet uses it.
- SPACE conflict: none — manager only fires when `fireCooldown > 0`; spider
  keeps the default 0. But keep `e.preventDefault()` on space (already in
  `onKeyDown`) so the page doesn't scroll.
- `hudText()`: when state has `mode`, append it (`SWINGING / FALLING / ZIP`)
  + speed in km/h. Update the WorldView status bar:
  `'SPACE hold = swing · W = dive · A/D = steer · SHIFT = zip/dash · 5 spawned you here'`.

---

## 9. Test checklist (manual, in the running app)

1. Press `5` in player mode → stickman drops in, camera tightens to ~14 m.
2. Hold SPACE while falling near CBD towers → web attaches to a **building
   face you can see**, line renders, you swing through and release forward.
3. Chain 5+ swings down a street without touching ground; A/D visibly bends
   each arc; alternating anchors zigzag left/right.
4. Dive (hold W) from 150 m, swing at the bottom → big fast low arc that
   **does not clip the road** (clearance assist working).
5. Over the bay: SPACE finds nothing (no buildings) → SHIFT dash once →
   still falls in water → lands/runs (no crash, no NaN).
6. Release at arc bottom vs. arc top → clearly different trajectories.
7. FOV visibly widens at speed; camera leads the motion.
8. Switch back to tank with `1` → everything normal, no stuck keys, bombs
   and jet unaffected. TAB to strategist and back works.
9. Typing in the Intel Import form does NOT move/jump the spider (isTyping
   guard already covers it — just verify).

## 10. Out of scope for v1 (explicitly)

- Character animation (Blender MCP later — body group is built so a GLB can
  replace it: same `lib.instance('spider', buildSpiderPrimitive)` pattern as
  the other vehicles, add a `spider` entry to MODEL_CATALOG when ready).
- Wall-running / wall-crawling (tile normals too messy).
- Tricks system, point-launch, web-wings gliding (SM2 has them; v2 candidates
  — gliding is just AIR with lift while a key is held, easy add later).
- Sound.
