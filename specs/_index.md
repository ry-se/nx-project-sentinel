# Sentinel — Specs Index

Domain truth for Project Sentinel. Each file is the authority on its domain and
describes **what the system does today** (per `.claude/rules/spec-accuracy.md`: no
planned/Phase-N framing, every citation resolves against `apps/` on this branch).
Forward-looking work lives in `workspaces/sentinel/02-plans/`, never here.

Created 2026-06-30 by the harness-onboarding `/analyze` pass (the code predates the
harness). Verified against `feat/software-revamp`.

| Spec                                   | Domain           | One line                                                                                                                                     |
| -------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `cop-engine-and-modes.md`              | Core engine      | The `createSandbox` orchestrator, the two modes, render loop, camera, input, UI surface, lifecycle                                           |
| `tile-streaming-and-geo.md`            | Geospatial world | Google 3D-tile streaming, cache/concurrency budget, omnidirectional load region, WGS84↔local frame, spawn anchors, OSM labels                |
| `player-vehicles-and-ordnance.md`      | Player units     | `Vehicle` base + tank/car/jet, ground/flight models, guns + projectiles, bombs + tile deformation, model catalog                             |
| `spiderman-mode.md`                    | Hidden movement  | The `ground/air/swing/zip/pull/wall` state machine, physics constants, momentum meter                                                        |
| `strategist-tools.md`                  | Recon/analysis   | Domain index — see the 6 sub-files below (`specs-authority.md` Rule 8 split)                                                                 |
| `strategist-tools-foundation.md`       | Recon/analysis   | Controller & camera, tool drafting, `PlanFeature` model + feature-list API, control measures, unit symbols, MGRS, bearings, plan persistence |
| `strategist-tools-briefing.md`         | Recon/analysis   | Viewpoint bookmarks + brief playback, ground walk, classification/provenance, GeoJSON/KML export, sand-table wiring                          |
| `strategist-tools-ui-design.md`        | Recon/analysis   | The strategist/player-mode panel-rail UI design system                                                                                       |
| `strategist-tools-rehearsal.md`        | Recon/analysis   | Phase tagging, timeline scrubber + unit movement, guided rehearsal playback                                                                  |
| `strategist-tools-terrain-analysis.md` | Recon/analysis   | Elevation profile + move timing, viewshed, counter-viewshed, route exposure, weapon/sensor range fans                                        |
| `strategist-tools-invariants.md`       | Recon/analysis   | Cross-cutting invariants every strategist tool MUST hold                                                                                     |
| `intel-import-and-detections.md`       | Imagery → world  | Pose capture, screenshot capture, oriented-box annotation, monoplotting deploy, `SentinelDetection` schema                                   |
| `backend-api.md`                       | Backend          | The FastAPI surface as it exists today                                                                                                       |
| `build-conventions-and-stack.md`       | Build/quality    | Nx targets, coding standards, model assets + licensing                                                                                       |

## Brief traceability

Every requirement in `workspaces/sentinel/briefs/01-onboarding-brief.md` maps to a spec:

| Brief req                   | Spec                                                   |
| --------------------------- | ------------------------------------------------------ |
| R2 engine/modes/loop        | `cop-engine-and-modes.md`                              |
| R3 tile streaming + geo     | `tile-streaming-and-geo.md`                            |
| R4 vehicles/weapons/bombs   | `player-vehicles-and-ordnance.md`                      |
| R5 spider-man mode          | `spiderman-mode.md`                                    |
| R6 strategist tools         | `strategist-tools.md`                                  |
| R7 intel import + schema    | `intel-import-and-detections.md`                       |
| R8 backend today            | `backend-api.md`                                       |
| R9 build/conventions/assets | `build-conventions-and-stack.md`                       |
| R1 architecture             | spread across all + `workspaces/sentinel/01-analysis/` |

## Conventions

- File:line citations use `path:line` against this branch. If a refactor moves code,
  the citing spec section updates in the same PR (`spec-accuracy.md` Rule 5).
- `## Invariants` sections record properties that future work MUST NOT regress.
