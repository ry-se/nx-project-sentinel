# Spec — Strategist Tools

Authority on strategist-mode reconnaissance/analysis tools and the orbit/pan camera.
Sources: `engine/strategist.ts`, `engine/planFeature.ts`, `engine/viewshed.ts`,
`constants/engine.ts` (`VIEWSHED`).

## Controller & camera

`StrategistController(camera, canvas, tiles.group, scene, viewshed, geoFrame)`
(`strategist.ts:89`). On `enable(center)` it positions an orbit camera above the
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

| Tool         | Interaction                                         | Output                                                              | Finalizer (strategist.ts) | Builder (planFeature.ts)    |
| ------------ | --------------------------------------------------- | ------------------------------------------------------------------- | ------------------------- | --------------------------- |
| **select**   | drag/orbit/zoom only                                | (camera nav)                                                        | —                         | —                           |
| **distance** | click waypoints, right-click finish                 | cyan polyline + length label (m/km)                                 | `finalizeDistance` `:432` | `buildDistanceGroup` `:140` |
| **focus**    | click 3+ corners, right-click close → `prompt` name | extruded translucent AO volume + edges + area label (m²/ha/km²)     | `finalizeFocus` `:442`    | `buildFocusGroup` `:151`    |
| **arc**      | click ① weapon ② max-range ③ end bearing            | red sector (radius = ①→②, swept ①→③) + radius label                 | `finalizeArc` `:453`      | `buildArcGroup` `:195`      |
| **los**      | click observer, click target                        | green/red split line at the blocking building + CLEAR/BLOCKED label | `finalizeLos` `:464`      | `buildLosGroup` `:238`      |
| **viewshed** | click observer, sweep to aim, click to lock         | green/red shaded city (delegates to `ViewshedController`)           | `:252-261`                | —                           |

Each finalizer (distance/focus/arc/los) now does three things: build the visual `Group`
via the matching pure builder in `planFeature.ts` (data-in, `Group`-out — no drafting
state, so the same builder reconstructs an identical group from a saved `PlanFeature`);
`serializeFeature(...)` the draft points + a name into a `PlanFeature`
(`planFeature.ts:303`); and hand both to `addFeature` (`strategist.ts:417`), which stores
them and fires `onFeaturesChanged`. Auto-generated names are `<Type> <n>` (e.g.
`Distance 2`) counted per-type via `countOfType`; `focus` keeps its pre-existing
`window.prompt` name entry.

Measurement helpers: `pathLength`, `shoelaceXZ` (area), `fmtDist`, `fmtArea`, `marker`,
`label` (`planFeature.ts:59-124`). LOS uses eye height 2 m and casts to `dist − 2 m` so
the target marker itself isn't counted as a blocker; `buildLosGroup` returns
`{ group, blocked, distanceM, blockedAtM? }` (`planFeature.ts:228`) so the finalizer can
report the same "CLEAR"/"BLOCKED at Xm of Ym" status the raw group's own label shows.

## Plan features (`planFeature.ts`) — the serializable model

Every strategist feature (today: the 4 measurement tools above; later waves: control
measures, unit symbols, viewpoints) is represented as a `PlanFeature`
(`planFeature.ts:39`): `{ id, type, name, points: { local: LocalPoint[], geo:
GeoPosition[] }, style?, metadata }`. `local` is a JSON-safe `{x,y,z}` stand-in for a
`Vector3`; `geo` is captured via `geoFrame.localToGeo` **at draw time** (not
recomputed on load, since the tiles frame may shift) — one lat/lon per local point, in
the same order.

- `serializeFeature(type, localPoints, name, geoFrame, metadata?, id?)` (`:303`) builds a
  `PlanFeature` from a drafted point set.
- `rebuildFeature(pf, { raycaster, tiles })` (`:334`) is the inverse: reconstructs the
  `Group` a `PlanFeature` describes by dispatching to the matching pure builder above
  (the `raycaster`/`tiles` context is needed only for `los`, which re-raycasts to
  determine blocked/clear on rebuild). This is the seam persistence/export/phasing read
  in later waves — nothing renders directly from anywhere else.

Features are stored in `features: Feature[]` (`{ id, planFeature, group }`) and rendered
under `featureRoot` on overlay **layer 1** (excluded from the viewshed depth pass),
`renderOrder` 999–1001. `featureCount` drives the strategist HUD. `clearAll()` removes
all features + clears the selection highlight + disables the viewshed.

### Feature list API (`strategist.ts`)

`listFeatures()` (`:155`) returns `{ id, name, type }` rows for a UI panel.
`removeFeature(id)` (`:163`) and `undoLast()` (`:180`, LIFO — removes the most-recently
added feature) both drop the in-scene group and clear the selection if the removed
feature was selected. `renameFeature(id, name)` (`:172`) updates the stored
`PlanFeature.name` (read by `listFeatures()`; does not regenerate the 3D label sprite —
only `focus` currently renders its name in-scene). `selectFeature(id | null)` (`:193`)
highlights a feature with a small marker at its first point on a dedicated
`selectionRoot` layer; `selectedFeatureId` (`:188`) reads the current selection. Every
mutating call (`addFeature`, `removeFeature`, `renameFeature`, `undoLast`, `clearAll`)
fires the public `onFeaturesChanged` callback (`:62`) so a host UI can re-read
`listFeatures()`.

`WorldView.tsx`'s strategist toolbar renders a feature-list panel (next to the tools
panel) wired to this API: click a row to select/highlight, an inline rename (✎), a
delete button (🗑) per row, and an "Undo" button for the whole list. The panel refreshes
on `onFeaturesChanged` AND on entering strategist mode (so a session that already has
features when the panel first mounts isn't shown stale).

## Control measures (`planFeature.ts`, `strategist.ts`)

Five more `PlanFeatureType`s beyond the 4 measurement tools, each a distinct type (not
lumped) so phasing/export can treat them individually. Drafting reuses the existing
click-to-place / right-click-to-finish polyline pattern (boundary/phaseline/loa/axis) or
a single click (objective) — no parallel input system.

| Tool          | Points   | Style                                                                                                            | Builder (`planFeature.ts`) |
| ------------- | -------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------- |
| **boundary**  | polyline | white solid line                                                                                                 | `buildLinearMeasureGroup`  |
| **phaseline** | polyline | yellow dashed line                                                                                               | `buildLinearMeasureGroup`  |
| **loa**       | polyline | orange dashed line ("limit of advance")                                                                          | `buildLinearMeasureGroup`  |
| **axis**      | polyline | centerline + arrowhead at the last point + translucent width corridor (one flat quad per segment, half-width 8m) | `buildAxisGroup`           |
| **objective** | 1 click  | a marker + bold "OBJ \<name\>" label (point only — an area variant is a later-wave refinement)                   | `buildObjectiveGroup`      |

`boundary`/`phaseline`/`loa` share one builder keyed by `LinearMeasureType`, distinguished
by `LINEAR_MEASURE_STYLE` (color + dashed flag). The axis corridor band and arrowhead are
built from explicit world-space triangles (`buildBandSegment`/`buildArrowhead`) rather
than rotated `PlaneGeometry`, avoiding rotation-order math for an arbitrary XZ heading.
Each finalizer (`strategist.ts`) prompts for a name via `window.prompt` (same UX as
`focus`), defaulting to `<PREFIX>-<n>` counted per-type via `countOfType`.

## Unit symbols (`unitSymbol.ts`, `strategist.ts`)

A `symbol` `StratTool` drops a `PlanFeature type:'unit'` at a single picked point
(reuses `pick()` — invariant 4, sits on the terrain surface). Affiliation
(`friendly`/`enemy`/`neutral`) and echelon (`team`→`brigade`) are chosen via a small
selector in the strategist toolbar (`WorldView.tsx`, defaults friendly/platoon) —
**not** per-placement — and applied to `StrategistController.unitAffiliation`/
`unitEchelon` (public mutable fields, same pattern as `.tool`); the `Sandbox` interface
exposes `setUnitAffiliation`/`setUnitEchelon` (`createSandbox.ts`).

`buildUnitSymbolGroup` (`unitSymbol.ts`) renders a billboarded canvas sprite: a frame in
`AFFILIATION_COLOR[affiliation]` (fixed mapping — friendly=blue `0x2979ff`, enemy=red
`0xe53935`, neutral=green `0x43a047`, invariant 1), echelon "ticks" (dots, count =
`echelonTickCount(echelon)`, 1 for team through 7 for brigade — a simplified subset per
D-Army-3(b), not full APP-6), and a short unit-designator label (e.g. "2 PL", prompted
via `window.prompt`, defaulting to `<n> <ECHELON_ABBR>`). Sprite `renderOrder` is 1000
(invariant 3 — above ground features).

`serializeFeature('unit', [point], name, geoFrame, { affiliation, echelon })` stores both
in `PlanFeature.metadata` (invariant 2); `rebuildFeature` reads them back via
`readUnitMetadata`, which falls back to `friendly`/`platoon` on missing or malformed
metadata (defensive — `metadata` is an open `Record<string, unknown>`, not a typed
contract). Selection/rename/delete/undo work automatically via the existing todo-12
feature-list API — a unit symbol is just another `Feature`.

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
- Every feature MUST round-trip through `PlanFeature`: `rebuildFeature(serializeFeature(...))`
  renders an equivalent group (same points, same label text) for all 4 current types.
  Persistence (later wave), export (later wave), and phasing (later wave) all read this one
  representation — a tool that renders directly without producing a `PlanFeature` is the
  bug that breaks save/export/phase silently.
- `PlanFeature.points.geo` is captured at draw time (`geoFrame.localToGeo`), never
  recomputed on load.
