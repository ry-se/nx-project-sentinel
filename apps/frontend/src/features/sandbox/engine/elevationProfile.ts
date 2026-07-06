import { type Object3D, type Raycaster, Vector3 } from 'three';

import { groundWalkEyeY } from './groundWalk';
import { pathLength } from './planFeature';

/** Sample spacing along a path (metres) — a named constant, not a magic literal at the
 * call site (Wave-4 invariant, same convention as `briefPlayback.ts`'s
 * `BRIEF_TRANSITION_DURATION_MS`). */
export const ELEVATION_SAMPLE_SPACING_M = 20;

/** Slope past which a leg is shaded no-go (todo 29 scope) — a representative dismounted/
 * light-vehicle threshold, not a fabricated number (~30% ≈ 17°, commonly cited as the
 * grade past which unassisted vehicle movement becomes marginal). */
export const SLOPE_NOGO_THRESHOLD_PERCENT = 30;

export function isNoGo(slopePercent: number): boolean {
  return Math.abs(slopePercent) > SLOPE_NOGO_THRESHOLD_PERCENT;
}

export interface ElevationSample {
  distanceAlongM: number;
  elevationM: number;
  /** Slope from the PREVIOUS sample to this one; 0 for the first sample (no prior leg). */
  slopePercent: number;
}

/**
 * Walks `points` (a path's local-frame polyline) at fixed `spacingM`, raycasting straight
 * down at each sample to read terrain elevation — reuses `groundWalk.ts`'s
 * `groundWalkEyeY` at `eyeHeight=0` (the same "raycast down, read surface Y" primitive
 * `groundWalk` already implements) rather than a new raycast helper. A sample the raycast
 * misses (off the loaded tile area) is DROPPED from the result, never fabricated as
 * elevation 0 (invariant 2 — a gap is more honest than a flat, wrong-looking profile).
 */
export function sampleElevationProfile(
  points: Vector3[],
  raycaster: Raycaster,
  tiles: Object3D,
  spacingM: number = ELEVATION_SAMPLE_SPACING_M
): ElevationSample[] {
  if (points.length < 2 || spacingM <= 0) return [];
  const totalLength = pathLength(points);
  if (totalLength <= 0) return [];

  const distances: number[] = [];
  for (let d = 0; d < totalLength; d += spacingM) distances.push(d);
  if (distances[distances.length - 1] !== totalLength) distances.push(totalLength);

  const samples: ElevationSample[] = [];
  let lastElevation: number | null = null;
  let lastDistance = 0;
  for (const d of distances) {
    const point = pointAtDistance(points, d, totalLength);
    if (!point) continue;
    const elevation = groundWalkEyeY(raycaster, tiles, point.x, point.z, 0);
    if (elevation === null) continue;
    const slopePercent =
      lastElevation === null
        ? 0
        : ((elevation - lastElevation) / Math.max(d - lastDistance, 1e-6)) * 100;
    samples.push({ distanceAlongM: d, elevationM: elevation, slopePercent });
    lastElevation = elevation;
    lastDistance = d;
  }
  return samples;
}

/** The point `distanceM` along a polyline (linear interpolation within the containing
 * segment), or `null` past the path's total length. */
function pointAtDistance(
  points: Vector3[],
  distanceM: number,
  totalLength: number
): Vector3 | null {
  if (distanceM > totalLength + 1e-6) return null;
  let remaining = Math.min(distanceM, totalLength);
  for (let i = 1; i < points.length; i++) {
    const segLength = points[i].distanceTo(points[i - 1]);
    if (remaining <= segLength || i === points.length - 1) {
      const t = segLength < 1e-9 ? 0 : Math.min(remaining / segLength, 1);
      return points[i - 1].clone().lerp(points[i], t);
    }
    remaining -= segLength;
  }
  return points[points.length - 1].clone();
}

// ---------- move timing (todo 29 / M4) ----------

export type MoveRate = 'dismounted' | 'mounted';

/** Representative march rates (km/h) — dismounted: standard foot-march pace on
 * unimproved terrain; mounted: cross-country vehicle rate, unimproved terrain. Neither is
 * a doctrinal guarantee — the UI states the assumed rate explicitly (Gate 5). */
export const MOVE_RATES_KMH: Record<MoveRate, number> = {
  dismounted: 4,
  mounted: 25,
};

export function estimateMoveTimeMinutes(pathLengthM: number, rate: MoveRate): number {
  const rateKmh = MOVE_RATES_KMH[rate];
  const lengthKm = pathLengthM / 1000;
  return (lengthKm / rateKmh) * 60;
}
