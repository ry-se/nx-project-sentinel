# Model catalogue

GLB models referenced by `src/features/sandbox/engine/modelCatalog.ts`.
Every consumer (player vehicles, hostile detections, future friendly units)
loads from this folder via the `ModelLibrary`.

## How it works

- Models are **auto-normalised** on load: scaled to the catalogue's
  `targetLength` (hull length in metres), centred, bottom placed at ground
  level. Any reasonably-sized GLB just works.
- If a file here is missing or fails to load, the engine silently falls back
  to the built-in low-poly primitive — the app never breaks over a model.
- Convention: models should face **+Z**. If a downloaded model drives
  sideways/backwards, set `rotationY` for it in `modelCatalog.ts`
  (e.g. `rotationY: Math.PI / 2`).

## Current models

| File | Used for | Source | License |
|---|---|---|---|
| `tank.glb` | Player tank + hostile AFV | CesiumGS/cesium sample `GroundVehicle.glb` | Apache-2.0 |
| `car.glb` | Player GT car + hostile LMV | three.js example `ferrari.glb` | three.js examples (MIT repo; model credits: vehicle by Carlo Crisci / DEZA) |
| `jet.glb` | Player jet + hostile aircraft | CesiumGS/cesium sample `Cesium_Air.glb` | Apache-2.0 |

These are **placeholder-quality stand-ins** to prove the pipeline. For the
real demo, replace them with better models — keep the same filenames and
nothing else needs to change.

## Where to get better models (free)

- **Sketchfab** (filter: downloadable + CC0/CC-BY) — best military models;
  download as glTF, rename, drop in here. CC-BY requires crediting the author.
- **Quaternius** (quaternius.com) — CC0 low-poly packs incl. military vehicles.
- **Kenney** (kenney.nl/assets) — CC0 stylised vehicle packs.
- **Poly Pizza** (poly.pizza) — searchable CC0 model index.

Check the license before shipping anything in a public demo.
