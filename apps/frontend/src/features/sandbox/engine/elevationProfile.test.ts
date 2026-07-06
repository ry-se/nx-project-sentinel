import { TilesRenderer } from '3d-tiles-renderer';
import { Group, Mesh, MeshBasicMaterial, PlaneGeometry, Raycaster, Vector3 } from 'three';

import {
  estimateMoveTimeMinutes,
  isNoGo,
  MOVE_RATES_KMH,
  SLOPE_NOGO_THRESHOLD_PERCENT,
  sampleElevationProfile,
} from './elevationProfile';

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
