# Spec — Strategist Tools: Terrain-Reasoning Depth (Flow D)

Part of the strategist-tools domain — see `strategist-tools.md` for the full file map.
Covers Wave 4 (Flow D: terrain-reasoning depth) plus the pre-existing viewshed system
counter-viewshed reuses directly: elevation profile + move timing, viewshed,
counter-viewshed, route exposure, and weapon/sensor range fans. Sources:
`engine/elevationProfile.ts`, `engine/viewshed.ts`, `engine/strategist.ts`,
`engine/planFeature.ts`, `engine/weaponSystems.ts`, `constants/engine.ts` (`VIEWSHED`).

Builds on `strategist-tools-foundation.md` (the `PlanFeature` model these analyses read,
and `raycastLosBlockingHit`/`buildBandSegment`/`groundWalkEyeY` reuse from the `los` tool
and ground-walk).

## Elevation profile + move timing (`elevationProfile.ts`, `strategist.ts`) — Wave 4, M1+M4

The first Wave-4 tool pair, and the first "select an EXISTING feature and run a computed
analysis on it" interaction — every prior tool either draws something new or toggles a
filter. `PATH_FEATURE_TYPES = ['distance', 'axis']` (`strategist.ts`) marks which feature
types this applies to; the Features panel shows an Analyze button (mountain icon) only for
those. `StrategistController.computeElevationProfile(featureId)` and
`computeMoveTimeMinutes(featureId, rate)` are `null` for any non-path feature.

`sampleElevationProfile(points, raycaster, tiles, spacingM)` (default spacing
`ELEVATION_SAMPLE_SPACING_M = 20`m) walks the path and raycasts straight down at each
sample via `groundWalk.ts`'s `groundWalkEyeY(..., eyeHeight=0)` — reused, not
reimplemented. A sample the raycast misses (off the loaded tile area) is DROPPED, never
fabricated as elevation 0. Slope is computed between consecutive samples; a leg past
`SLOPE_NOGO_THRESHOLD_PERCENT` (30%) renders red in the WorldView elevation-profile canvas
chart, blue otherwise. `estimateMoveTimeMinutes(pathLengthM, rate)` reads
`MOVE_RATES_KMH` (`dismounted: 4`, `mounted: 25`) — a representative, not doctrinal, rate
table; the UI states the assumed rate on every readout.

Neither the profile nor the move-time estimate persists as its own state — both are
re-derived live from the path's `PlanFeature` + the current terrain, the same pattern
`los`'s blocked/clear recompute-on-`rebuildFeature` already establishes. Gate 5
(`01-analysis/04-army-strategist/04-viability-gates.md` — accuracy & trust) binds every
Wave-4 UI surface: the chart's caption states its sampling basis and limitation
("vegetation/structures not modelled"); the move-time readout states the assumed rate.

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

## Counter-viewshed (`strategist.ts`) — Wave 4, C3

"What can THEY see of me" is the SAME `ViewshedController` above, from a different
observer — `counterViewshed` is a `StratTool`, not a second visibility implementation.
`findNearestUnit(features, point, maxDistM)` (pure, exported from `strategist.ts`) picks
the nearest placed `unit`-type feature to the first click (any affiliation — enemy is the
doctrinal use case, not enforced); if nothing is within `COUNTER_VIEWSHED_PICK_RADIUS_M`
(40m), the click is a no-op with a "click closer to a placed unit" status rather than a
silent wrong-pick. The picked unit's position replaces the raw click point in `place()`,
then the exact same aim-with-mouse-then-click-to-lock flow the `viewshed` tool already
uses runs unchanged — `updatePreview()`'s live-aim branch is shared between both tools.
Status/HUD text always names the observer unit ("COUNTER-VIEWSHED from OP HAWK locked —
green = seen by them...") — Gate 5 (state whose eye the analysis is from).

## Route exposure (`elevationProfile.ts`, `planFeature.ts`) — Wave 4, M2

"How exposed is this approach" samples a selected path (todo 29's path-selection UI) at
fixed spacing and, for each sample, checks line-of-sight from a picked threat unit's
position via `raycastLosBlockingHit` (`planFeature.ts`) — the SAME raycast primitive
`buildLosGroup` (the `los` tool) uses, extracted once so both call sites read from one
implementation. `buildLosGroup` itself was refactored to call `raycastLosBlockingHit`
internally rather than duplicating the raycast setup — its own tests
(`strategist.planFeature.test.ts`) confirm this refactor didn't change its behavior.

`sampleRouteExposure(points, threatEye, raycaster, tiles, spacingM)` returns per-sample
`visibleToThreat: boolean`. `buildRouteExposureGroup` renders the path as alternating
red/green bands (`planFeature.ts`'s `buildBandSegment`, the same technique
`buildAxisGroup` uses) — **the color convention is INVERTED from `buildLosGroup`'s own
framing**: there, "clear" (unobstructed) is green because it means "you can see the
target"; here, unobstructed (visible-to-threat) is red because it means "the threat can
see YOU here". Same raycast primitive, opposite meaning, because the two tools answer
different questions. `exposureFraction` is the Gate-5 summary number; the UI states which
threat unit it was computed from and the sample spacing.

Rendered into `StrategistController.analysisRoot` — a separate transient-overlay Group
from `previewRoot` (which the draft/tool-switch flow clears constantly) — so the exposure
overlay persists while the user inspects it rather than vanishing on the next unrelated
interaction. Cleared explicitly (`clearRouteExposureOverlay`) or by `clearAll()`. Not
persisted as a `PlanFeature` — re-derived live, same pattern as M1's elevation profile.

## Weapon/sensor range fans (`weaponSystems.ts`, `planFeature.ts`) — Wave 4, C1

`WEAPON_SYSTEMS` (`weaponSystems.ts`) is a small table of representative, publicly-cited
NATO-class system parameters (81mm mortar, medium ATGM, ground surveillance radar) — each
entry's figure class is documented in a code comment (training/exercise use per Gate 6, not
validated targeting data). `rangeFan` is a `PlanFeatureType` whose `points.local` are
`[center, bearingPoint]` (the SAME control-point convention `arc` uses) and whose
`metadata.systemId` names the table entry — the min/max radius is NEVER baked into the
persisted feature; `buildRangeFanGroup` reads `WEAPON_SYSTEMS` at REBUILD time, so a future
correction to the table re-renders every saved plan correctly with zero data migration.
`readRangeFanSystemId` defensively falls back to a default system for a missing/unknown id
via `Object.prototype.hasOwnProperty.call`, NOT the `in` operator — a corrupted/hand-edited
`systemId` equal to a JS built-in key (`"toString"`, `"constructor"`, ...) cannot resolve to
an inherited prototype member instead of a real system (security-review finding, Wave 4 —
same class + same fix as `unitSymbol.ts`'s `readUnitMetadata`); never throwing on stale
saved data.

The fan renders as a min/max annulus (`Shape.absarc` for the outer boundary + a `Path` hole
for the inner radius — extends `buildArcGroup`'s `ShapeGeometry` technique with a hole,
rather than a new geometry method) — every system in the table today is a full 360° fan; a
doctrinal engagement-arc sector is a documented future refinement, not implemented (no
current system needs one). The label always states system name + min/max range AND that
it's geometric-range-only with no terrain masking applied (Gate 5) — composing a fan with
counter-viewshed/route-exposure to shade dead ground inside it is out of this todo's scope.

`rangeFan` exports to GeoJSON/KML as a `LineString` (the raw `[center, bearingPoint]`
control-point path) — the SAME convention `arc` already uses for its own control points,
not a reconstructed ring polygon (invariant 1, no re-projection); `systemId` travels into
the exported feature's properties alongside classification/provenance.
