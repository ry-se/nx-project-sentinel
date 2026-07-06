import { Group, Raycaster, Vector3 } from 'three';
import { TilesRenderer } from '3d-tiles-renderer';

import { GeoFrame } from './geoFrame';
import { rebuildFeature, serializeFeature } from './planFeature';
import {
  type Affiliation,
  AFFILIATION_COLOR,
  buildUnitSymbolGroup,
  type Echelon,
  echelonTickCount,
  readUnitMetadata,
} from './unitSymbol';

/** Todo 14: affiliation drives color deterministically (invariant 1); echelon ticks are
 * monotonic team->brigade; the `PlanFeature type:'unit'` round-trip carries
 * affiliation+echelon through metadata (invariant 2). */

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

describe('unitSymbol — affiliation color + echelon ticks', () => {
  it('affiliation maps to a fixed color — friendly=blue, enemy=red, neutral=green', () => {
    expect(AFFILIATION_COLOR.friendly).toBe(0x2979ff);
    expect(AFFILIATION_COLOR.enemy).toBe(0xe53935);
    expect(AFFILIATION_COLOR.neutral).toBe(0x43a047);
  });

  it('echelon tick count increases monotonically team -> brigade', () => {
    const order: Echelon[] = [
      'team',
      'squad',
      'section',
      'platoon',
      'company',
      'battalion',
      'brigade',
    ];
    const counts = order.map(echelonTickCount);
    expect(counts).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('readUnitMetadata falls back to safe defaults on missing/malformed metadata', () => {
    expect(readUnitMetadata({})).toEqual({ affiliation: 'friendly', echelon: 'platoon' });
    expect(readUnitMetadata({ affiliation: 'not-a-real-affiliation' })).toEqual({
      affiliation: 'friendly',
      echelon: 'platoon',
    });
    expect(readUnitMetadata({ affiliation: 'enemy', echelon: 'brigade' })).toEqual({
      affiliation: 'enemy',
      echelon: 'brigade',
    });
  });

  it('regression: an Object.prototype-inherited key does NOT pass the affiliation whitelist', () => {
    // The whitelist check must use hasOwnProperty, not `in` (which walks the prototype
    // chain) — "toString"/"constructor" are `in` any plain object but are not real
    // affiliations. Security-review finding, Wave 4.
    expect(readUnitMetadata({ affiliation: 'toString' })).toEqual({
      affiliation: 'friendly',
      echelon: 'platoon',
    });
    expect(readUnitMetadata({ affiliation: 'constructor' })).toEqual({
      affiliation: 'friendly',
      echelon: 'platoon',
    });
  });
});

describe('unit symbol — serializeFeature/rebuildFeature round-trip (todo 14)', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      fakeCanvasContext() as unknown as CanvasRenderingContext2D
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each<[Affiliation, Echelon]>([
    ['friendly', 'platoon'],
    ['enemy', 'section'],
  ])(
    '%s %s: metadata round-trips through serializeFeature -> rebuildFeature',
    (affiliation, echelon) => {
      const tiles = bareTiles();
      const geoFrame = new GeoFrame(tiles, ANCHOR);
      const point = new Vector3(10, 0, 10);

      const pf = serializeFeature('unit', [point], '2 PL', geoFrame, { affiliation, echelon });
      expect(pf.type).toBe('unit');
      expect(pf.metadata).toEqual({ affiliation, echelon });

      const rebuilt = rebuildFeature(pf, {
        raycaster: new Raycaster(),
        tiles: tiles.group,
        geoFrame,
      });
      expect(rebuilt).toBeInstanceOf(Group);
      expect(rebuilt.children.some((c) => c.type === 'Sprite')).toBe(true);
    }
  );

  it('builds directly via buildUnitSymbolGroup with a placed sprite above the point', () => {
    const point = new Vector3(5, 0, 5);
    const g = buildUnitSymbolGroup(point, 'friendly', 'company', '1 CO');
    const sprite = g.children[0];
    expect(sprite.type).toBe('Sprite');
    expect(sprite.position.y).toBeGreaterThan(point.y);
  });
});
