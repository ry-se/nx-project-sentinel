import { TilesRenderer } from '3d-tiles-renderer';
import { OBJECT_FRAME } from '3d-tiles-renderer/three';
import {
  DoubleSide,
  Group,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Raycaster,
  Vector3,
} from 'three';

import { GeoFrame } from './geoFrame';
import {
  buildLosGroup,
  type PlanFeatureType,
  rebuildFeature,
  serializeFeature,
} from './planFeature';

/**
 * Todo 11: `serializeFeature`/`rebuildFeature` round-trip proof for each of the 4
 * measurement-tool types, plus the LOS blocked/clear raycast behavior the refactor
 * (private `buildLosGroup` -> pure exported function) must not regress.
 */

function fakeCanvasContext() {
  const measureText = () => ({ width: 42 });
  return new Proxy(
    { measureText },
    { get: (target, prop) => (prop in target ? (target as never)[prop] : vi.fn()) }
  );
}

// Same anchor-recentering setup as createSandbox.deployE2E.test.ts — a bare TilesRenderer
// with standard Object3D raycasting restored, no WebGL/network needed.
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
    tiles.group.matrix,
    OBJECT_FRAME
  );
  tiles.group.matrix
    .invert()
    .decompose(tiles.group.position, tiles.group.quaternion, tiles.group.scale);
  tiles.group.updateMatrixWorld(true);
  return tiles;
}

const ANCHOR = { lat: 1.35, lon: 103.8 };

const POINTS_BY_TYPE: Record<PlanFeatureType, Vector3[]> = {
  distance: [new Vector3(0, 0, 0), new Vector3(50, 0, 0)],
  focus: [
    new Vector3(0, 0, 0),
    new Vector3(50, 0, 0),
    new Vector3(50, 0, 50),
    new Vector3(0, 0, 50),
  ],
  arc: [new Vector3(0, 0, 0), new Vector3(80, 0, 0), new Vector3(0, 0, 80)],
  los: [new Vector3(0, 0, 0), new Vector3(100, 0, 0)],
};

describe('planFeature — serializeFeature/rebuildFeature round-trip (todo 11)', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      fakeCanvasContext() as unknown as CanvasRenderingContext2D
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(Object.entries(POINTS_BY_TYPE) as Array<[PlanFeatureType, Vector3[]]>)(
    '%s: round-trips through serializeFeature -> rebuildFeature',
    (type, pts) => {
      const tiles = setupTilesAtAnchor(ANCHOR);
      const geoFrame = new GeoFrame(tiles, ANCHOR);
      const raycaster = new Raycaster();

      const pf = serializeFeature(type, pts, `Test ${type}`, geoFrame);

      // invariant 1 (type identity) + invariant 2 (geo captured at draw time, one source)
      expect(pf.type).toBe(type);
      expect(pf.points.local).toEqual(pts.map((p) => ({ x: p.x, y: p.y, z: p.z })));
      expect(pf.points.geo).toHaveLength(pts.length);
      for (const geo of pf.points.geo) {
        expect(geo.lat).toBeCloseTo(ANCHOR.lat, 1);
        expect(geo.lon).toBeCloseTo(ANCHOR.lon, 1);
      }

      const rebuiltOnce = rebuildFeature(pf, { raycaster, tiles: tiles.group, geoFrame });
      const rebuiltTwice = rebuildFeature(pf, { raycaster, tiles: tiles.group, geoFrame });

      expect(rebuiltOnce).toBeInstanceOf(Group);
      expect(rebuiltOnce.children.length).toBeGreaterThan(0);
      // Deterministic: the SAME PlanFeature rebuilds to an equivalent group every time —
      // same shape (child count, same presence of a text label sprite).
      expect(rebuiltTwice.children.length).toBe(rebuiltOnce.children.length);
      const hasLabel = (g: Group) => g.children.some((c) => c.type === 'Sprite');
      expect(hasLabel(rebuiltTwice)).toBe(hasLabel(rebuiltOnce));
    }
  );

  it('focus feature carries its name through the round-trip (visible in the extruded-area label)', () => {
    const tiles = setupTilesAtAnchor(ANCHOR);
    const geoFrame = new GeoFrame(tiles, ANCHOR);
    const pf = serializeFeature('focus', POINTS_BY_TYPE.focus, 'AO-Falcon', geoFrame);
    expect(pf.name).toBe('AO-Falcon');

    const rebuilt = rebuildFeature(pf, {
      raycaster: new Raycaster(),
      tiles: tiles.group,
      geoFrame,
    });
    expect(rebuilt.children.some((c) => c.type === 'Sprite')).toBe(true);
  });
});

/** An untransformed tiles group (identity matrix) — the anchor-recentering rotation
 * `setupTilesAtAnchor` applies is irrelevant to pure raycast-geometry tests and would
 * otherwise force reasoning about the ellipsoid frame's exact orientation just to place
 * a wall in the ray's path. */
function bareTiles(): TilesRenderer {
  const tiles = new TilesRenderer();
  tiles.group.raycast = Group.prototype.raycast;
  return tiles;
}

describe('buildLosGroup — blocked/clear raycast (unchanged by the pure-function extraction)', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      fakeCanvasContext() as unknown as CanvasRenderingContext2D
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports clear when nothing sits between observer and target', () => {
    const tiles = bareTiles(); // no mesh added — nothing to hit
    const result = buildLosGroup(
      new Vector3(0, 0, 0),
      new Vector3(100, 0, 0),
      true,
      new Raycaster(),
      tiles.group,
      new GeoFrame(tiles, ANCHOR)
    );
    expect(result.blocked).toBe(false);
    expect(result.distanceM).toBeCloseTo(100, 0);
  });

  it('reports blocked when a mesh intersects the observer-target ray', () => {
    const tiles = bareTiles();
    // A wall spanning the ray's path at x=50. DoubleSide so the intersection isn't
    // backface-culled regardless of which way the rotated plane's normal ends up facing.
    const wall = new Mesh(new PlaneGeometry(200, 200), new MeshBasicMaterial({ side: DoubleSide }));
    wall.rotation.y = Math.PI / 2;
    wall.position.set(50, 0, 0);
    tiles.group.add(wall);
    // `TilesGroup.updateMatrixWorld` (3d-tiles-renderer) only cascades to children when the
    // GROUP's own transform changed since last update ("children tiles will not move") — a
    // freshly-added child's matrixWorld is otherwise never recomputed. Update the child
    // directly so its position/rotation actually take effect.
    wall.updateMatrixWorld(true);

    const result = buildLosGroup(
      new Vector3(0, 0, 0),
      new Vector3(100, 0, 0),
      true,
      new Raycaster(),
      tiles.group,
      new GeoFrame(tiles, ANCHOR)
    );
    expect(result.blocked).toBe(true);
    expect(result.blockedAtM).toBeCloseTo(50, 0);
  });
});
