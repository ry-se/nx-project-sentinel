# Spec — Strategist Tools (domain index)

Authority on strategist-mode reconnaissance/analysis tools and the orbit/pan camera.
Sources: `engine/strategist.ts`, `engine/planFeature.ts`, `engine/viewshed.ts`,
`constants/engine.ts` (`VIEWSHED`).

This domain is split into sub-domain files (`specs-authority.md` Rule 8 — the single
file passed 300 lines during Wave 4). Each sub-file is self-contained for its own
sub-domain; start with `strategist-tools-foundation.md` — every other file builds on
the `PlanFeature` model and feature-list API it describes.

| File                                   | Covers                                                                                                                                                                       |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `strategist-tools-foundation.md`       | Controller & camera, tool drafting, the `PlanFeature` model + feature-list API, control measures, unit symbols, MGRS readout, bearings, plan persistence (Waves 0–1, Flow A) |
| `strategist-tools-briefing.md`         | Viewpoint bookmarks + brief playback, ground walk, classification/provenance, GeoJSON/KML export, sand-table wiring (Wave 2, Flow B)                                         |
| `strategist-tools-ui-design.md`        | The strategist/player-mode panel-rail UI design system                                                                                                                       |
| `strategist-tools-rehearsal.md`        | Phase tagging, timeline scrubber + unit movement, guided rehearsal playback (Wave 3, Flow C)                                                                                 |
| `strategist-tools-terrain-analysis.md` | Elevation profile + move timing, viewshed, counter-viewshed, route exposure, weapon/sensor range fans (Wave 4, Flow D)                                                       |
| `strategist-tools-invariants.md`       | Cross-cutting invariants every tool above MUST hold                                                                                                                          |
