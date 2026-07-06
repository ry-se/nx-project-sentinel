# Spec — Spider-Man Movement Mode

Authority on the hidden web-swinging movement mode (player key `5`).
Source: `engine/spiderman.ts` (1218 LOC), `engine/vehicleBase.ts` (`VehicleState`).
This mode is implemented and reachable today; it is intentionally **not** surfaced in
the player UI switcher.

## State machine

`type SpiderState = 'ground' | 'air' | 'swing' | 'zip' | 'pull' | 'wall'`
(`spiderman.ts:132`). `SpiderVehicle extends Vehicle` (`spiderman.ts:143`), label
`SPIDER`. The active state is reported to the camera/HUD via `VehicleState.mode`,
`fovBoost`, and `wallNormal` (`vehicleBase.ts:14-23`).

| State    | Meaning                                                            |
| -------- | ------------------------------------------------------------------ |
| `ground` | On a surface — jog/sprint locomotion (camera-relative)             |
| `air`    | Airborne, no web — A/D rotate flight direction; asymmetric gravity |
| `swing`  | Attached web pendulum — rope constraint reels toward ideal length  |
| `zip`    | Web-zip travel to the highest rooftop in an elevation fan          |
| `pull`   | Straight-line web-yank to a surface (gravity suppressed)           |
| `wall`   | Wall-run — climb / traverse / jump off                             |

## Controls (from `docs/PROJECT.md`, matching the constants below)

| Input                  | Action                                                              |
| ---------------------- | ------------------------------------------------------------------- |
| SHIFT+W                | Sprint (`RUN_SPEED 20` m/s)                                         |
| W alone                | Jog (`JOG_SPEED 8` m/s)                                             |
| SPACE (ground)         | Jump (`JUMP_V 18` + per-speed bonus)                                |
| SPACE (air)            | Attach web → swing                                                  |
| SPACE (mid-zip)        | Zip-cancel, keep velocity → air                                     |
| W (swing, descending)  | Dive (`SWING_DIVE`) — steepens the arc                              |
| A/D                    | Rotate velocity (air `AIR_TURN 2.1`, swing `SWING_TURN 1.3` rad/s)  |
| SHIFT (air/swing)      | Zip to the highest rooftop in the fan                               |
| E                      | Web-pull (`PULL_CHARGES 2`, `PULL_RANGE 85` m)                      |
| F                      | Web-fling (wall = slingshot over rooftop; air = boost along travel) |
| Swing INTO wall        | Enter wall-run                                                      |
| W / A·D / SPACE (wall) | Climb / traverse / jump off                                         |

## Physics model (constants at `spiderman.ts:26-122`)

- **Asymmetric gravity** (no apex hang): `G_RISE -38`, `G_FALL -56`, `G_SWING -48`.
- **Speeds**: `RUN 20`, `JOG 8`, `ZIP_SPEED 58`, `PULL_SPEED 52`, `MAX_SWING 74`
  (~265 km/h), `MAX_FALL 88`.
- **Air drag**: quadratic `F ∝ v²` (`DRAG_K 0.0016`) — a natural speed cap, not a hard
  clamp. Drag is reduced up to 60% at full momentum (`DRAG_MIN_MULT 0.4`).
- **Rope constraint**: radial-velocity kill each frame, reel toward `ROPE_IDEAL 38 m`
  at `REEL_RATE 18 m/s`; anchors must be ≥`ANCHOR_MIN_UP 4 m` above, preferred
  `ANCHOR_SWEET 40 m`, max `ANCHOR_RANGE 95 m`. Swing arc must clear ground by
  `GROUND_CLEAR 4 m`.
- **Zip**: picks the **highest** hit in the elevation fan (not the first hit = not the
  wall base); `ZIP_RANGE 130 m`, `ZIP_TIMEOUT 1.5 s`.
- **Web-pull** (`pull` state): gravity suppressed for `PULL_DURATION 0.35 s`, constant
  `PULL_SPEED 52` travel — an interval, not an impulse; 2 charges recharged by landing/
  attaching, `PULL_COOLDOWN 0.30 s`.
- **Wall-run**: cling if a wall is within `WALL_RANGE 3.5 m` and speed ≥`WALL_MIN_SPEED
6`; `WALL_CLIMB 36`, `WALL_TRAVERSE 24`, cap `WALL_MAX 42`, auto-detach after
  `WALL_GIVEUP 12 s` idle; jump-off `WALL_JUMP_OUT 16` + `WALL_JUMP_UP 14`. Wall normal
  is horizontalized (player−hit), robust to noisy photogrammetry normals.
- **Web-fling**: wall fling = `FLING_UP 22` / over-top `FLING_FWD 30`; air fling =
  `FLING_BOOST 28` along travel; `FLING_DRAIN 0.5` momentum per fling; "over the top"
  if the wall top is within `FLING_TOP_REACH 9 m`.

## Momentum meter

A 0–1 meter (`spiderman.ts:83-86`) built by fast swing releases (`MOM_PER_SWING 0.30`),
wall climbs (`MOM_PER_CLIMB 0.25/s`), and zip ends (`MOM_PER_ZIP 0.12`); passive decay
`MOM_DECAY 0.10/s`. It reduces air drag (aero meter) and scales fling boost, and is
shown in the HUD.

## Camera coupling

The orchestrator feeds the spider last frame's smoothed camera azimuth
(`setCameraYaw`) so ground locomotion is camera-relative; the follow camera widens FOV

- tightens follow + leads at speed via `fovBoost`, and frames the wall face from
  `wallNormal` during wall-run (`createSandbox.ts:366-457`, `vehicles.ts:307-311`).

## Not implemented (recorded here only to bound the spec)

The spider renders as a **procedural stickman** — there is no GLB or skeletal animation.
A model can drop in via `MODEL_CATALOG['spider']` but none is registered today
(`MODEL_CATALOG` has only `tank`/`car`/`jet`, `modelCatalog.ts:22-26`).

## Invariants (do not regress)

- Gravity is asymmetric by design (`G_FALL` < `G_RISE`) — "he DROPS, no hang".
- Zip targets the **highest** elevation-fan hit, never the first.
- Web-pull is a timed constant-velocity interval, not an impulse.
- Wall normals are horizontalized to survive noisy photogrammetry geometry.
