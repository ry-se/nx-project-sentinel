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

## Ground walk (`groundWalk.ts`, `strategist.ts`)

A `groundWalk` `StratTool` drops the camera to eye height at a clicked point and lets
mouse-look + WASD/arrow movement explore from there — confirming what a subordinate will
actually see on the ground, which the orbit-only camera can't give. No collision (walking
through buildings is acceptable for a briefing tool) and no full FPS controller — a
look-around confirm tool.

- `EYE_HEIGHT_STANDING_M` (1.7 m) — extends the LOS `EYE_HEIGHT` naming convention
  (`planFeature.ts`) into this distinct domain (invariant 4).
- `groundWalkEyeY(raycaster, tiles, x, z, eyeHeight?)` — raycasts straight down at `(x,
z)`, returns `surfaceY + eyeHeight` or `null` if nothing is hit. Called every frame
  during movement (not interpolated/assumed), so the walk height tracks the actual
  terrain as it rises and falls (invariant 1).
- `computeLookQuaternion(yaw, pitch)` — pitch clamped to ±89° (never flips past straight
  up/down) and Euler order `'YXZ'` (yaw about world Y, then pitch about the resulting
  local X) so there is never a roll component (invariant 3).
- `GroundWalkController` (`groundWalk.ts`) owns yaw/pitch/XZ position + which WASD/arrow
  keys are held. `enter()` saves the CURRENT camera (position+quaternion) ONLY on first
  entry — a second `enter()` while already active (clicking a new spot mid-walk)
  re-teleports without clobbering what `exit()` restores (invariant 2). `update(camera,
raycaster, tiles, dtSeconds)` moves along the camera's forward/right projected flat
  onto XZ (so pitch doesn't tilt movement into the ground/sky), then re-raycasts for the
  new eye height.

`StrategistController` owns one `GroundWalkController`. Entering (`place()`'s
`'groundWalk'` case) and the render-loop `update(nowMs)` (which now also drives
`groundWalkController.update` when active, alongside brief playback) are the only new
integration points. Manual pointer-drag becomes mouse-look (not pan/orbit) while active;
`onDown`/`onWheel` no longer apply camera-drag physics during a walk. Escape (or the
"Exit Ground Walk" button, `WorldView.tsx`) calls `exitGroundWalk()`, which restores the
saved camera and calls `setTool('select')` — the latter fires a new `onToolChanged`
callback so a host UI's tool-highlight state stays in sync even when the tool changed
from something OTHER than a direct `Sandbox.setTool` call (e.g. this Escape-triggered
exit).

## Classification + provenance (`classification.ts`, `strategist.ts`, `planStore.ts`)

A persistent classification banner and per-feature authorship record, so a briefing is
never shown without its handling caveat and every drawn feature carries who drew it and
when — training-lane scope (viability Gate 6 — no real classified data handling; real
accreditation/handling-caveat enforcement is an environment gate, not code).

- `ClassificationLevel` (`classification.ts:4`): `'EXERCISE' | 'UNCLASSIFIED' |
'RESTRICTED' | 'CONFIDENTIAL'`. `CLASSIFICATION_LEVELS` is the ordered config array
  driving both the `<select>` picker and any future validation (invariant 4 — never a
  hardcoded literal per call site). `DEFAULT_CLASSIFICATION` is `'EXERCISE'` — a fresh
  controller and a `Plan` saved without an explicit level both resolve to this, never a
  blank/undefined level (invariant 2).
- `CLASSIFICATION_COLOR` (`classification.ts:18`) maps each level to a distinct banner
  background color (blue/green/amber/red), legible against white banner text.
- `Provenance` (`classification.ts:27`): `{ author, createdAt, updatedAt }`. Captured
  ONCE, at draw time, via `StrategistController.provenanceMetadata()`
  (`strategist.ts:716-718`), which stamps `author` from `this.operatorName` (defaults to
  `'Operator'`, `strategist.ts:148`) and both timestamps from `new Date().toISOString()`
  at the SAME instant — `createdAt === updatedAt` on every freshly-drawn feature
  (invariant 3). Every finalizer (`finalizeDistance`, `finalizeFocus`, `finalizeArc`,
  `finalizeLos`, `finalizeLinearMeasure`, `finalizeAxis`, `finalizeObjective`,
  `finalizeSymbol`) passes `provenanceMetadata()` into `serializeFeature(...)`, so
  provenance is universal across every feature type, not opt-in per tool. Provenance is
  set-once: `renameFeature` (`strategist.ts:412-417`) replaces only `name`, never touches
  `metadata.provenance` — there is no edit-tracking beyond the original draw today.
- `StrategistController.currentClassification` (`strategist.ts:150`) holds the live
  session's level, defaulting to `DEFAULT_CLASSIFICATION`. `FeatureSummary.provenance`
  (`strategist.ts:114`, populated `strategist.ts:287`) surfaces each feature's
  provenance through `listFeatures()` for the feature-list panel's row tooltip.
- `Plan.classification` (`planStore.ts:20`) persists the session's level alongside
  `features`/`viewpoints`; `savePlan(..., classification = DEFAULT_CLASSIFICATION)`
  defaults it when the caller omits it (mirrors the `viewpoints = []` default pattern),
  so an old caller that doesn't pass a level still gets a well-defined EXERCISE plan
  rather than `undefined`.
- `Sandbox.setClassification`/`getClassification` (`createSandbox.ts:145-146`,
  wired `createSandbox.ts:814-817`) read/write `strategist.currentClassification`
  directly — no separate copy of the level exists between the controller and the
  Sandbox facade. `savePlan`/`loadPlan` (`createSandbox.ts:806,812`) thread the level
  through the same save/load round-trip as features and viewpoints.
- `WorldView.tsx` renders a persistent classification banner (`WorldView.tsx:381-397`) —
  fixed top AND bottom bars, always visible in strategist mode, colored via
  `CLASSIFICATION_COLOR` — plus a `<select>` picker (`WorldView.tsx:592-602`, bound to
  `CLASSIFICATION_LEVELS`) inside the Plans section of the strategist left rail (see
  "Sand-table wiring + Wave-2 gate" below for the rail layout). Selecting a level calls
  `selectClassification` (`WorldView.tsx:288-291`), which updates local state AND calls
  `sandbox.setClassification` so the two stay in sync; `loadPlan` similarly re-syncs
  local state from `sandbox.getClassification()` (`WorldView.tsx:285`) after a load.

## Export to GeoJSON / KML (`exportPlan.ts`)

Hand-off is the cheap answer to the multi-user gate (D-Army-4(a) async-share): a subordinate
opens the exported file elsewhere, no live session needed. `exportGeoJSON(plan) →
string` and `exportKML(plan) → string` both read ONLY `PlanFeature.points.geo` (lat/lon/altM
captured at draw time, `geoFrame.ts:4-8`) — no re-projection, no re-derivation from `.local`
(invariant 1).

- `GEOMETRY_TYPE` (`exportPlan.ts`) is the per-`PlanFeatureType` geometry mapping
  (invariant 4), derived from what each type's builder in `planFeature.ts` actually draws:
  `focus` is the one closed-area boundary tool today (`buildFocusGroup`, ≥3 points) → maps
  to `Polygon`. `objective` and `unit` are always single-point placements
  (`buildObjectiveGroup`/`buildUnitSymbolGroup`) → `Point` each — NOTE `objective`'s
  area variant does not exist yet (`planFeature.ts:416` documents it as "a later-wave
  refinement"), so `objective` is `Point`, not `Polygon`, contrary to an earlier
  assumption. Every other type (`distance`, `los`, `boundary`, `phaseline`, `loa`, `axis`)
  draws an open path → `LineString`. `arc`'s 3 points are center/radius/bearing CONTROL
  points, not a swept-wedge boundary — exported as the raw control-point path (`LineString`),
  honoring invariant 1 rather than re-deriving the actual wedge geometry.
- `geometryData(pf)` closes an unclosed `Polygon` ring by repeating the first coordinate at
  the end (RFC 7946 §3.1.6 / KML `LinearRing` both require a closed ring) — only for
  `Polygon`-mapped types; `LineString`/`Point` pass `points.geo` through untouched.
- `featureProperties(pf, classification)` — every exported feature carries `name`, `type`,
  and the PLAN's `classification` (todo 22, invariant 3), plus `provenance` when present
  (`pf.metadata.provenance`) and `affiliation`/`echelon` for `unit`-type features only.
- `exportGeoJSON` produces a `FeatureCollection` (RFC 7946 §3.3): one `Feature` per
  `PlanFeature`, `geometry.coordinates` in `[lon, lat, altM]` order (invariant 2 — GeoJSON's
  own coordinate order, not `[lat, lon]`).
- `exportKML` produces well-formed XML (invariant 2): one `Placemark` per `PlanFeature`,
  `<name>` from `pf.name`, an `<ExtendedData>` block flattening `featureProperties` into
  `<Data name="…"><value>…</value></Data>` pairs (`provenance` flattens to
  `provenance_author`/`provenance_createdAt`/`provenance_updatedAt` — KML `Data` values are
  flat strings, not nested objects), and the geometry element matching `GEOMETRY_TYPE`
  (`<Point>`/`<LineString>`/`<Polygon><outerBoundaryIs><LinearRing>…`). Every text value
  (`name`, `Data` name/value) is XML-escaped (`xmlEscape`) — a feature named with `<`/`&`/`"`
  cannot inject markup into the exported document.

The UI download buttons and the Wave-2 gate proof landed in todo 24 (below).

## Sand-table wiring + Wave-2 gate (`WorldView.tsx`, `createSandbox.ts`)

`Sandbox.exportPlanGeoJSON(name)`/`exportPlanKML(name)` (`createSandbox.ts`) build an
`ExportablePlan` from the LIVE controller state — `strategist.exportFeatures()` +
`strategist.currentClassification` — and call `exportGeoJSON`/`exportKML` directly; they do
NOT require a prior `savePlan()` call (invariant: the export always reflects what's on
screen, not a stale saved snapshot). `WorldView.tsx`'s Plans panel renders "Export GeoJSON"
and "Export KML" buttons, disabled when there are zero features, that call these methods
with the typed plan-name draft (falling back to `'Untitled Plan'` when blank) and hand the
returned string to `downloadBlob` (`createSandbox.ts`, exported — previously
`captureShot`-only) as a `.geojson`/`.kml` file.

`ExportablePlan` (`exportPlan.ts`) is deliberately narrower than the full `Plan`
(`planStore.ts`) — `{ name, features, classification }` only — precisely so the LIVE,
not-yet-saved session can export without fabricating a placeholder `id`/`anchor`/timestamps
just to satisfy a wider type; a saved `Plan` still satisfies it structurally.

**Wave-2 gate (todo 24, `WorldView.sandtable.test.tsx`):** two describe blocks. (1) A
real-engine, zero-mock end-to-end test — build a mixed feature set on a real
`StrategistController` (a Wave-0/1 `distance` measurement + a Wave-1 `unit` symbol), save
two viewpoints, `savePlan`/`loadPlan` through the real `planStore` into a GENUINELY SEPARATE
controller, drive brief playback to completion at each viewpoint (asserting the camera's
`position`/`quaternion` land exactly on the saved pose), enter and exit ground-walk on that
same loaded controller, then export and re-parse — asserting every feature + classification +
provenance survived intact, and that the Wave-0/1 `distance` type round-tripped unmodified
(no regression from the Wave-2 additions). (2) A lightweight React-level check (the same
`fakeSandbox` convention as `WorldView.featureList.test.tsx`) proving the export buttons are
disabled with no features, enabled once features exist, and call `exportPlanGeoJSON`/
`exportPlanKML` with the current plan-name draft.

**Manual walk receipt:** per `rules/user-flow-validation.md`, the automated Wave-2 gate test
above is necessary but not sufficient — the user exercises the real Flow-B chain (build →
brief → ground-walk → classification banner → export → open in a real GeoJSON/KML viewer)
themselves in a real browser session; per this session's standing instruction, browser
automation was not used for this verification, so no walk receipt is recorded here.

## Strategist UI design system (`styles.css`, `ui/PanelRail.tsx`, `ui/PanelSection.tsx`)

A dark "sentinel" daisyUI theme (`styles.css`) — one reserved cyan accent
(`--color-primary`/`secondary`/`accent`, mapped identically so no daisyUI component
defaults to a different brand color) drives every interactive/selected state; dark
blue-grey surfaces; sharper corners than daisyUI's stock defaults. Classification colors
(`classification.ts`'s `CLASSIFICATION_COLOR`) are NEVER drawn from these theme tokens —
they stay inline `style={{backgroundColor}}`, reserved for classification alone, so the
banner's meaning can never silently drift with a future theme change. `lucide-react` icons
replace every button emoji except the Tank vehicle icon (no clear lucide equivalent) and
unrelated Spider-Man-mode status text (out of this workstream's scope).

Every strategist/player-mode side panel is a child of ONE `PanelRail` per side
(`ui/PanelRail.tsx`) — a docked, scrollable glass surface whose real CSS flow resolves
position/height, replacing what used to be N independently `fixed`-positioned panels each
guessing a hardcoded left offset (the concrete bug this fixed: the Plans panel at
`left-[28rem]` and the Brief-sequence panel at `left-[34rem]` genuinely overlapped for
6rem, because neither offset accounted for the other's rendered width). Inside the
strategist-mode left rail, `PanelSection` (`ui/PanelSection.tsx`) wraps each of Tools,
Features, Plans, and Brief sequence as a collapsible section (defaults expanded — every
panel's prior always-visible behavior is unchanged), ordered top-to-bottom as one workflow:
draw/measure → see what you drew → persist it as a named plan → sequence a briefing
walkthrough — rather than the arbitrary prior source order. The player-mode vehicle
switcher and the right-side camera-pose/capture/import-intel block each get their own
single-section `PanelRail` (no `PanelSection` needed — each was already one self-contained
block with nothing to merge).

## Phase tagging (`planFeature.ts`, `planStore.ts`, `strategist.ts`) — Wave 3, T1

A `Plan` carries an ordered `phases: PlanPhase[]` (`{ id, name, order }`, `planStore.ts`) —
"Move to FUP", "Assault", "Consolidation" — managed via
`StrategistController.addPhase/renamePhase/reorderPhases/deletePhase`. Each `PlanFeature`
tags itself to a phase via `metadata.phase` (a phase id, or the `ALL_PHASES` sentinel
`'all-phases'` meaning "visible in every phase" — `planFeature.ts`). Reading a feature's
phase always goes through `resolveFeaturePhase(metadata, validPhaseIds)`, which validates
the tag against the CURRENT phase-id set and falls back to `ALL_PHASES` for both an
untagged feature and a dangling reference (a tag naming a deleted phase) — the same
defensive-default shape as `unitSymbol.ts`'s `readUnitMetadata`.

`StrategistController.setPhaseFilter(phaseId)` shows only that phase's (+ all-phase)
features by toggling each feature's `Group.visible` via the pure predicate
`isFeatureVisibleForPhase(featurePhase, filterPhase)` — never adding/removing geometry.
`deletePhase` clears every feature tagged to the deleted phase back to `ALL_PHASES` before
removing it from the list, so no feature is ever left pointing at a phase that no longer
exists. `clearAll` also resets `phases` and the active filter, since phases are plan-level
state, not per-feature.

Phases persist through `savePlan`/`loadPlan` as `Plan.phases` (`planStore.ts`); a feature's
`metadata.phase` tag rides through the existing `PlanFeature` round-trip (todo 11) with no
separate serialization path. Export (`exportPlan.ts`) includes a non-all-phase tag as a
`phase` property on the exported GeoJSON/KML feature; an all-phase/untagged feature omits
the property entirely (matches the existing `provenance`-optional convention).

## Timeline scrubber + unit movement (`timeline.ts`, `unitSymbol.ts`, `strategist.ts`) — Wave 3, T2

`timeline.ts` adds the time dimension over Wave-3's phase list: `unitPositionAt(phasePositions,
phaseA, phaseB, t)` is a pure lerp between a unit's recorded position at two phases —
endpoint-exact at `t=0`/`t=1`, and never interpolates toward an undefined endpoint (a
missing `phaseB` holds at `phaseA`'s position; a missing `phaseA` shows `phaseB`
immediately; both missing returns `null`, so the caller leaves the unit wherever it
currently sits rather than snapping it to world origin). `TimelineStepper` steps through
the ordered phase list — mirrors `briefPlayback.ts`'s `BriefPlaybackStepper` shape exactly
(`scrubTo` for an instant jump/slider-drag; `goTo`/`next`/`previous` for an animated
transition over `PHASE_TRANSITION_DURATION_MS`; `tick(nowMs)` returns the current blend or
`null` when idle).

A unit `PlanFeature` carries `metadata.phasePositions: Record<phaseId, LocalPoint>`
(`timeline.ts`'s `PhasePositions`). `StrategistController.setUnitPhasePosition` writes it;
`armSetUnitPhasePosition(featureId, phaseId)` arms a one-shot "next map click sets this
unit's position for this phase" capture (consumed in `onUp`, ahead of the currently-active
drafting tool) — the WorldView UI's "pin" button next to a unit row arms capture for
whichever phase the TIMELINE scrubber currently shows, not the unit's own `metadata.phase`
visibility tag (a different, independent concept from Wave-3 T1).

`StrategistController.scrubToPhaseIndex` (instant) and `stepTimelineNext/Previous`
(animated) both call `setPhaseFilter` (Wave-3 T1) immediately when the target phase is
selected — visibility snaps to the target phase right away, matching the user-flow's
"Phase-1 clutter hides" description; ONLY unit positions interpolate smoothly, driven every
frame from `StrategistController.update(nowMs)` via `TimelineStepper.tick`. Repositioning a
unit moves the `Group`'s sprite CHILD (`unitSymbol.ts`'s `repositionUnitSymbolGroup`), not
the `Group` itself — `buildUnitSymbolGroup` bakes the absolute point into the sprite, so
translating the group would double-offset it. `deletePhase`/`clearAll` clamp/cancel the
timeline stepper so a shrunk phase list can never leave it pointing past the array.

## Guided rehearsal playback (`rehearsal.ts`, `strategist.ts`, `viewpoint.ts`) — Wave 3, R3

`rehearsal.ts`'s `resolveRehearsalStep(viewpoints, phases, viewpointIndex)` is the pure
derivation at the heart of the composition: it maps a viewpoint index to `{ viewpointIndex,
phaseIndex }`, resolving `phaseIndex` FROM the viewpoint's own optional `phaseId`
(`viewpoint.ts`) — never a second, independently-tracked counter. This is what makes
invariant 1 ("camera and timeline cannot desync") structural rather than a discipline the
caller has to maintain: there is only ONE index to advance.

`StrategistController.rehearseGoTo(index, nowMs)` calls `playBriefGoTo` (Wave 2 R1) AND,
when the step resolves a `phaseIndex`, `timelineStepper.goTo` + an immediate
`setPhaseFilter` (Wave 3 T1/T2 composition — visibility snaps to the target phase right
away, matching the user-flow's description) — both driven by the SAME `nowMs`, so they
animate concurrently (`BRIEF_TRANSITION_DURATION_MS` and `PHASE_TRANSITION_DURATION_MS` are
both 1500ms). A viewpoint with no declared phase leaves the timeline untouched for that
step — not every viewpoint narrates a phase change.

`startRehearsal(nowMs)` begins a full run from viewpoint 0; `update(nowMs)` auto-advances to
the next step once the current one's brief transition completes, stopping after the last
viewpoint (invariant 2 — deterministic, and `cancelRehearsal()` interrupts cleanly at any
point, same shape as `cancelBriefPlayback`/`cancelTimelinePlayback`). `pauseRehearsal()` stops
the auto-advance without resetting position.

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
  Persistence, export, and phasing all read this one representation — a tool that renders
  directly without producing a `PlanFeature` is the bug that breaks save/export/phase
  silently.
- `PlanFeature.points.geo` is captured at draw time (`geoFrame.localToGeo`), never
  recomputed on load.
