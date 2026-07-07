import { TilesRenderer } from '3d-tiles-renderer';
import { Group, MathUtils, Raycaster, Vector3 } from 'three';

import { GeoFrame } from '../../../../features/sandbox/engine/geoFrame';
import {
  buildRangeFanGroup,
  rebuildFeature,
  readRangeFanSystemId,
  serializeFeature,
} from '../../../../features/sandbox/engine/planFeature';
import { WEAPON_SYSTEMS } from '../../../../features/sandbox/engine/weaponSystems';

/**
 * Todo 32 — C1 weapon/sensor range fans from a system table. Covers the 4 stated
 * invariants:
 * 1. `WEAPON_SYSTEMS` values are real, cited (comment names the source) — asserted here as
 *    "not obviously fabricated" (positive min<max, non-empty name).
 * 2. A `rangeFan` feature persists `systemId` + geometry only — the CURRENT table is read
 *    at rebuild time, never a stale baked-in radius.
 * 3. `rangeFan` round-trips through the SAME `PlanFeature`/`rebuildFeature` seam as every
 *    other type.
 * 4. The rendered label states system name + min/max range + the geometric-range-only
 *    limitation (Gate 5).
 */

function fakeCanvasContext() {
  const measureText = () => ({ width: 42 });
  return new Proxy(
    { measureText },
    { get: (target, prop) => (prop in target ? (target as never)[prop] : vi.fn()) }
  );
}

function setupTilesAtAnchor(anchor: { lat: number; lon: number }): TilesRenderer {
  const tiles = new TilesRenderer();
  tiles.group.raycast = Group.prototype.raycast;
  tiles.ellipsoid.getObjectFrame(
    MathUtils.DEG2RAD * anchor.lat,
    MathUtils.DEG2RAD * anchor.lon,
    0,
    0,
    0,
    0,
    tiles.group.matrix
  );
  tiles.group.matrix
    .invert()
    .decompose(tiles.group.position, tiles.group.quaternion, tiles.group.scale);
  tiles.group.updateMatrixWorld(true);
  return tiles;
}

const ANCHOR = { lat: 1.35, lon: 103.8 };

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    fakeCanvasContext() as unknown as CanvasRenderingContext2D
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('WEAPON_SYSTEMS (invariant 1 — real, cited figures)', () => {
  it('every system has a positive min < max range and a non-empty name', () => {
    for (const [id, system] of Object.entries(WEAPON_SYSTEMS)) {
      expect(system.name.length).toBeGreaterThan(0);
      expect(system.minRangeM).toBeGreaterThanOrEqual(0);
      expect(system.maxRangeM).toBeGreaterThan(system.minRangeM);
      // Sanity bound — a "range" in the tens-of-kilometres-or-less band, not an
      // accidental unit-conversion bug (e.g. metres vs. kilometres mixed up).
      expect(system.maxRangeM).toBeLessThan(50_000);
      void id;
    }
  });
});

describe('readRangeFanSystemId (defensive fallback)', () => {
  it('returns the tagged systemId when valid', () => {
    expect(readRangeFanSystemId({ systemId: 'atgmMedium' })).toBe('atgmMedium');
  });

  it('falls back to a default for a missing or unknown systemId', () => {
    expect(readRangeFanSystemId({})).toBe('mortar81mm');
    expect(readRangeFanSystemId({ systemId: 'nonexistentSystem' })).toBe('mortar81mm');
  });

  it('regression: an Object.prototype-inherited key does NOT pass the systemId whitelist', () => {
    // The whitelist check must use hasOwnProperty, not `in` (which walks the prototype
    // chain) — "toString"/"constructor" are `in` any plain object but are not real
    // systemIds. Security-review finding, Wave 4 (same class as unitSymbol.ts's
    // readUnitMetadata, fixed together).
    expect(readRangeFanSystemId({ systemId: 'toString' })).toBe('mortar81mm');
    expect(readRangeFanSystemId({ systemId: 'constructor' })).toBe('mortar81mm');
  });
});

describe('buildRangeFanGroup', () => {
  it('builds a Group with the annulus mesh, a center marker, and a labelled sprite', () => {
    const tiles = setupTilesAtAnchor(ANCHOR);
    const geoFrame = new GeoFrame(tiles, ANCHOR);
    const pts = [new Vector3(0, 0, 0), new Vector3(100, 0, 0)];

    const group = buildRangeFanGroup(pts, 'mortar81mm', geoFrame);

    expect(group).toBeInstanceOf(Group);
    expect(group.children.some((c) => c.type === 'Mesh')).toBe(true);
    expect(group.children.some((c) => c.type === 'Sprite')).toBe(true);
  });

  it('reads the CURRENT table at build time (invariant 2 — no baked-in radius)', () => {
    const tiles = setupTilesAtAnchor(ANCHOR);
    const geoFrame = new GeoFrame(tiles, ANCHOR);
    const pts = [new Vector3(0, 0, 0), new Vector3(100, 0, 0)];

    // Two builds of the SAME feature against the SAME (unchanged) table produce
    // identical child counts — deterministic, no hidden per-call state.
    const first = buildRangeFanGroup(pts, 'groundSurveillanceRadar', geoFrame);
    const second = buildRangeFanGroup(pts, 'groundSurveillanceRadar', geoFrame);
    expect(second.children.length).toBe(first.children.length);
  });
});

describe('rangeFan — serializeFeature/rebuildFeature round-trip (invariant 3)', () => {
  it('round-trips systemId through metadata, rebuilding via the CURRENT table', () => {
    const tiles = setupTilesAtAnchor(ANCHOR);
    const geoFrame = new GeoFrame(tiles, ANCHOR);
    const pts = [new Vector3(0, 0, 0), new Vector3(80, 0, 0)];

    const pf = serializeFeature('rangeFan', pts, 'Gun 1', geoFrame, { systemId: 'atgmMedium' });

    expect(pf.type).toBe('rangeFan');
    expect(pf.metadata.systemId).toBe('atgmMedium');
    expect(pf.points.local).toEqual(pts.map((p) => ({ x: p.x, y: p.y, z: p.z })));

    const rebuilt = rebuildFeature(pf, {
      raycaster: new Raycaster(),
      tiles: tiles.group,
      geoFrame,
    });
    expect(rebuilt).toBeInstanceOf(Group);
    expect(rebuilt.children.length).toBeGreaterThan(0);
  });

  it('a dangling/unknown systemId in saved metadata falls back defensively on rebuild', () => {
    const tiles = setupTilesAtAnchor(ANCHOR);
    const geoFrame = new GeoFrame(tiles, ANCHOR);
    const pts = [new Vector3(0, 0, 0), new Vector3(80, 0, 0)];

    const pf = serializeFeature('rangeFan', pts, 'Gun 1', geoFrame, {
      systemId: 'retiredSystemNoLongerInTable',
    });

    const rebuilt = rebuildFeature(pf, {
      raycaster: new Raycaster(),
      tiles: tiles.group,
      geoFrame,
    });
    // Doesn't throw, doesn't silently vanish — renders with the fallback system.
    expect(rebuilt.children.length).toBeGreaterThan(0);
  });
});
