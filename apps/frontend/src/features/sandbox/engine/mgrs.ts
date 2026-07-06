import { forward } from 'mgrs';

import type { GeoPosition } from './geoFrame';

import { SANDBOX_MISC } from '@/constants';

/** Converts a geo position to an MGRS grid-reference string via the `mgrs` library
 * (rules/dependencies.md — no hand-rolled ellipsoidal grid math). `accuracy` follows the
 * library's convention: 5 digits = 1 m, down to 0 = 100 km; default 5. */
export function toMgrs(
  geo: Pick<GeoPosition, 'lat' | 'lon'>,
  accuracy = SANDBOX_MISC.MGRS_PRECISION
): string {
  return forward([geo.lon, geo.lat], accuracy);
}
