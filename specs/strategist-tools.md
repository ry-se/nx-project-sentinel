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

## MGRS readout (`mgrs.ts`)

`toMgrs(geo, accuracy?)` (`mgrs.ts`) wraps the `mgrs` npm package's `forward([lon, lat],
accuracy)` — no hand-rolled ellipsoidal grid math (invariant 1). Two consumers, both
reading the SAME `geoFrame.localToGeo` output (invariant 2 — one geo source):

- **HUD cursor readout**: `StrategistController` tracks `cursorGround` on every throttled
  pointer move (not just while drafting), so `getCursorMgrs()` reflects wherever the mouse
  currently points, toggleable via `mgrsHudEnabled` (`WorldView.tsx`'s "MGRS HUD" toggle,
  default on). `createSandbox.ts`'s per-frame `cb.onHud(...)` appends `MGRS <ref>` under
  `Features: <n>` when enabled and the cursor is over tile geometry.
- **Per-feature grid ref**: `listFeatures()` (todo 12) computes an MGRS ref for
  single-point feature types (`objective`, `unit`) from `PlanFeature.points.geo[0]`,
  surfaced as a subtitle under the feature-list panel row. Multi-point features
  (measurements, control measures) don't carry a single representative point, so `mgrs` is
  `undefined` for those.

**Deferred (not in this pass):** the todo's "optional" ground-grid overlay (MGRS grid
lines drawn on a horizontal plane over the AO) needs a geo→local inverse `GeoFrame`
doesn't have today (only `localToGeo`); the todo's own scope marks this overlay
optional. No toggle for it exists yet — a future todo would add the inverse conversion
first.

## Bearings (`planFeature.ts`)

Every directional feature's label states a true GRID bearing (both degrees and mils) via
`computeBearingDeg(from, to, geoFrame)` (`planFeature.ts`) — the direction's `compassHeadingDeg`
against `geoFrame`'s own ENU axes, never a raw local-frame `atan2` (which isn't
north-aligned once the tiles group is anchor-recentered; invariant 1). `degToMils(deg)` is
`deg * 6400/360`, rounded (invariant 2). `formatBearing(deg)` renders e.g. `"095°G/1689
mils"` — the `G` marks GRID north explicitly, since a bearing is meaningless without its
reference (invariant 3).

Threaded into the labels of: `buildDistanceGroup` (bearing first→last point, appended
after the length: `"340 m · 095°G/1689 mils"`), `buildLosGroup` (bearing obs→tgt, appended
to the CLEAR/BLOCKED text), and `buildAxisGroup` (bearing first→last point, appended to
the `AXIS <name>` text). All three now take a `geoFrame: GeoFrame` param — `RebuildContext`
(the `rebuildFeature` seam) correspondingly carries `geoFrame` so a reloaded feature's
bearing label matches what was drawn (round-trip invariant, todo 11).

## Plan persistence (`planStore.ts`)

Browser `localStorage`-backed save/load of named plans (D-Army-4(a) — async-share
training-lane scope; no backend session state needed today). The store ONLY ever handles
`PlanFeature[]` data (invariant 1) — it has no idea what a Three.js `Group` is, and no
per-type knowledge of what any `PlanFeature.type` renders as (invariant 2, mirrors
`rebuildFeature`'s own contract).

- `Plan`: `{ id, name, version, anchor, createdAt, updatedAt, features: PlanFeature[] }`.
  `version` is `PLAN_SCHEMA_VERSION` (currently `1`) — `loadPlan` throws
  `UnknownPlanSchemaVersionError` on a mismatch rather than silently misreading an
  incompatible format (invariant 3).
- `savePlan(name, features, anchor, now)` — saving under a name that already exists
  UPDATES that plan (same `id`, `createdAt` preserved, `updatedAt` bumped to `now`) rather
  than creating a duplicate (invariant 4, matched by finding the existing entry with that
  `name` across every stored plan).
- `loadPlan(id)`, `listPlans()` (most-recently-updated first), `deletePlan(id)`.
- Every function takes `now` as an explicit string argument rather than reading
  `Date.now()`/`new Date()` internally — the store stays deterministically testable
  (invariant 5); jsdom's real (in-memory) `localStorage` is enough for tests, no custom
  shim needed.

**Out of this todo's scope** (the wire todo lands it): the save/load/delete UI, the plan
picker, and pulling the LIVE feature set out of a running `StrategistController` (today
`listFeatures()` returns only `FeatureSummary` rows for the panel — a future controller
method exposing the full `PlanFeature[]` is the wire todo's job).

### Persistence wiring (`strategist.ts`, `createSandbox.ts`, `WorldView.tsx`)

`StrategistController.exportFeatures()` returns the full `PlanFeature[]` (not the
`FeatureSummary` rows `listFeatures()` returns); `loadPlan(features)` clears the current
scene and rebuilds every one via the todo-11 `rebuildFeature` seam, then registers each
through the SAME `addFeature` path a live draft uses (invariant 3 — zero mock/placeholder
data in the load path; a loaded feature is indistinguishable from a freshly-drawn one).

`Sandbox.savePlan(name)` (`createSandbox.ts`) reads `strategist.exportFeatures()`, stamps
`now` via `new Date().toISOString()` AT THIS UI/orchestration layer (never inside
`planStore.ts` itself — todo 17 invariant 5), and calls `planStore.savePlan`.
`Sandbox.loadPlan(id)` reads `planStore.loadPlan(id)` and hands the features to
`strategist.loadPlan`. `listPlans`/`deletePlan` proxy directly to the store.

`WorldView.tsx`'s strategist toolbar renders a "Plans" panel (a name field + Save, and a
list of saved plans with Load/Delete) next to the feature-list and tools panels, refreshing
on a `planVersion` counter bumped after save/delete (same pattern as the feature list's
`featureVersion`).

**Wave-1 gate (todo 18, `rules/wave-loop.md`):** `strategist.persistence.test.ts` builds a
MIXED feature set (a measurement tool, a control measure, an axis of advance, and a unit
symbol) via real pointer-event drafting on one `StrategistController`, saves it through the
real `planStore` (jsdom's real `localStorage`), then loads it into a GENUINELY SEPARATE,
freshly-constructed `StrategistController` and asserts the rebuilt feature set matches
(types, names, and geo points byte-for-byte — invariant 2/todo-11-invariant-2). This is the
automated half of the Wave-1 gate's acceptance criterion. **The manual Flow-A walk in a
real browser is deferred to the user** — this session used the Chrome DevTools protocol
for the Wave-0 walk, but the user asked not to continue doing so for token-cost reasons,
so no walk receipt is recorded here for Wave 1; the user will exercise it themselves.

## Viewpoint bookmarks + brief sequence (`viewpoint.ts`, `strategist.ts`)

A **brief sequence** is an ordered list of `Viewpoint`s — `{ id, name, order, pose:
CameraPose }` (`viewpoint.ts`) — reusing the EXISTING lossless intel-import `CameraPose`
serialization (`createSandbox.ts::getCameraPose`, position+quaternion+geo) rather than a
lossy lat/lon-only summary (invariant 1), so a bookmark restores the exact view.

`StrategistController` owns the viewpoint list: `saveViewpoint(name, pose)` (appended
last-in-sequence), `listViewpoints()` (sorted by `order`, NOT insertion order),
`renameViewpoint`/`deleteViewpoint`, `reorderViewpoints(orderedIds)` (reassigns `order`
0..n-1 to match — deterministic, stable across save/load, invariant 4),
`restoreViewpoint(id)` (sets `camera.position` AND `camera.quaternion` via
`restoreViewpointPose` — invariant 3, not just position), `exportViewpoints()`/
`loadViewpoints()` (the persistence seam). Every mutating call fires the public
`onViewpointsChanged` callback (same pattern as `onFeaturesChanged`).

`Plan.viewpoints: Viewpoint[]` (`planStore.ts`) — persists/exports with the plan
(invariant 2): `savePlan`'s 5th param, populated in `createSandbox.ts` from
`strategist.exportViewpoints()`; `Sandbox.loadPlan(id)` calls BOTH
`strategist.loadPlan(plan.features)` and `strategist.loadViewpoints(plan.viewpoints)`.

`Sandbox.saveViewpoint(name)` captures the CURRENT view via the existing
`getCameraPose()` (no new capture logic — the lossless serialization already exists) and
hands it to `strategist.saveViewpoint`. `WorldView.tsx`'s "Brief sequence" panel: a name
field + save button, an ordered list with jump-to-view (click), ↑/↓ reorder buttons, and
delete — refreshing on `onViewpointsChanged` via a `viewpointVersion` counter (same
pattern as the feature list's `featureVersion`).

## Brief playback (`briefPlayback.ts`, `strategist.ts`)

Next/previous/go-to-index controls fly the camera smoothly between saved viewpoints
(todo 19), in `order` (invariant 1), instead of snapping.

`interpolatePose(from, to, t)` (`briefPlayback.ts`) lerps position and SLERPS the
quaternion (invariant 2 — never lerp+renormalize euler angles, which introduces
gimbal/roll artifacts); `t` is clamped to `[0, 1]` so `t=0`/`t=1` are exactly the
endpoints. `from` is always the LIVE camera's current transient position+quaternion
(never a saved pose — there's nothing to fake here); `to` is a target viewpoint's full
`CameraPose`. `BRIEF_TRANSITION_DURATION_MS` (1500ms) is a named constant, not a magic
literal at the call site (invariant 4).

`BriefPlaybackStepper` (`briefPlayback.ts`) owns the transition state (current index,
transition-start time, playing flag) and exposes `next`/`previous`/`goTo`/`cancel`/`tick`
— every method takes `nowMs` explicitly (never reads `performance.now()` internally), so
it's deterministically testable. `StrategistController` owns ONE stepper instance
(`briefStepper`), wired to `listViewpoints()`; `update(nowMs)` — called every frame from
`createSandbox.ts`'s render loop while in strategist mode — applies `tick()`'s
interpolated pose directly to the camera.

Manual camera input (`onDown`, `onWheel`) calls `cancelBriefPlayback()` FIRST, before any
other handling — playback stops cleanly wherever the camera was, never left
half-interpolated (invariant 3). `WorldView.tsx` polls `getBriefPlaybackState()` every
200ms (the interpolation itself runs in the render loop, not React state, so a step
indicator needs to poll — same pattern as the existing camera-pose HUD readout) to show
"`<n> / <total>`" + a play indicator, with prev/next buttons in the brief-sequence panel.

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
