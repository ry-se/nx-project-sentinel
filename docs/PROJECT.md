# Sentinel — Project Overview

A web-based tactical Common Operating Picture (COP) built on Google Photorealistic 3D Tiles, rendered in Three.js. Runs entirely in the browser with no game engine. Has a secret Spider-Man web-swinging mode.

---

## Monorepo

| Path | What |
|---|---|
| `singapore-war-sim/nx-project-sentinel/` | Nx 22 monorepo root |
| `apps/frontend/` | The only app — React 19 + Vite 8 SPA |
| `apps/frontend/src/features/sandbox/` | All simulation code |
| `apps/frontend/src/features/sandbox/engine/` | Core engine files |
| `docs/` | This file + `spiderman-mode-plan.md` |

### Run commands

```bash
# MUST prefix with node@22 PATH or Nx fails
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"

# Dev server
npx nx serve @org/frontend

# Type-check
npx nx typecheck @org/frontend

# Production build
npx nx build @org/frontend
```

---

## Tech stack

| Layer | Choice |
|---|---|
| Monorepo | Nx 22 |
| Framework | React 19 |
| Build | Vite 8 |
| Styling | Tailwind 4 + daisyUI 5 |
| 3D | Three.js |
| 3D Tiles | `3d-tiles-renderer` v0.4.28 |
| Tile data | Google Photorealistic 3D Tiles (Map Tiles API) |
| Mesh compression | DRACO via `DRACOLoader` (WASM decoder) |

---

## Key engine files

| File | Role |
|---|---|
| `engine/createSandbox.ts` | Scene setup, tile renderer config, render loop, camera, input dispatch |
| `engine/vehicles.ts` | Abstract `Vehicle` base + `VehicleManager`; registers tank, car, jet, spider |
| `engine/spiderman.ts` | Spider-Man physics: state machine, pendulum, wall-run, web-fling |
| `engine/vehicleBase.ts` | Extracted abstract `Vehicle` + `DOWN` const (avoids circular import) |
| `engine/strategist.ts` | Strategist-mode tools: distance, fire arc, LOS, viewshed, focus area |
| `engine/viewshed.ts` | GPU viewshed via depth-buffer readback |
| `engine/detections.ts` | Intel-import detection layer (monoplotting pipeline) |
| `engine/projectiles.ts` | Tank/jet weapon projectiles |
| `engine/bombs.ts` | Bomb drop + tile-mesh deformation |
| `engine/labels.ts` | Billboard labels for vehicles |
| `engine/geoFrame.ts` | World ↔ geo coordinate helpers |
| `engine/modelCatalog.ts` | GLB model registry |
| `WorldView.tsx` | React shell: key entry, mode/tool UI, HUD, pose readout |
| `IntelImport.tsx` | Intel-import modal (image annotation → 3D deployment) |
| `spawnLocations.ts` | Named spawn points (lat/lon) |

---

## Modes

### Player mode (TAB to toggle)
- **Tank** (key `1`): WASD drive, SPACE fire
- **Car** (key `2`): WASD drive, SPACE fire
- **Jet** (key `3`): W/S throttle, A/D yaw, ↑↓ pitch, Q/E barrel roll, SHIFT afterburner, B bomb, SPACE guns
- **Spider-Man** (key `5`, hidden): web-swinging — see below

### Strategist mode (TAB)
Tools: Select, Distance, Focus Area, Fire Arc, Line of Sight, Viewshed.
Labels toggle, Clear All, Intel Import modal.

---

## Spider-Man mode — full state machine

File: `engine/spiderman.ts`

States: `ground | air | swing | zip | pull | wall`

### Controls
| Key | Action |
|---|---|
| SHIFT+W | Sprint (20 m/s) |
| W alone | Jog (8 m/s) |
| SPACE (ground) | Jump |
| SPACE (air) | Attach web → swing |
| SPACE (mid-zip) | Zip-cancel, keep velocity → air |
| W (swing descending) | Dive (steepens arc) |
| A/D | Rotate velocity (air 2.1 rad/s, swing 1.3 rad/s) |
| SHIFT (air/swing) | Zip to highest rooftop in fan |
| W+SHIFT (zip aim) | Near-vertical ray → rooftop over head |
| E | Web-pull: straight-line yank to surface (2 charges) |
| F | Web-fling: on wall = slingshot over rooftop; in air = boost along travel |
| Swing INTO wall | Enters wall-run |
| W (wall) | Climb |
| A/D (wall) | Traverse |
| SPACE (wall) | Jump off wall |

### Physics constants (top of spiderman.ts)
- Gravity: G_RISE −38 / G_FALL −56 / G_SWING −48 (asymmetric — no apex hang)
- Speeds: RUN 20, JOG 8, ZIP 58, PULL 52, MAX_SWING 74
- Air drag: quadratic `F ∝ v²` (DRAG_K 0.0016) — natural speed cap, not a hard clamp
- Momentum meter: 0–1, built by swing releases / wall climbs / zip ends, decays 0.10/s, reduces air drag (aero meter) + scales fling boost, shown in HUD

### Key implementation notes
- Rope constraint: radial-velocity kill each frame, reel toward ROPE_IDEAL 38 m
- Zip: picks HIGHEST hit in elevation fan (not first hit = not wall base)
- Web-pull ('pull' state): gravity suppressed for 0.35 s, constant velocity travel — not an impulse
- Wall normal: horizontalized (player−hit vector), robust to noisy photogrammetry normals
- Body pose: lean angle driven by full velocity vector (`atan2(-vertSpeed, horizSpeed)`)
- Animations: deferred — stickman is procedural-pose only; a GLB can drop in via MODEL_CATALOG['spider']

---

## Tile loading — hard-won lessons

### How `3d-tiles-renderer` works
- Tile loading is **hard-gated by the camera frustum** (`markUsedTiles` bails on `!inFrustum`). Tiles outside where the camera points never download without intervention.
- "Render distance" = SSE error model (`errorTarget`) + camera far plane. There is no distance parameter.
- LRU cache `isFull()` → throttles new downloads AND discards just-parsed tiles. Under-sized cache = persistent low-poly even with enough concurrency.

### Current config (`engine/createSandbox.ts`)
```
errorTarget = 8                   // never set below 6
lruCache.minSize = 12000
lruCache.maxSize = 20000
lruCache.minBytesSize = 1.5 GB
lruCache.maxBytesSize = 2.5 GB
downloadQueue.maxJobs = 40        // default 25; NEVER go below 25
parseQueue.maxJobs = 8            // default 5
displayActiveTiles = true         // keep off-frustum region tiles rendered
```

### Omnidirectional loading (LoadRegionPlugin)
`LoadRegionPlugin` + `SphereRegion(radius=1200 m, errorTarget=10)` centered on the player forces omnidirectional high-detail loading regardless of camera direction. Center must be in **tiles.group local space** — convert `vehicles.position` (world) via `tiles.group.worldToLocal()` every frame before `tiles.update()`.

### Regression rule
Never lower DEMAND (errorTarget, region size) without also raising SUPPLY (cache budget, downloadQueue.maxJobs). Doing the opposite caused the all-low-poly regression: errorTarget 5 + maxJobs 12 (below default) + tiny cache = fine children queued, coarse parents rendered, isFull() discarding parsed tiles.

### Service worker — DELETED
`public/sw.js` (cache-first SW intercepting tile.googleapis.com) is gone. `main.tsx` runs a one-time SW-unregister + sentinel-tiles cache purge on load to clean up browsers that had the old SW installed. Safe to remove that cleanup code after one deploy cycle.

### Fog
Pushed from `(1500, 9000)` to `(12000, 45000)` — the old values whited out everything past 9 km, hiding the real render distance. camera.far is 50000.

---

## Intel import pipeline
1. User captures a screenshot + pose JSON (lat/lon/alt/heading/pitch/fov)
2. Opens Import Intel modal, loads image + pose
3. Annotates bounding boxes (oriented, with half-width) per detection class
4. `deployFromImage` back-projects pixel annotations through the pose matrix onto the tile mesh via raycasting → places `SentinelDetection` objects in the scene

---

## What's implemented (June 2026)
- [x] Google Photorealistic 3D Tiles rendering
- [x] Player mode: tank, car, jet vehicles
- [x] Strategist mode: distance, fire arc, LOS, viewshed, focus area tools
- [x] Bomb drop + tile-mesh deformation
- [x] Billboard labels
- [x] Camera pose readout (lon/lat/alt/heading)
- [x] Screenshot capture (tiles-only PNG + pose JSON sidecar)
- [x] Intel import (image annotation → 3D monoplotting)
- [x] Spider-Man web-swinging (key 5, secret)
  - [x] Pendulum swing physics
  - [x] Zip to rooftop
  - [x] Web-pull (straight-line yank)
  - [x] Sprint / jog / asymmetric gravity
  - [x] Quadratic air drag + momentum meter (SM2 model)
  - [x] Wall-run + web-fling
- [x] Omnidirectional tile loading (LoadRegionPlugin)
- [x] Big render distance (fog 12–45 km)

## What's planned / not yet done
- [ ] Spider-Man GLB model + animations (Blender MCP — deferred)
- [ ] Multiplayer (discussed: Yjs for COP layer, WebSocket ghost-players; needs a server)
- [ ] Tile caching for offline / reduced API calls (needs network-first strategy, not cache-first)
