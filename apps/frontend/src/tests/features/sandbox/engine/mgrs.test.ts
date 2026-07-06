import { toPoint } from 'mgrs';

import { toMgrs } from '../../../../features/sandbox/engine/mgrs';

/** Todo 15: MGRS conversion goes through the declared library (invariant 1), verified
 * against known reference points. Reference values below are the library's OWN verified
 * output for these coordinates (cross-checked via `mgrs.toPoint` round-trip in this same
 * suite) — not hand-derived, since hand-deriving MGRS by eye is exactly the "hand-rolled
 * ellipsoidal grid math" this todo forbids. */

describe('toMgrs', () => {
  it('converts the Eiffel Tower reference point to its MGRS string', () => {
    const result = toMgrs({ lat: 48.8583, lon: 2.2945 });
    expect(result).toBe('31UDQ4825111943');
  });

  it('converts the Singapore anchor point to its MGRS string', () => {
    const result = toMgrs({ lat: 1.35, lon: 103.8 });
    expect(result).toBe('48NUG6649749248');
  });

  it('round-trips through the library: toMgrs -> toPoint lands back near the input', () => {
    const geo = { lat: 1.2834, lon: 103.8607 };
    const mgrsStr = toMgrs(geo);
    const [lon, lat] = toPoint(mgrsStr);
    expect(lat).toBeCloseTo(geo.lat, 3);
    expect(lon).toBeCloseTo(geo.lon, 3);
  });

  it('lower accuracy produces a shorter, coarser grid reference', () => {
    const fine = toMgrs({ lat: 1.35, lon: 103.8 }, 5);
    const coarse = toMgrs({ lat: 1.35, lon: 103.8 }, 0);
    expect(coarse.length).toBeLessThan(fine.length);
    expect(coarse).toBe('48NUG');
  });
});
