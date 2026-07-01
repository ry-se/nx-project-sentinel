# Sentinel — Specs Index

Domain truth for Project Sentinel. Each file is the authority on its domain and
describes **what the system does today** (per `.claude/rules/spec-accuracy.md`: no
planned/Phase-N framing, every citation resolves against `apps/` on this branch).
Forward-looking work lives in `workspaces/sentinel/02-plans/`, never here.

Created 2026-06-30 by the harness-onboarding `/analyze` pass (the code predates the
harness). Verified against `feat/software-revamp`.

| Spec                              | Domain           | One line                                                                                                                      |
| --------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `cop-engine-and-modes.md`         | Core engine      | The `createSandbox` orchestrator, the two modes, render loop, camera, input, UI surface, lifecycle                            |
| `tile-streaming-and-geo.md`       | Geospatial world | Google 3D-tile streaming, cache/concurrency budget, omnidirectional load region, WGS84↔local frame, spawn anchors, OSM labels |
| `player-vehicles-and-ordnance.md` | Player units     | `Vehicle` base + tank/car/jet, ground/flight models, guns + projectiles, bombs + tile deformation, model catalog              |
| `spiderman-mode.md`               | Hidden movement  | The `ground/air/swing/zip/pull/wall` state machine, physics constants, momentum meter                                         |
| `strategist-tools.md`             | Recon/analysis   | Distance, focus area, fire arc, line-of-sight, viewshed; orbit/pan camera                                                     |
| `intel-import-and-detections.md`  | Imagery → world  | Pose capture, screenshot capture, oriented-box annotation, monoplotting deploy, `SentinelDetection` schema                    |
| `backend-api.md`                  | Backend          | The FastAPI surface as it exists today                                                                                        |
| `build-conventions-and-stack.md`  | Build/quality    | Nx targets, coding standards, model assets + licensing                                                                        |

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
