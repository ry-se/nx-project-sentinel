import { TilesRenderer } from '3d-tiles-renderer';
import { OBJECT_FRAME } from '3d-tiles-renderer/three';
import { MathUtils, Mesh, MeshBasicMaterial, PlaneGeometry, Scene } from 'three';

import { type CameraPose, deployAnnotations, type ImageAnnotation } from './createSandbox';
import { DetectionLayer } from './detections';
import { GeoFrame } from './geoFrame';
import { ModelLibrary } from './modelCatalog';

/** W6 E2E smoke test: real `deployAnnotations` (the extracted core of
 * `deployFromImage`), real Three.js raycasting/geo-conversion/render-layer objects — no
 * WebGL/canvas needed (`TilesRenderer` is a scene-graph manager, not a renderer; ellipsoid
 * math and `GeoFrame` are pure). A fixture-shaped `ImageAnnotation[]` stands in for what
 * `detect()` would return over the wire (todo W6: "fixture/recorded response for the
 * third-party boundary" — the real network call is not this test's concern, the real
 * deploy/render pipeline is). */

function fakeCanvasContext() {
  const measureText = () => ({ width: 42 });
  return new Proxy(
    { measureText },
    {
      get: (target, prop) => (prop in target ? (target as never)[prop] : vi.fn()),
    }
  );
}

/** Sets up a bare `TilesRenderer` the way production `createSandbox` does via
 * `ReorientationPlugin({ lat, lon, recenter: true })` — except that plugin needs a
 * loaded tileset to run against (it fires on `load-root-tileset`), which this fast unit
 * test doesn't fetch. Replicates the plugin's own `transformLatLonHeightToOrigin` exactly
 * (`ReorientationPlugin.js`) rather than approximating it: get the ENU/Y-up "object
 * frame" at the anchor, then INVERT it — the object frame maps local-object-space to
 * ECEF at that point, but the tiles GROUP needs the opposite (ECEF recentered so the
 * anchor sits at local origin). Missing that invert is the difference between "near the
 * equator" and "at the south pole" for the same lat/lon input. */
function setupTilesAtAnchor(anchor: { lat: number; lon: number }): TilesRenderer {
  const tiles = new TilesRenderer();
  // TilesRenderer's group delegates raycasting to its own tile-loading path by default
  // (TilesGroup.raycast -> tilesRenderer.raycast when optimizeRaycast is on), which
  // finds nothing against a mesh added directly rather than loaded as real tile content.
  // Disabling it restores standard Object3D child-traversal raycasting — this test cares
  // about deployAnnotations' own geometry math, not tile-loading internals.
  tiles.optimizeRaycast = false;
  tiles.ellipsoid.getObjectFrame(
    MathUtils.DEG2RAD * anchor.lat,
    MathUtils.DEG2RAD * anchor.lon,
    0,
    0,
    0,
    0,
    tiles.group.matrix,
    OBJECT_FRAME
  );
  tiles.group.matrix
    .invert()
    .decompose(tiles.group.position, tiles.group.quaternion, tiles.group.scale);
  tiles.group.updateMatrixWorld(true);
  return tiles;
}

const POSE: CameraPose = {
  type: 'sentinel-camera-pose',
  version: 1,
  capturedAt: '2026-07-03T00:00:00.000Z',
  anchor: { lat: 1.35, lon: 103.8 },
  camera: {
    fovDeg: 60,
    aspect: 1.6,
    // Default camera orientation (identity quaternion) looks down -Z — same arrangement
    // proven in raycastBounds.test.ts's `camera()`/`planeAtDistance()` helpers, just
    // reused directly rather than re-derived, since getting look-direction quaternion
    // signs right by hand is exactly the kind of thing worth not re-deriving.
    local: { position: [0, 0, 500], quaternion: [0, 0, 0, 1] },
    geo: { lat: 1.35, lon: 103.8, altM: 500, headingDeg: 0, pitchDeg: -90 },
  },
};

const IMAGE = { width: 800, height: 500, name: 'e2e-fixture.png' };

// Fixture standing in for a detect() response — a large half-width so the fixed
// rear/front pixel coordinates land well inside the plane target regardless of exact
// projection math (this test proves the pipeline wires end-to-end, not exact geometry —
// that's raycastBounds.test.ts's + uncertainty.test.ts's job).
const FIXTURE_ANNOTATIONS: ImageAnnotation[] = [
  {
    id: 'fixture-0',
    cls: 'armored_fighting_vehicle',
    rear: [400, 260],
    front: [400, 240],
    halfWidthPx: 15,
    confidence: 0.87,
    headingConfidence: 'high',
  },
];

describe('deployAnnotations — E2E smoke (capture -> detect fixture -> deploy -> rendered)', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      fakeCanvasContext() as unknown as CanvasRenderingContext2D
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('deploys a fixture detection through the real raycast -> geo -> render pipeline', () => {
    const tiles = setupTilesAtAnchor(POSE.anchor);
    // Default plane normal is +Z — faces back at the camera sitting at z=500 (matches
    // raycastBounds.test.ts's planeAtDistance() convention exactly, no rotation needed).
    const target = new Mesh(new PlaneGeometry(2000, 2000), new MeshBasicMaterial());
    tiles.group.add(target);
    tiles.group.updateMatrixWorld(true);

    const geoFrame = new GeoFrame(tiles, POSE.anchor);
    const scene = new Scene();
    const detectionLayer = new DetectionLayer(scene, new ModelLibrary());

    const result = deployAnnotations(
      { tilesGroup: tiles.group, geoFrame, detectionLayer },
      POSE,
      FIXTURE_ANNOTATIONS,
      IMAGE,
      { method: 'auto', model: 'fixture-model', detectedAt: '2026-07-03T00:00:05.000Z' }
    );

    // The real deploy pipeline ran end-to-end — not a stub (todo W6 invariant 5).
    expect(result.failed).toBe(0);
    expect(result.placed).toBe(1);
    expect(result.detections).toHaveLength(1);

    const detection = result.detections[0];
    expect(detection.class).toBe('armored_fighting_vehicle');
    expect(detection.confidence).toBe(0.87);
    expect(detection.heading_confidence).toBe('high');
    expect(detection.method).toBe('auto');
    expect(detection.model).toBe('fixture-model');
    // Real ellipsoid math, not a fixed/fabricated coordinate — lands near the anchor
    // (the target plane sits at the anchor's local origin).
    expect(detection.lat).toBeCloseTo(POSE.anchor.lat, 2);
    expect(detection.lon).toBeCloseTo(POSE.anchor.lon, 2);
    expect(detection.uncertainty_m).toBeGreaterThan(0);

    // The render layer actually spawned something — count is the only public surface
    // DetectionLayer exposes for "did a detection actually render" without reaching into
    // Three.js internals.
    expect(detectionLayer.count).toBe(1);
  });

  it('a ray that misses the target mesh increments failed, not a fabricated placement', () => {
    const tiles = setupTilesAtAnchor(POSE.anchor); // no mesh added — every raycast misses
    const geoFrame = new GeoFrame(tiles, POSE.anchor);
    const scene = new Scene();
    const detectionLayer = new DetectionLayer(scene, new ModelLibrary());

    const result = deployAnnotations(
      { tilesGroup: tiles.group, geoFrame, detectionLayer },
      POSE,
      FIXTURE_ANNOTATIONS,
      IMAGE,
      { method: 'auto', model: 'fixture-model', detectedAt: '2026-07-03T00:00:05.000Z' }
    );

    expect(result.placed).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.detections).toHaveLength(0);
    expect(detectionLayer.count).toBe(0);
  });
});
