# Spec — Strategist Tools: Phasing & Rehearsal (Flow C)

Part of the strategist-tools domain — see `strategist-tools.md` for the full file map.
Covers Wave 3 (Flow C: rehearse with phasing): phase tagging, the timeline scrubber +
unit movement, and guided rehearsal playback (the composition of phasing with Wave 2's
brief playback). Sources: `engine/planFeature.ts`, `engine/planStore.ts`,
`engine/timeline.ts`, `engine/unitSymbol.ts`, `engine/rehearsal.ts`,
`engine/strategist.ts`, `engine/viewpoint.ts`.

Builds on `strategist-tools-foundation.md` (the `PlanFeature`/`Plan` model phases and
phase tags extend) and `strategist-tools-briefing.md` (the brief-sequence playback
rehearsal composes with).

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
