# Spec — Strategist Tools: Briefing & Sand-Table (Flow B)

Part of the strategist-tools domain — see `strategist-tools.md` for the full file map.
Covers Wave 2 (Flow B: give orders on the sand table): viewpoint bookmarks, brief
playback, ground walk, classification + provenance, GeoJSON/KML export, and the
sand-table wiring gate. Sources: `engine/viewpoint.ts`, `engine/briefPlayback.ts`,
`engine/groundWalk.ts`, `engine/classification.ts`, `engine/exportPlan.ts`,
`engine/strategist.ts`.

Builds on `strategist-tools-foundation.md` (the `PlanFeature` model, feature-list API,
and plan persistence this file's viewpoints/classification/export ride alongside).

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
