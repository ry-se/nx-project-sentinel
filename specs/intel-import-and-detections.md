# Spec — Intel Import & Detections

Authority on the imagery-to-world pipeline: camera-pose capture, screenshot capture,
oriented-box annotation, monoplotting deployment, and the `SentinelDetection` schema.
Sources: `createSandbox.ts` (`getCameraPose`, `captureShot`, `deployFromImage`),
`features/sandbox/IntelImport.tsx`, `engine/detections.ts`, `constants/canvas.ts`.

## Camera pose (`CameraPose`)

`getCameraPose()` (`createSandbox.ts:508-534`) returns a versioned record
(`type: 'sentinel-camera-pose'`, `version: 1`) carrying both a **lossless local pose**
(`position` + `quaternion`) for exact reprojection and a **human-readable geo**
(`lat`, `lon`, `altM`, `headingDeg`, `pitchDeg`) plus `fovDeg`/`aspect` and the anchor
(`createSandbox.ts:51-66`). It is polled every 500 ms for the live readout and embedded
in every capture.

## Screenshot capture (`captureShot`)

`captureShot()` (`createSandbox.ts:536-554`) renders **tiles only** (camera layer set to
0 — excludes labels/markers/vehicles/HUD sprites), then downloads two files:
`sentinel-shot-<ts>.png` and a matching `sentinel-shot-<ts>.pose.json` (the pose with
`image: { width, height }` set to the canvas size). The pose JSON is the metadata "a
real drone would embed".

## Annotation (`IntelImport.tsx`)

The modal (`IntelImport.tsx:31`) loads the captured image and pre-fills the pose
textarea from the current pose. The user draws an **oriented bounding box (OBB)** per
target in three clicks (`IntelImport.tsx:154-175`):

1. REAR point, 2. FRONT point (sets length + facing), 3. width (perpendicular distance).

Each annotation is `ImageAnnotation { id, cls, rear, front, halfWidthPx }`
(`createSandbox.ts:68-75`). Class is one of `DETECTION_CLASSES` — `armored_fighting_vehicle`
(AFV), `light_military_vehicle` (LMV), `aircraft` (`detections.ts:22-26`) — editable per
box; boxes can be deleted. Canvas drawing constants are in `constants/canvas.ts` (`CANVAS`).

## Monoplotting deploy (`deployFromImage`)

`deployFromImage(pose, annotations, image)` (`createSandbox.ts:556-639`):

1. Reconstructs the exact screenshot camera from `pose.camera.local` + `fovDeg` +
   `image` aspect.
2. For each annotation, casts the box-center pixel through that camera onto
   `tiles.group` (`firstHitOnly`) → world point; casts front/rear pixels to derive a
   horizontal heading vector.
3. Converts the world point to lat/lon via `GeoFrame.localToGeo`, computes
   `world_heading` via `GeoFrame.compassHeadingDeg`.
4. Spawns a hostile model into the scene (`DetectionLayer.spawn`) and appends a
   `SentinelDetection` record.
5. Annotations whose ray misses the mesh increment `failed`; returns
   `{ detections, placed, failed }`.

Pose/image mismatch handling (`IntelImport.tsx:194-214`): a captured pose carries exact
dims (hard check, warn on mismatch); otherwise aspect is compared against
`CANVAS.ASPECT_MIN`. Mismatches **warn but still deploy**.

## `SentinelDetection` schema (locked contract)

`detections.ts:29-41` — the record the system emits today and the contract a future
detector must emit:

```ts
interface SentinelDetection {
  detection_id: string;
  image_id: string;
  class: 'armored_fighting_vehicle' | 'light_military_vehicle' | 'aircraft';
  confidence: number; // 1.0 today (human-annotated)
  bbox_pixel: { x; y; w; h; theta };
  lat: number;
  lon: number;
  world_heading: number;
  heading_confidence: 'high' | 'medium' | 'low';
  timestamp: string;
  source_image_url: string;
}
```

`confidence` is `1.0` because annotations are human-drawn (`createSandbox.ts:619`).

## Detection render layer (`detections.ts`)

`DetectionLayer.spawn(localPos, localYaw, cls, name)` renders each detection as a
red-tinted model (`HOSTILE_RED`, via the shared `ModelLibrary` with a per-class asset
map AFV→tank / LMV→car / aircraft→jet), a range ring, and a name tag, all on overlay
layer 1 (`detections.ts:62-80`). `clear()` empties the layer (the top-right 🗑 button /
`clearDetections`).

## Invariants (do not regress)

- The `SentinelDetection` schema is the integration seam — changes to it are
  cross-cutting (UI display + any future detector must match).
- Capture renders layer 0 only — captured imagery MUST be clean photogrammetry with no
  overlays, or reprojection geometry breaks.
- Deploy reprojects through the **saved** pose's lossless local position+quaternion, not
  the live camera.
- Detection geolocation goes through `GeoFrame` (see `tile-streaming-and-geo.md`).
