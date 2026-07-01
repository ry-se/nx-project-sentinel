# Spec — Tile Streaming & Geospatial Frame

Authority on the streamed 3D world: Google Photorealistic 3D Tiles configuration,
cache/concurrency budget, omnidirectional load region, the WGS84↔local coordinate
frame, spawn anchors, and OSM place labels.
Sources: `createSandbox.ts`, `engine/geoFrame.ts`, `engine/labels.ts`,
`features/sandbox/spawnLocations.ts`.

## Tile renderer & plugins

`TilesRenderer` from `3d-tiles-renderer`, with five plugins
(`createSandbox.ts:184-215`):

1. `GoogleCloudAuthPlugin({ apiToken: apiKey, autoRefreshToken: true })`.
2. `GLTFExtensionsPlugin({ dracoLoader })` — DRACO WASM decoder from
   `https://www.gstatic.com/draco/v1/decoders/`, worker count `clamp(4, cores-1, 8)`,
   preloaded (`createSandbox.ts:188-193`).
3. `ReorientationPlugin({ lat, lon, recenter: true })` — re-centers the tileset on the
   anchor in radians.
4. `LoadRegionPlugin` + `SphereRegion` (see below).

`tiles.setCamera`, `tiles.setResolutionFromRenderer`, `tiles.errorTarget = 8`.

## Frustum-gated loading & the load region

The renderer only refines tiles inside the camera frustum (`markUsedTiles` bails on
`!inFrustum`). To force omnidirectional detail around the player, a `SphereRegion`
(radius **1200 m**, `errorTarget` **10**) is ORed into the visibility test and its
center is recentered on the active vehicle **every frame** in tiles-group-local space
(`createSandbox.ts:209-215`, `:491-493`).

## Cache & concurrency budget (set before the first `update()`)

`createSandbox.ts:228-234`:

| Setting                 | Value   | Default |
| ----------------------- | ------- | ------- |
| `lruCache.minSize`      | 12000   | —       |
| `lruCache.maxSize`      | 20000   | —       |
| `lruCache.minBytesSize` | ~1.5 GB | —       |
| `lruCache.maxBytesSize` | ~2.5 GB | 0.4 GB  |
| `downloadQueue.maxJobs` | 40      | 25      |
| `parseQueue.maxJobs`    | 8       | 5       |
| `displayActiveTiles`    | true    | —       |

## Fog & render distance

`scene.fog = Fog(0x9fc4e0, 12000, 45000)` inside `camera.far = 50000`
(`createSandbox.ts:167-174`). Fog far must stay inside camera far; the prior `(1500,
9000)` values whited out everything past ~9 km.

## Geospatial frame (`GeoFrame`)

`GeoFrame(tiles, anchor)` (`geoFrame.ts:15`) converts between the tileset's local
metric frame and WGS84 using the renderer's own ellipsoid math:

- `localToGeo(localVec3) → { lat, lon, altM }` via `inverse(group.matrixWorld)` then
  `ellipsoid.getPositionToCartographic` (`geoFrame.ts:47-57`).
- `compassHeadingDeg(localDir) → 0–360°` (0 = north) via the anchor's
  east/north axes (`getEastNorthUpAxes`) (`geoFrame.ts:60-65`).

This is the basis for the live camera-pose readout and intel-import geolocation — there
are no hand-tuned axis conventions.

## Spawn anchors (`spawnLocations.ts`)

Five named locations: `manhattan` (40.7580, -73.9855), `san_francisco`
(37.7955, -122.3937), `singapore` (1.2868, 103.8545), `sydney` (-33.8568, 151.2153),
`tokyo_shibuya` (35.6595, 139.7005). Persisted in `localStorage['spawn_location_key']`;
default `manhattan` (`spawnLocations.ts:41-43`). Changing it dispatches a global
`CustomEvent('spawnLocationChanged')` that re-keys the sandbox. The engine's code-level
fallback anchor (`DEFAULT_ANCHOR`) is Singapore, but `WorldView` always passes an
explicit anchor.

## OSM place labels (`LabelManager`)

Place-name labels are fetched live from the OpenStreetMap Overpass API for a ~1.5 km
box around the anchor (`labels.ts:123-184`), placed in the local frame via exact ECEF
transform, lazily clamped to the mesh surface by raycast (12 per ~800 ms cycle), and
distance-culled beyond 2600 m. Results are cached in `localStorage['osm_labels_cache_v1']`;
max 90 labels, priority-sorted by kind. Toggled by the strategist Labels button.

## Invariants (do not regress)

- **Supply must outrun demand.** Never lower demand (`errorTarget` < 6, smaller region)
  without raising supply (cache budget, `downloadQueue.maxJobs ≥ 25`). The inverse
  caused a documented all-low-poly regression (`createSandbox.ts:222-227`, `docs/PROJECT.md`).
- The load-region center MUST be recentered on the player in tiles-group-local space
  every frame (bounding volumes are local).
- Geo conversions go through `GeoFrame` (renderer ellipsoid), never hand-rolled axes.
- Fog far stays strictly inside `camera.far`.
