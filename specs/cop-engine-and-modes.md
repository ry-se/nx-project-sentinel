# Spec — COP Engine & Modes

Authority on the core engine: the `createSandbox` orchestrator, the two operating
modes, the render loop, cameras, input dispatch, the React UI surface, and lifecycle.
Source: `apps/frontend/src/features/sandbox/engine/createSandbox.ts`,
`apps/frontend/src/features/sandbox/WorldView.tsx`.

## Construction

`createSandbox(canvas, apiKey, anchor, callbacks): Sandbox`
(`createSandbox.ts:153`) builds and owns the entire simulation. It returns a `Sandbox`
imperative handle (`createSandbox.ts:93-109`) with:
`setMode`, `setTool`, `clearAll`, `switchVehicle`, `setLabelsVisible`, `getCameraPose`,
`captureShot`, `deployFromImage`, `clearDetections`, `dispose`.

Scene baseline: `WebGLRenderer` (antialias, `pixelRatio ≤ 2`), background `0x9fc4e0`,
`Fog(0x9fc4e0, 12000, 45000)`, `PerspectiveCamera(60°, aspect, 1, 50000)` with overlay
layer 1 enabled, an ambient + directional sun light (`createSandbox.ts:159-181`).

## Modes

Type `SandboxMode = 'player' | 'strategist'` (`createSandbox.ts:48`). Default is
`player` (`createSandbox.ts:266`, emitted via `cb.onMode('player')` at `:506`). **TAB**
toggles modes (`createSandbox.ts:320-324`); typing in an `input`/`textarea`/`select`/
contenteditable suppresses the hotkey (`isTyping`, `createSandbox.ts:128-133`).

- **Player**: a follow camera chases the active vehicle; per-frame vehicle update,
  bomb drain, camera update, HUD = `vehicles.hudText()`.
- **Strategist**: `strategist.enable(playerPos)` takes over the camera; HUD = feature
  count; vehicle updates are skipped.

Mode switch: `setMode` enables/disables the strategist and notifies `onMode`
(`createSandbox.ts:279-287`).

## Render loop

`renderer.setAnimationLoop` with `dt = min(clock.getDelta(), 0.1)`
(`createSandbox.ts:474-504`). Per frame, in order:

1. (player only) `vehicles.setCameraYaw(smoothCamYaw)` → `vehicles.update(dt, tiles.group)`
   → drain queued bombs into `bombs.drop` → `cameraShake += bombs.update(...)` →
   `updateCamera(dt)`.
2. `projectiles.update(dt)`.
3. Recenter `playerRegion.sphere.center` on the active vehicle, converted world→tiles-
   group-local, then `tiles.update()` (`createSandbox.ts:488-494`).
4. `viewshed.update(renderer)` → `labels.update(camera)` → `renderer.render(scene, camera)`.
5. `cb.onHud(...)` with vehicle HUD text (player) or `Features: <n>` (strategist).

## Cameras

- **Player follow camera** (`updateCamera`, `createSandbox.ts:366-457`): orbit yaw/pitch/
  distance, mouse-drag orbit, scroll zoom (12–400 m). Spider gets special handling
  (smoothed azimuth, wall-run framing, FOV widening + camera lead at speed); other
  vehicles use a direct chase cam (explicitly "zero regression").
- **Strategist camera**: owned by `StrategistController` (orbit/pan/zoom) — see
  `strategist-tools.md`.

## Input dispatch

One set of listeners registered in `createSandbox` (`createSandbox.ts:348-353`):
`pointerdown/up/move` (orbit drag, player only), `wheel` (zoom, player only), `keydown`
(TAB mode toggle; number keys `1/2/3/5` → vehicle), `resize`. A **second** key listener
lives in `VehicleManager` for held-key driving state (`vehicles.ts:290-295`). Both
guard against typing in form fields.

## UI surface (`WorldView.tsx`)

React renders all in-world chrome over the canvas, gated on `apiKey && !fatal`:
mode badge, strategist toolbar (6 tools + Labels + Clear All), player vehicle switcher
(tank/car/jet — **not** spider), status bar (per-vehicle control hints), HUD (right),
camera-pose readout + Capture/Copy-pose/Import-intel/clear buttons, attribution line
(Google ToS), loading overlay, fatal-error modal, and the API-key prompt.

The top `NavBar` (`layouts/NavBar.tsx`) renders a logo, a static breadcrumb
(`Op Raven · COA-B · Sandbox 03`), a functional **spawn `<select>`**, and presentational
buttons (`Detections 6`, `Wargame`, `Terrain`, `Replay`, `Export`) that are **rendered
but not wired to any handler** today.

## Lifecycle

`dispose()` (`createSandbox.ts:656-667`) stops the animation loop, clears the attribution
timer, removes every listener, and disposes the tiles + renderer. `WorldView`'s effect
cleanup calls it, so re-keying on `(apiKey, spawnLocation)` tears down the old WebGL
context before building a new one.

## Invariants (do not regress)

- The engine MUST NOT write React state per frame; engine→UI communication is via the
  `SandboxCallbacks` string/text callbacks only.
- Exactly one `Sandbox` exists per `(apiKey, spawnLocation)`; `dispose()` runs before a
  rebuild.
- `dt` is clamped to ≤0.1 s so a tab-stall does not produce a physics explosion.
- Number-key vehicle switching and TAB are suppressed while the user types in a field.
