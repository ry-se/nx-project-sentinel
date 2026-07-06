import { Group, type Object3D, type Raycaster, Vector3 } from 'three';

import { groundWalkEyeY } from './groundWalk';
import {
  buildBandSegment,
  type LocalPoint,
  pathLength,
  raycastLosBlockingHit,
  toLocalPoint,
} from './planFeature';

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

// ---------- route exposure (todo 31 / M2) ----------

export interface ExposureSample {
  distanceAlongM: number;
  point: LocalPoint;
  /** `true` when the threat's raycast reaches this point unobstructed — i.e. the
   * point is EXPOSED (visible to the threat), not safe. */
  visibleToThreat: boolean;
}

/**
 * Samples `points` (a path's local-frame polyline) at fixed `spacingM` and, for each
 * sample, checks line-of-sight from `threatEye` via `raycastLosBlockingHit` — the EXACT
 * same raycast primitive `buildLosGroup` (the `los` tool) already uses, so this can never
 * silently drift from that implementation. `threatEye` is expected to already be the
 * threat unit's GROUND position (eye-height lift happens inside
 * `raycastLosBlockingHit`, same as every other LOS call site).
 */
export function sampleRouteExposure(
  points: Vector3[],
  threatEye: Vector3,
  raycaster: Raycaster,
  tiles: Object3D,
  spacingM: number = ELEVATION_SAMPLE_SPACING_M
): ExposureSample[] {
  if (points.length < 2 || spacingM <= 0) return [];
  const totalLength = pathLength(points);
  if (totalLength <= 0) return [];

  const distances: number[] = [];
  for (let d = 0; d < totalLength; d += spacingM) distances.push(d);
  if (distances[distances.length - 1] !== totalLength) distances.push(totalLength);

  const samples: ExposureSample[] = [];
  for (const d of distances) {
    const point = pointAtDistance(points, d, totalLength);
    if (!point) continue;
    const blocked = raycastLosBlockingHit(threatEye, point, raycaster, tiles) !== null;
    samples.push({ distanceAlongM: d, point: toLocalPoint(point), visibleToThreat: !blocked });
  }
  return samples;
}

/** Fraction (0-1) of samples visible to the threat — the Gate-5 summary number. */
export function exposureFraction(samples: ExposureSample[]): number {
  if (samples.length === 0) return 0;
  return samples.filter((s) => s.visibleToThreat).length / samples.length;
}

const EXPOSED_COLOR = 0xef5350;
const COVERED_COLOR = 0x66ff66;

/**
 * Renders the path as alternating red (exposed)/green (covered) segments — reuses
 * `buildAxisGroup`'s per-segment `buildBandSegment` band technique, just re-colored per
 * sample instead of one fixed axis color. NOTE the inverted framing vs. `buildLosGroup`'s
 * own clear/blocked convention: there, "clear" (unobstructed) renders GREEN because clear
 * means "you can see the target". Here, unobstructed (visible-to-threat) is BAD, so it
 * renders RED — same raycast primitive, opposite color meaning, because the two tools
 * answer different questions ("can I see it" vs. "can the threat see ME here").
 */
export function buildRouteExposureGroup(samples: ExposureSample[]): Group {
  const g = new Group();
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1].point;
    const curr = samples[i].point;
    const a = new Vector3(prev.x, prev.y, prev.z);
    const b = new Vector3(curr.x, curr.y, curr.z);
    const color = samples[i].visibleToThreat ? EXPOSED_COLOR : COVERED_COLOR;
    const band = buildBandSegment(a, b, 3, color);
    if (band) g.add(band);
  }
  return g;
}
