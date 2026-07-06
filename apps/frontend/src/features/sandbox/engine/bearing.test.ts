import { Group, Vector3 } from 'three';
import { TilesRenderer } from '3d-tiles-renderer';

import { computeBearingDeg, degToMils, formatBearing } from './planFeature';
import { GeoFrame } from './geoFrame';

/**
 * Todo 16: degrees->mils conversion at the four cardinals (invariant 4), grid-bearing
 * computed via `geoFrame.compassHeadingDeg` (invariant 1 — never a raw local-frame
 * `atan2`), and the north reference stated in the formatted readout (invariant 3).
 */

function bareTiles(): TilesRenderer {
  const tiles = new TilesRenderer();
  tiles.group.raycast = Group.prototype.raycast;
  return tiles;
}

const ANCHOR = { lat: 1.35, lon: 103.8 };

describe('degToMils — the four cardinals', () => {
  it.each([
    [0, 0],
    [90, 1600],
    [180, 3200],
    [270, 4800],
    [360, 6400],
  ])('%d° = %d mils', (deg, mils) => {
    expect(degToMils(deg)).toBe(mils);
  });
});

describe('computeBearingDeg — delegates to geoFrame.compassHeadingDeg, not a raw local atan2', () => {
  it('matches calling compassHeadingDeg directly with the same direction vector', () => {
    const tiles = bareTiles();
    const geoFrame = new GeoFrame(tiles, ANCHOR);
    const from = new Vector3(10, 0, 5);
    const to = new Vector3(40, 0, 30);
    const direction = new Vector3(to.x - from.x, 0, to.z - from.z);

    expect(computeBearingDeg(from, to, geoFrame)).toBe(geoFrame.compassHeadingDeg(direction));
  });

  it('is unaffected by a Y (vertical) difference between the two points', () => {
    const tiles = bareTiles();
    const geoFrame = new GeoFrame(tiles, ANCHOR);
    const level = computeBearingDeg(new Vector3(0, 0, 0), new Vector3(30, 0, 40), geoFrame);
    const sloped = computeBearingDeg(new Vector3(0, 5, 0), new Vector3(30, 80, 40), geoFrame);
    expect(sloped).toBeCloseTo(level, 6);
  });

  it('bearing is symmetric: reversing from/to flips it by ~180°', () => {
    const tiles = bareTiles();
    const geoFrame = new GeoFrame(tiles, ANCHOR);
    const a = new Vector3(0, 0, 0);
    const b = new Vector3(30, 0, 40);
    const forward = computeBearingDeg(a, b, geoFrame);
    const reverse = computeBearingDeg(b, a, geoFrame);
    const delta = (((forward - reverse) % 360) + 360) % 360;
    expect(Math.abs(delta - 180)).toBeLessThan(0.01);
  });
});

describe('formatBearing — states the north reference (invariant 3)', () => {
  it('includes a "G" (grid) marker alongside degrees and mils', () => {
    const text = formatBearing(95);
    expect(text).toContain('°G/');
    expect(text).toContain('mils');
    expect(text).toBe('095°G/1689 mils');
  });

  it('degrees are zero-padded to 3 digits', () => {
    expect(formatBearing(5)).toMatch(/^005°G\//);
  });
});
