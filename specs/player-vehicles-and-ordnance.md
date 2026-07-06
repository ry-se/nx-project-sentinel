# Spec — Player Vehicles & Ordnance

Authority on player-mode units, their control models, weapons, and bombs.
Sources: `engine/vehicleBase.ts`, `engine/vehicles.ts`, `engine/projectiles.ts`,
`engine/bombs.ts`, `engine/modelCatalog.ts`, `constants/engine.ts`.

## Vehicle base (`vehicleBase.ts`)

`abstract class Vehicle` (`vehicleBase.ts:31`) owns: a Three.js `Group` (`object`), the
shared key set, `_speed`/`_heading`, a `bombDrops` queue, a `raycaster` (firstHitOnly),
and abstract `label` + `cameraDist`. Key methods:

- `update(dt, terrain)` — abstract per-vehicle step.
- `fireRay() → { origin, direction, speed } | null` — muzzle spec; `null` = unarmed
  (`vehicleBase.ts:51-53`).
- `sampleGround(x, z, terrain, fromHeight, vehicleFloorY?)` — downward raycast; when
  `vehicleFloorY` is given, hits above `floor + 3 m` are skipped so bridges/overpasses
  don't block ground vehicles (`vehicleBase.ts:59-75`).
- `state → VehicleState` — `{ label, speed, heading, altitude, afterburner?, rolling?,
mode?, fovBoost?, wallNormal? }` (`vehicleBase.ts:7-24`).

`VehicleType = 'tank' | 'car' | 'jet' | 'spider'`. `DOWN = (0,-1,0)`.

## Concrete vehicles (`vehicles.ts`)

| Vehicle | Label       | `cameraDist` | Armed        | Top speed              | Notes                           |
| ------- | ----------- | -----------: | ------------ | ---------------------- | ------------------------------- |
| Tank    | `M1 TANK`   |           45 | yes (0.9 s)  | 18 m/s                 | `groundDrive`; muzzle speed 130 |
| Car     | `GT SPORTS` |           22 | no           | 70 m/s                 | speed-sensitive steering        |
| Jet     | `F-16 JET`  |           90 | yes (0.28 s) | ~580 m/s (afterburner) | full flight model               |
| Spider  | `SPIDER`    |            — | no           | —                      | see `spiderman-mode.md`         |

- **`groundDrive`** (`vehicles.ts:215-264`) — shared ground physics: accel/brake/damping,
  speed-signed steering, terrain follow via `sampleGround`, climb refusal beyond
  `maxClimb` when grounded.
- **Jet** (`vehicles.ts:74-198`) — throttle (35→170 cruise), afterburner accel 280 to
  `AFTERBURNER_MAX 580`, yaw+bank, pitch (±0.9), barrel roll (`ROLL_SPEED`, full roll in
  1.1 s), terrain-avoidance floor (≥10 m), bomb drop (B, 1.2 s cooldown). HUD adds
  altitude, afterburner, rolling flags.

## `VehicleManager` (`vehicles.ts:268-373`)

Owns the active vehicle, the window key listeners, fire-rate gating, and HUD text.

- `switchTo(type)` copies position across; jet +60 m takeoff, spider +10 m drop-in
  (`vehicles.ts:325-340`).
- `update(dt, terrain)` steps the active vehicle and, if SPACE held and `fireCooldown
  > 0`, fires a projectile at the vehicle's `fireRay()` (`vehicles.ts:347-360`).
- `drainBombs()` returns+clears queued bombs each frame.
- `hudText()` composes label / km/h / heading (+ alt / afterburner / roll / spider mode).

## Projectiles (`projectiles.ts`)

`ProjectileManager.fire(origin, dir, speed)` spawns a shell that integrates under
`GRAVITY -25`, segment-raycasts the terrain each frame, and on hit calls `explode(point,
normal)` → flash + 14 fireball + 16 smoke particles + a persistent **scorch decal**
(capped at `MAX_SCORCH 25`, FIFO) (`projectiles.ts:50-148`). Shells expire after
`MAX_LIFE 8 s`. All particle meshes live on overlay layer 1.

## Bombs (`bombs.ts`)

`BombManager.drop(BombDrop)` spawns a falling bomb integrated under `BOMB.GRAVITY -28`;
on terrain hit it:

1. **Deforms the tile mesh** (`deformTiles`, `bombs.ts:38-122`): vertices within
   `BOMB.DAMAGE_R 85 m` are displaced — inner `BOMB.CRATER_R 28 m` pushed **down**
   (`CRATER_D 22`), the ring pushed **out + up** (`DAMAGE_RISE 15`). Handles
   interleaved buffer attributes by converting to a plain `BufferAttribute`. Recomputes
   normals/bounds.
2. Spawns a full **explosion VFX** state machine (`bombs.ts:179-375`): flash (0.4 s),
   fireball (2.5 s), smoke column (6 s), shockwave ring (2.2 s), 8 secondary fires, 40
   debris chunks (gravity + spin + fade), persistent crater disc.
3. Returns camera-shake magnitude (2.5) to the orchestrator.

Tunables live in `constants/engine.ts` (`BOMB`). Deformation persists until the tile is
unloaded — flying away and back streams fresh (undeformed) tiles ("free repairs",
intended, `bombs.ts:31-37`).

## Model catalog (`modelCatalog.ts`)

`MODEL_CATALOG` maps `tank`/`car`/`jet` → GLB + `targetLength` (+ optional `rotationY`).
`ModelLibrary.instance(id, fallbackPrimitive, tintHex?)` returns a group **immediately**
containing the primitive fallback, then swaps in the loaded+normalised GLB when ready;
a missing/failed GLB keeps the primitive (`modelCatalog.ts:58-75`). `normalise` faces
+Z, sets bottom at y=0, centers XZ, scales to `targetLength`. Hostile detections reuse
the same catalog with a red `tint`.

## Invariants (do not regress)

- A missing/failed GLB MUST fall back to the primitive — assets can never break the app.
- `vehicleBase.ts` MUST stay a separate module (breaks the `vehicles ↔ spiderman` import
  cycle; `import/no-cycle` is an ESLint error).
- Ground vehicles MUST skip overhead structures via the `vehicleFloorY` ceiling so
  bridges don't trap them.
- Unarmed vehicles (`fireRay()` returns `null`) MUST NOT fire.
