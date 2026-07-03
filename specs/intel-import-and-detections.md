# Spec — Intel Import & Detections

Authority on the imagery-to-world pipeline: camera-pose capture, screenshot capture,
**auto-detect** (VLM-backed) and manual oriented-box annotation, monoplotting deployment,
and the `SentinelDetection` schema. Sources: `createSandbox.ts` (`getCameraPose`,
`captureShot`, `deployFromImage`), `features/sandbox/IntelImport.tsx`,
`features/sandbox/intel/detectClient.ts`, `features/sandbox/intel/DetectDebug.tsx`,
`engine/detections.ts`, `constants/canvas.ts`. Backend contract: `backend-api.md`
§ `POST /api/v1/detect`.

## Camera pose (`CameraPose`)

`getCameraPose()` (`createSandbox.ts:551-577`) returns a versioned record
(`type: 'sentinel-camera-pose'`, `version: 1`) carrying both a **lossless local pose**
(`position` + `quaternion`) for exact reprojection and a **human-readable geo**
(`lat`, `lon`, `altM`, `headingDeg`, `pitchDeg`) plus `fovDeg`/`aspect` and the anchor
(`createSandbox.ts:48-63`). `fovDeg` is the camera's **vertical** field of view (three.js
`PerspectiveCamera` convention — see `deployFromImage` § geolocation uncertainty below). It
is polled every 500 ms for the live readout and embedded in every capture.

## Screenshot capture (`captureShot`)

`captureShot()` (`createSandbox.ts:579-597`) renders **tiles only** (camera layer set to
0 — excludes labels/markers/vehicles/HUD sprites), then downloads two files:
`sentinel-shot-<ts>.png` and a matching `sentinel-shot-<ts>.pose.json` (the pose with
`image: { width, height }` set to the canvas size). The pose JSON is the metadata "a
real drone would embed".

## Auto-detect pipeline (`detectClient.ts`, `IntelImport.tsx`)

The default path is **automated, no human in the loop** (F1). `IntelImport.tsx`'s
"Auto-detect" button calls `detect(imageB64, pose, image)` (`detectClient.ts:67-164`),
which POSTs to `${VITE_DETECT_API}/api/v1/detect` (`backend-api.md` § contract) and maps
the response 1:1 into `ImageAnnotation[]` — no reshaping downstream, so the result feeds
straight into `deployFromImage` exactly like a manually-drawn box would. Both `confidence`
and `heading_confidence` are the detector's real values (`detectClient.ts:152-165`) —
never a client-fabricated constant. A response with a `heading_confidence` outside
`'high'|'medium'|'low'`, or any other malformed box, is rejected as `invalid_response`
before it can reach `deployFromImage` (`detectClient.ts:167-183`).

Client-side guards before the request fires: images over `MAX_AUTO_DETECT_PIXELS`
(~16 megapixels) are rejected client-side (`IntelImport.tsx`), and every `DetectClientError`
surfaces a typed, user-safe message (network/http/invalid_response/no_backend_configured) —
never a raw exception.

**Optional human-confirm toggle** (`IntelImport.tsx`, defaults **OFF**): when the "Require
human confirmation before deploy" checkbox is ON, auto-detect results are held in a
pending-review list instead of deploying immediately — each detection can be
accepted/rejected (all accepted by default) before "Confirm & deploy" calls
`onDeploy` with only the accepted subset. OFF (the default) preserves the fully-automated
F1 path. Either way, `onDeploy` receives a `DeployProvenance` (`{ method: 'auto', model,
detectedAt }` for the auto path, `{ method: 'manual' }` for hand-drawn boxes) that flows
into every resulting `SentinelDetection`'s provenance fields (§ schema below).

`DetectDebug.tsx` (route `/detect-debug`) is a standalone test bench that calls `detect()`
directly against any image with no 3D world, no capture step, and no deploy — the fast
iteration loop for tuning detector accuracy (confidence + heading_confidence shown per box).

## Annotation (`IntelImport.tsx`)

The modal (`IntelImport.tsx:52`) loads the captured image and pre-fills the pose
textarea from the current pose. For **manual** annotation, the user draws an **oriented
bounding box (OBB)** per target in three clicks (`IntelImport.tsx:164-185`):

1. REAR point, 2. FRONT point (sets length + facing), 3. width (perpendicular distance).

Each annotation is `ImageAnnotation { id, cls, rear, front, halfWidthPx, confidence?,
headingConfidence? }` (`createSandbox.ts:69-77`) — `confidence`/`headingConfidence` are set
by the detector for the auto path; manual boxes leave them undefined and `deployFromImage`
falls back to certain (1.0 / `'high'` — a human-drawn box is exact). Class is one of
`DETECTION_CLASSES` — `armored_fighting_vehicle` (AFV), `light_military_vehicle` (LMV),
`aircraft` (`detections.ts:19-23`) — editable per box; boxes can be deleted. Canvas drawing
constants are in `constants/canvas.ts` (`CANVAS`).

## Monoplotting deploy (`deployFromImage`)

`deployFromImage(pose, annotations, image, provenance?)` (`createSandbox.ts:599-690`):

1. Reconstructs the exact screenshot camera from `pose.camera.local` + `fovDeg` +
   `image` aspect.
2. For each annotation, casts the box-center pixel through that camera onto
   `tiles.group` (`firstHitOnly`), bounded to `DEPLOY_RAYCAST_MAX_DISTANCE` (1500m — every
   raycast site in the engine bounds `far`; an unbounded ray on an imprecise pixel
   coordinate can hit terrain far from the capture point, see `journal/0012`) → world
   point; casts front/rear pixels to derive a horizontal heading vector.
3. Converts the world point to lat/lon via `GeoFrame.localToGeo`, computes
   `world_heading` via `GeoFrame.compassHeadingDeg`.
4. Computes a rough **geolocation uncertainty** estimate (`estimateGeoUncertaintyM`,
   `createSandbox.ts`): a CEP-style figure combining an assumed pixel-localization error
   (`ASSUMED_PIXEL_ERROR_PX = 3`, a documented approximation — no eval harness yet, see
   todo W6), the ground-sample-distance at range (vertical-FOV convention, matching this
   codebase's `PerspectiveCamera(fovDeg, ...)` usage), and an obliquity correction (a
   grazing near-horizontal ray covers more ground per pixel than a near-nadir one at the
   same range).
5. Spawns a hostile model into the scene (`DetectionLayer.spawn`, passing `confidence` +
   the uncertainty estimate — § render layer below) and appends a `SentinelDetection`
   record carrying `provenance` (§ schema below).
6. Annotations whose ray misses the mesh increment `failed`; returns
   `{ detections, placed, failed }`.

Pose/image mismatch handling (`IntelImport.tsx:208-222`): a captured pose carries exact
dims (hard check, warn on mismatch); otherwise aspect is compared against
`CANVAS.ASPECT_MIN`. Mismatches **warn but still deploy**.

## `SentinelDetection` schema (locked contract)

`detections.ts:28-49` — the record the system emits today, on both the manual and
auto-detect paths:

```ts
interface SentinelDetection {
  detection_id: string;
  image_id: string;
  class: 'armored_fighting_vehicle' | 'light_military_vehicle' | 'aircraft';
  confidence: number; // the detector's real value on the auto path; 1.0 for manual boxes
  bbox_pixel: { x; y; w; h; theta };
  lat: number;
  lon: number;
  world_heading: number;
  heading_confidence: 'high' | 'medium' | 'low'; // detector's value (auto); 'high' (manual)
  timestamp: string;
  source_image_url: string;
  method: 'manual' | 'auto'; // every detection is one or the other
  model?: string; // detector model id — present only for method: 'auto'
  detected_at?: string; // ISO 8601, when the detector produced this box — 'auto' only
  uncertainty_m?: number; // CEP-style ground-placement estimate, see deployFromImage § 4
}
```

`model`/`detected_at`/`uncertainty_m` are additive (W4) — no existing field was reshaped or
removed; a consumer reading only the pre-W4 fields is unaffected.

## Detection render layer (`detections.ts`)

`DetectionLayer.spawn(localPos, localYaw, cls, name, opts?)` renders each detection as a
red-tinted model (`HOSTILE_RED`, via the shared `ModelLibrary` with a per-class asset
map AFV→tank / LMV→car / aircraft→jet), a range ring, and a name tag, all on overlay
layer 1 (`detections.ts`). `opts.confidence` maps to ring opacity via
`confidenceToRingOpacity` (0.2 at confidence 0 → 0.7 at confidence 1.0, so a low-confidence
detection renders visibly fainter than a high-confidence one; omitted defaults to full
opacity, matching the pre-W4 constant). `opts.uncertaintyM`, when present, is appended to
the name tag (`"AFV-1 ±18m"`). `clear()` empties the layer (the top-right 🗑 button /
`clearDetections`).

## Invariants (do not regress)

- The `SentinelDetection` schema is the integration seam — changes to it are
  cross-cutting (UI display + the backend detector must match) and MUST be additive
  (`.claude/rules/spec-accuracy.md` / `specs-authority.md`).
- Capture renders layer 0 only — captured imagery MUST be clean photogrammetry with no
  overlays, or reprojection geometry breaks.
- Deploy reprojects through the **saved** pose's lossless local position+quaternion, not
  the live camera.
- Detection geolocation goes through `GeoFrame` (see `tile-streaming-and-geo.md`).
- `confidence`/`heading_confidence` on the auto path are always the detector's real
  values — never a client-side constant (W4; regression-tested in
  `IntelImport.test.tsx` and `detectClient.test.ts`).
- The human-confirm review toggle defaults OFF — the fully-automated path (F1) is the
  default; review is opt-in.
- The `deployFromImage` raycast is bounded to `DEPLOY_RAYCAST_MAX_DISTANCE` — no
  unbounded raycast site may be reintroduced (`journal/0012`).
