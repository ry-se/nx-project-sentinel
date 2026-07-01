# Spec — Strategist Tools

Authority on strategist-mode reconnaissance/analysis tools and the orbit/pan camera.
Sources: `engine/strategist.ts`, `engine/viewshed.ts`, `constants/engine.ts` (`VIEWSHED`).

## Controller & camera

`StrategistController(camera, canvas, tiles.group, scene, viewshed)`
(`strategist.ts:33`). On `enable(center)` it positions an orbit camera above the
player's last position. Camera controls (`strategist.ts:185-230`):

- **left-drag** pan on a horizontal plane at the picked surface height,
- **right-drag** orbit the pivot (clamped polar 0.15–1.45 rad),
- **scroll** zoom toward the cursor (floor 25 m above pivot).

Right-click is `preventDefault`-ed while enabled; **Escape** cancels the in-progress
draft.

## Tools

`StratTool = 'select' | 'distance' | 'focus' | 'arc' | 'los' | 'viewshed'`
(`strategist.ts:10`). Per-tool hints in `TOOL_HINTS` (`strategist.ts:12-19`). Drafting
is left-click to place points, right-click to finish; a throttled hover preview raycasts
the tileset.

| Tool         | Interaction                                         | Output                                                              | Source     |
| ------------ | --------------------------------------------------- | ------------------------------------------------------------------- | ---------- |
| **select**   | drag/orbit/zoom only                                | (camera nav)                                                        | —          |
| **distance** | click waypoints, right-click finish                 | cyan polyline + length label (m/km)                                 | `:327-338` |
| **focus**    | click 3+ corners, right-click close → `prompt` name | extruded translucent AO volume + edges + area label (m²/ha/km²)     | `:340-378` |
| **arc**      | click ① weapon ② max-range ③ end bearing            | red sector (radius = ①→②, swept ①→③) + radius label                 | `:380-405` |
| **los**      | click observer, click target                        | green/red split line at the blocking building + CLEAR/BLOCKED label | `:407-452` |
| **viewshed** | click observer, sweep to aim, click to lock         | green/red shaded city (delegates to `ViewshedController`)           | `:252-261` |

Measurement helpers: `pathLength`, `shoelaceXZ` (area), `fmtDist`, `fmtArea`
(`strategist.ts:457-481`). LOS uses eye height 2 m and casts to `dist − 2 m` so the
target marker itself isn't counted as a blocker.

Features are stored in `features[]` and rendered under `featureRoot` on overlay
**layer 1** (so they're excluded from the viewshed depth pass), `renderOrder` 999–1001.
`featureCount` drives the strategist HUD. `clearAll()` removes all features + disables
the viewshed.

## Viewshed (`viewshed.ts`)

ArcGIS-style shadow-mapping repurposed for visibility:

1. `aim(observerGround, targetGround)` places a depth camera at the observer's eye
   (+`VIEWSHED.EYE_HEIGHT 2`), aims it at the target, sets `far = range`, and stores
   `projection × viewMatrix` in a uniform (`viewshed.ts:42-68`). A `CameraHelper`
   visualizes the wedge.
2. Every tile material (current + future via `load-model`) is patched with
   `onBeforeCompile` to add a fragment step: project the fragment into the depth map,
   compare `fragDepth` to the stored depth (bias 0.0015), and **tint green (visible) /
   red (hidden)**, mixed 40% (`viewshed.ts:110-164`).
3. `update(renderer)` re-renders the observer depth map each frame (tiles only, layer
   0; fog/background temporarily disabled) so the analysis stays correct as tiles
   refine (`viewshed.ts:82-106`).

Tunables (`constants/engine.ts` `VIEWSHED`): `DEPTH_RES 2048`, `H_FOV_DEG 100`,
`V_FOV_DEG 55`, `FAR_PLANE 1000`, `DEPTH_MIN 20`. Only one viewshed is active at a time;
`disable()` clears it.

## Invariants (do not regress)

- Strategist overlay features render on layer 1 and MUST stay out of the viewshed depth
  pass (which renders layer 0 only).
- The viewshed depth map MUST be re-rendered per frame while active (correctness as
  tiles stream).
- LOS far is `dist − 2 m` so the endpoint marker is never self-blocking.
