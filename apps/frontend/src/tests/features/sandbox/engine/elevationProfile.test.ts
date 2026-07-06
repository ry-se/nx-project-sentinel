import { TilesRenderer } from '3d-tiles-renderer';
import {
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Raycaster,
  Vector3,
} from 'three';

import {
  buildRouteExposureGroup,
  estimateMoveTimeMinutes,
  exposureFraction,
  isNoGo,
  MOVE_RATES_KMH,
  sampleElevationProfile,
  sampleRouteExposure,
  SLOPE_NOGO_THRESHOLD_PERCENT,
} from '../../../../features/sandbox/engine/elevationProfile';

/**
 * Todo 29 — M1 (elevation profile) + M4 (move timing). Covers the 4 stated invariants:
 * 1. `sampleElevationProfile` is a pure function of (points, spacing) given a
 *    raycaster/tiles.
 * 2. A missed raycast sample is DROPPED, never fabricated as elevation 0.
 * 3. Move-time is a pure function of path length + selected rate.
 * 4. (UI-level — verified in WorldView.tsx, not here.)
 */

function flatGroundTiles(sizeM = 2000): TilesRenderer {
  const tiles = new TilesRenderer();
  tiles.group.raycast = Group.prototype.raycast;
  const ground = new Mesh(new PlaneGeometry(sizeM, sizeM), new MeshBasicMaterial());
  ground.rotation.x = -Math.PI / 2;
  tiles.group.add(ground);
  ground.updateMatrixWorld(true);
  return tiles;
}

describe('sampleElevationProfile (invariant 1 — pure given raycaster/tiles)', () => {
  it('samples a flat path at the expected spacing, all elevations ~0 with 0 slope', () => {
    const tiles = flatGroundTiles();
    const raycaster = new Raycaster();
    const points = [new Vector3(-100, 0, 0), new Vector3(100, 0, 0)];

    const samples = sampleElevationProfile(points, raycaster, tiles.group, 50);

    // 200m path at 50m spacing → distances 0, 50, 100, 150, 200 (5 samples).
    expect(samples.map((s) => s.distanceAlongM)).toEqual([0, 50, 100, 150, 200]);
    for (const s of samples) {
      expect(s.elevationM).toBeCloseTo(0, 1);
      expect(s.slopePercent).toBeCloseTo(0, 1);
    }
  });

  it('always includes a final sample at the exact path length, not just spacing multiples', () => {
    const tiles = flatGroundTiles();
    const raycaster = new Raycaster();
    const points = [new Vector3(0, 0, 0), new Vector3(130, 0, 0)];

    const samples = sampleElevationProfile(points, raycaster, tiles.group, 50);

    expect(samples[samples.length - 1].distanceAlongM).toBe(130);
  });

  it('returns an empty profile for a degenerate path (fewer than 2 points)', () => {
    const tiles = flatGroundTiles();
    const raycaster = new Raycaster();
    expect(sampleElevationProfile([new Vector3(0, 0, 0)], raycaster, tiles.group, 50)).toEqual([]);
  });
});

describe('sampleElevationProfile (invariant 2 — missed samples are dropped, never fabricated as 0)', () => {
  it('drops a sample that raycasts off the loaded tile area', () => {
    const tiles = flatGroundTiles(200); // a SMALL ground plane
    const raycaster = new Raycaster();
    // A path that runs well past the plane's edge.
    const points = [new Vector3(0, 0, 0), new Vector3(1000, 0, 0)];

    const samples = sampleElevationProfile(points, raycaster, tiles.group, 100);

    // Every returned sample's distance must be one the raycast actually hit —
    // none of them should silently claim elevation 0 for an off-tile miss.
    for (const s of samples) {
      expect(s.distanceAlongM).toBeLessThanOrEqual(150); // within the 200m-wide plane's reach
    }
    // Fewer samples than the naive spacing count (1000/100 + 1 = 11) — some were dropped.
    expect(samples.length).toBeLessThan(11);
  });
});

describe('isNoGo / SLOPE_NOGO_THRESHOLD_PERCENT', () => {
  it('flags a slope past the threshold in either direction', () => {
    expect(isNoGo(SLOPE_NOGO_THRESHOLD_PERCENT + 1)).toBe(true);
    expect(isNoGo(-(SLOPE_NOGO_THRESHOLD_PERCENT + 1))).toBe(true);
    expect(isNoGo(SLOPE_NOGO_THRESHOLD_PERCENT - 1)).toBe(false);
  });
});

describe('estimateMoveTimeMinutes (invariant 3 — pure function of length + rate)', () => {
  it('computes time from length and the named rate table, no hidden default', () => {
    // 4 km at the dismounted rate (4 km/h) = 60 minutes.
    expect(estimateMoveTimeMinutes(4000, 'dismounted')).toBeCloseTo(60, 1);
    // 25 km at the mounted rate (25 km/h) = 60 minutes.
    expect(estimateMoveTimeMinutes(25000, 'mounted')).toBeCloseTo(60, 1);
  });

  it('MOVE_RATES_KMH is a named table, not a magic literal at the call site', () => {
    expect(MOVE_RATES_KMH.dismounted).toBeGreaterThan(0);
    expect(MOVE_RATES_KMH.mounted).toBeGreaterThan(MOVE_RATES_KMH.dismounted);
  });
});

/**
 * Todo 31 — M2 route exposure. Covers the 4 stated invariants:
 * 1. `sampleRouteExposure` is a pure function of (points, threatEye, spacing) given a
 *    raycaster/tiles.
 * 2. Reuses `raycastLosBlockingHit` — the EXACT same primitive `buildLosGroup` uses.
 * 3. The colour convention is documented as inverted from `buildLosGroup`'s own framing
 *    (verified here by asserting the SEMANTICS: visible-to-threat = exposed = bad).
 * 4. Every displayed summary states its basis (verified at the WorldView level, not here).
 */
describe('sampleRouteExposure (invariants 1 + 2)', () => {
  it('marks every sample exposed when nothing blocks the threat (pure, no tiles obstacles)', () => {
    const tiles = new TilesRenderer();
    tiles.group.raycast = Group.prototype.raycast; // empty — nothing to hit
    const raycaster = new Raycaster();
    const points = [new Vector3(0, 0, 0), new Vector3(200, 0, 0)];
    const threatEye = new Vector3(100, 0, -50);

    const samples = sampleRouteExposure(points, threatEye, raycaster, tiles.group, 50);

    expect(samples.length).toBeGreaterThan(0);
    for (const s of samples) expect(s.visibleToThreat).toBe(true);
  });

  it('marks samples behind a wall as NOT visible to the threat (reuses the LOS raycast)', () => {
    const tiles = new TilesRenderer();
    tiles.group.raycast = Group.prototype.raycast;
    // A wall standing at x=50, spanning Y/Z (rotated 90° about Y — same construction as
    // the proven `buildLosGroup` "reports blocked" test in `strategist.planFeature.test.ts`):
    // it blocks any ray from the threat at x=0 crossing x=50 en route to a farther point,
    // but a ray to a NEARER point (target x < 50) never reaches the wall.
    const wall = new Mesh(new PlaneGeometry(200, 200), new MeshBasicMaterial({ side: DoubleSide }));
    wall.rotation.y = Math.PI / 2;
    wall.position.set(50, 0, 0);
    tiles.group.add(wall);
    wall.updateMatrixWorld(true);

    const raycaster = new Raycaster();
    // Path starts just off the threat's own position (avoids the degenerate zero-distance
    // sample) and runs well past the wall.
    const points = [new Vector3(10, 0, 0), new Vector3(200, 0, 0)];
    const threatEye = new Vector3(0, 0, 0);

    const samples = sampleRouteExposure(points, threatEye, raycaster, tiles.group, 25);

    const nearSamples = samples.filter((s) => s.point.x < 40);
    const farSamples = samples.filter((s) => s.point.x > 60);
    expect(nearSamples.length).toBeGreaterThan(0);
    expect(farSamples.length).toBeGreaterThan(0);
    for (const s of nearSamples) expect(s.visibleToThreat).toBe(true);
    for (const s of farSamples) expect(s.visibleToThreat).toBe(false);
  });

  it('returns an empty profile for a degenerate path', () => {
    const tiles = new TilesRenderer();
    tiles.group.raycast = Group.prototype.raycast;
    const raycaster = new Raycaster();
    expect(
      sampleRouteExposure([new Vector3(0, 0, 0)], new Vector3(0, 0, 0), raycaster, tiles.group, 25)
    ).toEqual([]);
  });
});

describe('exposureFraction', () => {
  it('computes the fraction of samples visible to the threat', () => {
    const samples = [
      { distanceAlongM: 0, point: { x: 0, y: 0, z: 0 }, visibleToThreat: true },
      { distanceAlongM: 10, point: { x: 10, y: 0, z: 0 }, visibleToThreat: true },
      { distanceAlongM: 20, point: { x: 20, y: 0, z: 0 }, visibleToThreat: false },
      { distanceAlongM: 30, point: { x: 30, y: 0, z: 0 }, visibleToThreat: false },
    ];
    expect(exposureFraction(samples)).toBeCloseTo(0.5, 5);
  });

  it('is 0 for an empty sample set (not NaN)', () => {
    expect(exposureFraction([])).toBe(0);
  });
});

describe('buildRouteExposureGroup', () => {
  it('emits one band segment per consecutive sample pair', () => {
    const samples = [
      { distanceAlongM: 0, point: { x: 0, y: 0, z: 0 }, visibleToThreat: true },
      { distanceAlongM: 20, point: { x: 20, y: 0, z: 0 }, visibleToThreat: false },
      { distanceAlongM: 40, point: { x: 40, y: 0, z: 0 }, visibleToThreat: true },
    ];
    const group = buildRouteExposureGroup(samples);
    expect(group.children.length).toBe(2); // 3 samples -> 2 segments
  });
});
