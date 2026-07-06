import { ASSUMED_PIXEL_ERROR_PX, estimateGeoUncertaintyM } from './createSandbox';

/** Regression guard for todo W4 (geolocation uncertainty estimate). Pure math — no
 * Three.js scene needed. Exercises the documented pixel-error x range x obliquity
 * formula directly rather than asserting an opaque magic number. */
describe('estimateGeoUncertaintyM', () => {
  it('scales linearly with range at a fixed FOV/obliquity (nadir-ish ray)', () => {
    // Larger absolute values keep the 1-decimal rounding noise well under 1% of the
    // compared magnitude — small ranges (e.g. 100 vs 1000) amplify that noise.
    const near = estimateGeoUncertaintyM(1000, 60, 1000, -1);
    const far = estimateGeoUncertaintyM(10000, 60, 1000, -1);
    expect(far).toBeCloseTo(near * 10, -1);
  });

  it('matches the documented pixel-error x ground-sample-distance formula', () => {
    const range = 500;
    const fovDeg = 60;
    const imageHeightPx = 1000;
    const rayDirY = -1; // near-nadir, obliquity floor doesn't kick in

    const fovRad = (fovDeg * Math.PI) / 180;
    const metersPerPixel = (2 * range * Math.tan(fovRad / 2)) / imageHeightPx;
    const expected = Math.round(metersPerPixel * ASSUMED_PIXEL_ERROR_PX * 10) / 10;

    expect(estimateGeoUncertaintyM(range, fovDeg, imageHeightPx, rayDirY)).toBe(expected);
  });

  it('a grazing (near-horizontal) ray produces a larger uncertainty than a nadir ray at the same range', () => {
    const nadir = estimateGeoUncertaintyM(500, 60, 1000, -0.95);
    const grazing = estimateGeoUncertaintyM(500, 60, 1000, -0.1);
    expect(grazing).toBeGreaterThan(nadir);
  });

  it('the obliquity correction is floored — a near-zero rayDirY does not blow up unboundedly', () => {
    const flooredAtZero = estimateGeoUncertaintyM(500, 60, 1000, 0);
    const flooredAtFloor = estimateGeoUncertaintyM(500, 60, 1000, 0.15);
    expect(flooredAtZero).toBe(flooredAtFloor);
    expect(Number.isFinite(flooredAtZero)).toBe(true);
  });

  it('returns a positive, rounded-to-1-decimal number for realistic capture geometry', () => {
    const result = estimateGeoUncertaintyM(300, 60, 1200, -0.8);
    expect(result).toBeGreaterThan(0);
    expect(result).toBe(Math.round(result * 10) / 10);
  });

  it('a zero image height stays finite instead of producing Infinity — regression guard', () => {
    const result = estimateGeoUncertaintyM(500, 60, 0, -1);
    expect(Number.isFinite(result)).toBe(true);
  });
});
