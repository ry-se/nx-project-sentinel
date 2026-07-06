import { Group, Raycaster, Vector3 } from 'three';
import { TilesRenderer } from '3d-tiles-renderer';

import { GeoFrame } from '../../../../features/sandbox/engine/geoFrame';
import { type PlanFeatureType, rebuildFeature, serializeFeature } from '../../../../features/sandbox/engine/planFeature';

/**
 * Todo 13: control-measure round-trip proof. Same pattern as
 * strategist.planFeature.test.ts — serializeFeature -> rebuildFeature must render an
 * equivalent group for each of the 5 new types, and each MUST be a distinct
 * `PlanFeature.type` (invariant 1) so phasing/export can treat them individually.
 */

function fakeCanvasContext() {
  const measureText = () => ({ width: 42 });
  return new Proxy(
    { measureText },
    { get: (target, prop) => (prop in target ? (target as never)[prop] : vi.fn()) }
  );
}

function bareTiles(): TilesRenderer {
  const tiles = new TilesRenderer();
  tiles.group.raycast = Group.prototype.raycast;
  return tiles;
}

const ANCHOR = { lat: 1.35, lon: 103.8 };

const POINTS_BY_TYPE: Record<'boundary' | 'phaseline' | 'loa' | 'axis' | 'objective', Vector3[]> = {
  boundary: [new Vector3(0, 0, 0), new Vector3(50, 0, 10), new Vector3(90, 0, 40)],
  phaseline: [new Vector3(0, 0, 0), new Vector3(60, 0, 0)],
  loa: [new Vector3(0, 0, 0), new Vector3(40, 0, 30)],
  axis: [new Vector3(0, 0, 0), new Vector3(30, 0, 30), new Vector3(80, 0, 20)],
  objective: [new Vector3(25, 0, 25)],
};

describe('control measures — serializeFeature/rebuildFeature round-trip (todo 13)', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      fakeCanvasContext() as unknown as CanvasRenderingContext2D
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(Object.entries(POINTS_BY_TYPE) as Array<[PlanFeatureType, Vector3[]]>)(
    '%s: round-trips through serializeFeature -> rebuildFeature, and is a distinct type',
    (type, pts) => {
      const tiles = bareTiles();
      const geoFrame = new GeoFrame(tiles, ANCHOR);
      const raycaster = new Raycaster();

      const pf = serializeFeature(type, pts, `Test ${type}`, geoFrame);
      expect(pf.type).toBe(type);
      expect(pf.points.local).toEqual(pts.map((p) => ({ x: p.x, y: p.y, z: p.z })));

      const rebuiltOnce = rebuildFeature(pf, { raycaster, tiles: tiles.group, geoFrame });
      const rebuiltTwice = rebuildFeature(pf, { raycaster, tiles: tiles.group, geoFrame });

      expect(rebuiltOnce).toBeInstanceOf(Group);
      expect(rebuiltOnce.children.length).toBeGreaterThan(0);
      expect(rebuiltTwice.children.length).toBe(rebuiltOnce.children.length);

      // Named measures carry the name into the label sprite (invariant 5 — captured at
      // draw time), except objective's dedicated "OBJ <name>" and axis's "AXIS <name>"
      // labels, which are asserted structurally (a Sprite exists) rather than by exact text.
      const hasLabel = (g: typeof rebuiltOnce) => g.children.some((c) => c.type === 'Sprite');
      expect(hasLabel(rebuiltOnce)).toBe(true);
    }
  );

  it('axis of advance includes a width-corridor band in addition to the centerline + arrowhead', () => {
    const tiles = bareTiles();
    const geoFrame = new GeoFrame(tiles, ANCHOR);
    const pf = serializeFeature('axis', POINTS_BY_TYPE.axis, 'Test axis', geoFrame);
    const g = rebuildFeature(pf, { raycaster: new Raycaster(), tiles: tiles.group, geoFrame });

    // 1 centerline (Line) + 2 band segments (Mesh, one per pair of the 3 points) +
    // 1 arrowhead (Mesh) + 3 point markers (Mesh) + 1 label (Sprite) = 8 children.
    expect(g.children.length).toBe(8);
  });

  it('linear measure types (boundary/phaseline/loa) each produce a visually distinct group', () => {
    const tiles = bareTiles();
    const geoFrame = new GeoFrame(tiles, ANCHOR);
    const raycaster = new Raycaster();

    const types: Array<'boundary' | 'phaseline' | 'loa'> = ['boundary', 'phaseline', 'loa'];
    const colors = types.map((type) => {
      const pf = serializeFeature(type, POINTS_BY_TYPE[type], `Test ${type}`, geoFrame);
      const g = rebuildFeature(pf, { raycaster, tiles: tiles.group, geoFrame });
      const line = g.children.find((c) => c.type === 'Line') as unknown as {
        material: { color: { getHex(): number } };
      };
      return line.material.color.getHex();
    });
    // Each type MUST use a distinct color (invariant 1 — distinct types, not lumped visuals).
    expect(new Set(colors).size).toBe(types.length);
  });
});
