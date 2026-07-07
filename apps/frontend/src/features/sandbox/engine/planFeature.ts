import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  DoubleSide,
  EdgesGeometry,
  ExtrudeGeometry,
  Group,
  Line,
  LineBasicMaterial,
  LineDashedMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  Path,
  Raycaster,
  Shape,
  ShapeGeometry,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Vector3,
} from 'three';

import type { GeoFrame, GeoPosition } from './geoFrame';
import { buildUnitSymbolGroup, readUnitMetadata } from './unitSymbol';
import { type SystemId, WEAPON_SYSTEMS } from './weaponSystems';

import { SANDBOX_COMMON, SANDBOX_PLAN_FEATURE } from '@/constants/sandbox';

/** A JSON-safe stand-in for a Three.js `Vector3` — the shape every `PlanFeature` persists. */
export interface LocalPoint {
  x: number;
  y: number;
  z: number;
}

export type PlanFeatureType =
  | 'distance'
  | 'focus'
  | 'arc'
  | 'los'
  | 'boundary'
  | 'phaseline'
  | 'loa'
  | 'axis'
  | 'objective'
  | 'unit'
  | 'rangeFan';

/**
 * The single serializable representation every strategist plan feature flows through —
 * measurement tools today, control measures/units/etc. in later waves. Persistence,
 * export, and phasing all read this shape; nothing renders directly.
 */
export interface PlanFeature {
  id: string;
  type: PlanFeatureType;
  name: string;
  points: {
    local: LocalPoint[];
    geo: GeoPosition[];
  };
  style?: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export const EYE_HEIGHT = SANDBOX_PLAN_FEATURE.EYE_HEIGHT; // metres above clicked surface for LOS endpoints

export const MAT_MEASURE = new LineBasicMaterial({
  color: SANDBOX_PLAN_FEATURE.MEASURE_COLOR,
  depthTest: false,
  transparent: true,
});
export const MAT_LOS_CLEAR = new LineBasicMaterial({
  color: SANDBOX_PLAN_FEATURE.LOS_CLEAR_COLOR,
  depthTest: false,
  transparent: true,
});
export const MAT_LOS_BLOCKED = new LineBasicMaterial({
  color: SANDBOX_PLAN_FEATURE.LOS_BLOCKED_COLOR,
  depthTest: false,
  transparent: true,
});

// ---------- measurement helpers ----------

export function pathLength(pts: Vector3[]): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += pts[i].distanceTo(pts[i - 1]);
  return total;
}

export function shoelaceXZ(pts: Vector3[]): number {
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    sum += a.x * b.z - b.x * a.z;
  }
  return Math.abs(sum) / 2;
}

export function fmtDist(m: number): string {
  return m >= SANDBOX_COMMON.METERS_PER_KILOMETER
    ? `${(m / SANDBOX_COMMON.METERS_PER_KILOMETER).toFixed(2)} km`
    : `${m.toFixed(0)} m`;
}

export function fmtArea(m2: number): string {
  if (m2 >= SANDBOX_COMMON.SQUARE_METERS_PER_SQUARE_KILOMETER)
    return `${(m2 / SANDBOX_COMMON.SQUARE_METERS_PER_SQUARE_KILOMETER).toFixed(2)} km²`;
  if (m2 >= SANDBOX_COMMON.SQUARE_METERS_PER_HECTARE)
    return `${(m2 / SANDBOX_COMMON.SQUARE_METERS_PER_HECTARE).toFixed(1)} ha`;
  return `${m2.toFixed(0)} m²`;
}

export function marker(at: Vector3, color: number, size = 2): Mesh {
  const m = new Mesh(
    new SphereGeometry(
      size,
      SANDBOX_PLAN_FEATURE.MARKER_SEGMENTS,
      SANDBOX_PLAN_FEATURE.MARKER_SEGMENTS
    ),
    new MeshBasicMaterial({ color, depthTest: false, transparent: true })
  );
  m.position.copy(at);
  m.renderOrder = 1000;
  return m;
}

export function label(at: Vector3, text: string): Sprite {
  const lines = text.split('\n');
  const canvas = document.createElement('canvas');
  canvas.width = SANDBOX_PLAN_FEATURE.LABEL_CANVAS_WIDTH;
  canvas.height =
    SANDBOX_PLAN_FEATURE.LABEL_CANVAS_BASE_HEIGHT +
    lines.length * SANDBOX_PLAN_FEATURE.LABEL_LINE_HEIGHT;
  const ctx = canvas.getContext('2d')!;
  ctx.font = `bold ${SANDBOX_PLAN_FEATURE.LABEL_FONT_SIZE}px monospace`;
  ctx.textAlign = 'center';
  ctx.lineWidth = SANDBOX_PLAN_FEATURE.LABEL_STROKE_WIDTH;
  ctx.strokeStyle = 'rgba(0,0,0,0.9)';
  ctx.fillStyle = '#ffffff';
  lines.forEach((line, i) => {
    const y =
      SANDBOX_PLAN_FEATURE.LABEL_LINE_HEIGHT + i * SANDBOX_PLAN_FEATURE.LABEL_LINE_HEIGHT;
    ctx.strokeText(line, SANDBOX_PLAN_FEATURE.LABEL_CENTER_X, y);
    ctx.fillText(line, SANDBOX_PLAN_FEATURE.LABEL_CENTER_X, y);
  });

  const sprite = new Sprite(
    new SpriteMaterial({
      map: new CanvasTexture(canvas),
      depthTest: false,
      transparent: true,
    })
  );
  sprite.position.copy(at);
  const w = SANDBOX_PLAN_FEATURE.LABEL_SCALE_WIDTH;
  sprite.scale.set(w, w * (canvas.height / canvas.width), 1);
  sprite.renderOrder = 1001;
  return sprite;
}

// ---------- bearings (todo 16) ----------

/** Mils = degrees x 6400/360, rounded to whole mils (invariant 2). */
export function degToMils(deg: number): number {
  return Math.round(
    (deg * SANDBOX_PLAN_FEATURE.MILS_PER_CIRCLE) / SANDBOX_COMMON.DEGREES_FULL_CIRCLE
  );
}

/** True GRID bearing (0-360, 0 = grid north) of the direction from `from` to `to`, via
 * `geoFrame.compassHeadingDeg` — never a raw local-frame `atan2` (invariant 1), since the
 * tiles' local axes are not north-aligned. */
export function computeBearingDeg(from: Vector3, to: Vector3, geoFrame: GeoFrame): number {
  const dir = new Vector3(to.x - from.x, 0, to.z - from.z);
  return geoFrame.compassHeadingDeg(dir);
}

/** e.g. "095°G/1689 mils" — the "G" marks grid north explicitly (invariant 3: the north
 * reference MUST be stated wherever a bearing is shown). */
export function formatBearing(deg: number): string {
  const rounded = Math.round(deg) % SANDBOX_COMMON.DEGREES_FULL_CIRCLE;
  return `${rounded
    .toString()
    .padStart(SANDBOX_PLAN_FEATURE.BEARING_PAD_LENGTH, '0')}°G/${degToMils(deg)} mils`;
}

// ---------- pure group builders (data-in, Group-out — shared by live draft + rebuild) ----------

export function buildDistanceGroup(pts: Vector3[], geoFrame: GeoFrame): Group {
  const total = pathLength(pts);
  const bearing = computeBearingDeg(pts[0], pts[pts.length - 1], geoFrame);
  const g = new Group();
  const line = new Line(new BufferGeometry().setFromPoints(pts), MAT_MEASURE);
  line.renderOrder = 999;
  g.add(line);
  for (const p of pts) g.add(marker(p, SANDBOX_PLAN_FEATURE.MEASURE_COLOR));
  g.add(
    label(
      pts[pts.length - 1].clone().add(new Vector3(0, SANDBOX_PLAN_FEATURE.DISTANCE_LABEL_Y_OFFSET, 0)),
      `${fmtDist(total)} · ${formatBearing(bearing)}`
    )
  );
  return g;
}

export function buildFocusGroup(pts: Vector3[], name: string): Group {
  const minY = Math.min(...pts.map((p) => p.y));
  const maxY = Math.max(...pts.map((p) => p.y));
  const height = maxY - minY + SANDBOX_PLAN_FEATURE.FOCUS_HEIGHT_BUFFER;

  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cz = pts.reduce((s, p) => s + p.z, 0) / pts.length;

  const shape = new Shape();
  pts.forEach((p, i) => {
    const sx = p.x - cx;
    const sy = -(p.z - cz);
    if (i === 0) shape.moveTo(sx, sy);
    else shape.lineTo(sx, sy);
  });
  shape.closePath();

  const geo = new ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
  geo.rotateX(-Math.PI / 2);
  const mesh = new Mesh(
    geo,
    new MeshBasicMaterial({
      color: 0xffb74d,
      transparent: true,
      opacity: 0.16,
      side: DoubleSide,
      depthWrite: false,
    })
  );
  mesh.position.set(cx, minY - SANDBOX_PLAN_FEATURE.FOCUS_BASE_OFFSET, cz);

  const edges = new LineSegments(
    new EdgesGeometry(geo),
    new LineBasicMaterial({ color: 0xffb74d, transparent: true, opacity: 0.8 })
  );
  edges.position.copy(mesh.position);

  const areaM2 = shoelaceXZ(pts);
  const g = new Group();
  g.add(mesh, edges);
  g.add(
    label(new Vector3(cx, maxY + SANDBOX_PLAN_FEATURE.FOCUS_LABEL_Y_OFFSET, cz), `${name}\n${fmtArea(areaM2)}`)
  );
  return g;
}

export function buildArcGroup(pts: Vector3[]): Group {
  const [center, radiusPt, bearingPt] = pts;
  const r = Math.hypot(radiusPt.x - center.x, radiusPt.z - center.z);
  const a1 = Math.atan2(-(radiusPt.z - center.z), radiusPt.x - center.x);
  let a2 = Math.atan2(-(bearingPt.z - center.z), bearingPt.x - center.x);
  if (a2 <= a1) a2 += Math.PI * 2;

  const shape = new Shape();
  shape.moveTo(0, 0);
  shape.absarc(0, 0, r, a1, a2, false);
  shape.closePath();

  const geo = new ShapeGeometry(shape, SANDBOX_PLAN_FEATURE.ARC_SEGMENTS);
  geo.rotateX(-Math.PI / 2);
  const mesh = new Mesh(
    geo,
    new MeshBasicMaterial({
      color: SANDBOX_PLAN_FEATURE.ARC_COLOR,
      transparent: true,
      opacity: 0.22,
      side: DoubleSide,
      depthWrite: false,
    })
  );
  mesh.position.set(center.x, center.y + SANDBOX_PLAN_FEATURE.ARC_ELEVATION_OFFSET, center.z);

  const g = new Group();
  g.add(mesh);
  g.add(marker(center, SANDBOX_PLAN_FEATURE.ARC_COLOR));
  g.add(
    label(center.clone().add(new Vector3(0, SANDBOX_PLAN_FEATURE.ARC_LABEL_Y_OFFSET, 0)), `r=${fmtDist(r)}`)
  );
  return g;
}

// ---------- control measures (todo 13) ----------

export type LinearMeasureType = 'boundary' | 'phaseline' | 'loa';

const LINEAR_MEASURE_STYLE: Record<LinearMeasureType, { color: number; dashed: boolean }> = {
  boundary: { color: 0xffffff, dashed: false },
  phaseline: { color: 0xffd54f, dashed: true },
  loa: { color: 0xff7043, dashed: true },
};

/** Boundary / phase line / limit-of-advance — a distinct color + dash pattern per type,
 * named at draw time (the label IS the name, unlike the anonymous measurement tools). */
export function buildLinearMeasureGroup(
  pts: Vector3[],
  type: LinearMeasureType,
  name: string
): Group {
  const { color, dashed } = LINEAR_MEASURE_STYLE[type];
  const geometry = new BufferGeometry().setFromPoints(pts);
  const material = dashed
    ? new LineDashedMaterial({
        color,
        dashSize: SANDBOX_PLAN_FEATURE.LINEAR_DASH_SIZE,
        gapSize: SANDBOX_PLAN_FEATURE.LINEAR_GAP_SIZE,
        depthTest: false,
        transparent: true,
      })
    : new LineBasicMaterial({ color, depthTest: false, transparent: true });
  const line = new Line(geometry, material);
  if (dashed) line.computeLineDistances();
  line.renderOrder = 999;

  const g = new Group();
  g.add(line);
  for (const p of pts) g.add(marker(p, color, SANDBOX_PLAN_FEATURE.LINEAR_MARKER_SIZE));
  g.add(
    label(pts[pts.length - 1].clone().add(new Vector3(0, SANDBOX_PLAN_FEATURE.LINEAR_LABEL_Y_OFFSET, 0)), name)
  );
  return g;
}

/** A flat translucent quad spanning `a`→`b`, offset perpendicular in the XZ plane by
 * `halfWidth` — built from explicit world-space triangles (not a rotated PlaneGeometry) so
 * there's no rotation-order math to get wrong for an arbitrary XZ heading. Exported for
 * reuse by todo 31 (Wave 4 M2 route-exposure overlay), which needs the SAME per-segment
 * band technique `buildAxisGroup` uses, just re-colored per segment. */
export function buildBandSegment(
  a: Vector3,
  b: Vector3,
  halfWidth: number,
  color: number
): Mesh | null {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz);
  if (len < SANDBOX_PLAN_FEATURE.BAND_EPSILON) return null;
  const px = (-dz / len) * halfWidth;
  const pz = (dx / len) * halfWidth;
  const y = (a.y + b.y) / 2 + SANDBOX_PLAN_FEATURE.BAND_ELEVATION_OFFSET;

  const positions = new Float32Array([
    a.x + px,
    y,
    a.z + pz,
    a.x - px,
    y,
    a.z - pz,
    b.x - px,
    y,
    b.z - pz,
    a.x + px,
    y,
    a.z + pz,
    b.x - px,
    y,
    b.z - pz,
    b.x + px,
    y,
    b.z + pz,
  ]);
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(positions, SANDBOX_PLAN_FEATURE.BEARING_PAD_LENGTH));
  geo.computeVertexNormals();
  return new Mesh(
    geo,
    new MeshBasicMaterial({
      color,
      transparent: true,
      opacity: SANDBOX_PLAN_FEATURE.BAND_OPACITY,
      side: DoubleSide,
      depthWrite: false,
    })
  );
}

/** A solid triangular arrowhead at `tip`, pointing along `dir` (normalized, XZ-plane). */
function buildArrowhead(
  tip: Vector3,
  dir: Vector3,
  color: number,
  size = SANDBOX_PLAN_FEATURE.ARROWHEAD_SIZE
): Mesh {
  const back = tip.clone().addScaledVector(dir, -size);
  const px = -dir.z * size * SANDBOX_PLAN_FEATURE.ARROWHEAD_HALF_WIDTH_RATIO;
  const pz = dir.x * size * SANDBOX_PLAN_FEATURE.ARROWHEAD_HALF_WIDTH_RATIO;
  const y = tip.y + SANDBOX_PLAN_FEATURE.BAND_ELEVATION_OFFSET;
  const positions = new Float32Array([
    tip.x,
    y,
    tip.z,
    back.x + px,
    y,
    back.z + pz,
    back.x - px,
    y,
    back.z - pz,
  ]);
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(positions, SANDBOX_PLAN_FEATURE.BEARING_PAD_LENGTH));
  geo.computeVertexNormals();
  return new Mesh(geo, new MeshBasicMaterial({ color, side: DoubleSide, depthWrite: false }));
}

const AXIS_COLOR = SANDBOX_PLAN_FEATURE.AXIS_COLOR;

/** Axis of advance — a centerline + arrowhead at the final point + a translucent width
 * corridor (one flat quad per segment). */
export function buildAxisGroup(pts: Vector3[], name: string, geoFrame: GeoFrame): Group {
  const g = new Group();
  const line = new Line(
    new BufferGeometry().setFromPoints(pts),
    new LineBasicMaterial({
      color: AXIS_COLOR,
      depthTest: false,
      transparent: true,
    })
  );
  line.renderOrder = 999;
  g.add(line);

  for (let i = 1; i < pts.length; i++) {
    const band = buildBandSegment(pts[i - 1], pts[i], SANDBOX_PLAN_FEATURE.AXIS_BAND_HALF_WIDTH, AXIS_COLOR);
    if (band) g.add(band);
  }

  const last = pts[pts.length - 1];
  const prev = pts[pts.length - 2] ?? pts[0];
  const dir = new Vector3(last.x - prev.x, 0, last.z - prev.z);
  if (dir.lengthSq() > SANDBOX_PLAN_FEATURE.AXIS_DIR_EPSILON) {
    dir.normalize();
    g.add(buildArrowhead(last, dir, AXIS_COLOR));
  }

  for (const p of pts) g.add(marker(p, AXIS_COLOR, SANDBOX_PLAN_FEATURE.AXIS_MARKER_SIZE));
  const bearing = computeBearingDeg(pts[0], last, geoFrame);
  g.add(
    label(
      last.clone().add(new Vector3(0, SANDBOX_PLAN_FEATURE.AXIS_LABEL_Y_OFFSET, 0)),
      `AXIS ${name} · ${formatBearing(bearing)}`
    )
  );
  return g;
}

const OBJECTIVE_COLOR = SANDBOX_PLAN_FEATURE.OBJECTIVE_COLOR;

/** A named objective — a single point today (the area variant is a later-wave refinement). */
export function buildObjectiveGroup(pts: Vector3[], name: string): Group {
  const point = pts[0];
  const g = new Group();
  g.add(marker(point, OBJECTIVE_COLOR, SANDBOX_PLAN_FEATURE.OBJECTIVE_MARKER_SIZE));
  g.add(
    label(
      point.clone().add(new Vector3(0, SANDBOX_PLAN_FEATURE.OBJECTIVE_LABEL_Y_OFFSET, 0)),
      `OBJ ${name}`
    )
  );
  return g;
}

// ---------- weapon/sensor range fans (todo 32 / C1) ----------

const RANGE_FAN_COLOR = SANDBOX_PLAN_FEATURE.RANGE_FAN_COLOR;
const DEFAULT_SYSTEM_ID: SystemId = 'mortar81mm';

/** Reads `metadata.systemId`, defensively falling back to a default system for
 * missing/unknown ids — the same pattern `unitSymbol.ts`'s `readUnitMetadata` uses for
 * hand-edited/older saved data. */
export function readRangeFanSystemId(metadata: Record<string, unknown>): SystemId {
  const systemId = metadata.systemId as SystemId | undefined;
  // `hasOwnProperty`, NOT the `in` operator — `in` walks the prototype chain, so a
  // corrupted/hand-edited `systemId` equal to a JS built-in key ("toString",
  // "constructor", ...) would otherwise pass this whitelist and resolve to an
  // inherited function instead of a real system, crashing the render with
  // `undefined.toFixed` (security-review finding, Wave 4).
  return systemId && Object.prototype.hasOwnProperty.call(WEAPON_SYSTEMS, systemId)
    ? systemId
    : DEFAULT_SYSTEM_ID;
}

/** A weapon/sensor's min/max range as an annulus (a ring, not a solid wedge — a system
 * usually can't engage inside its own minimum range), read from `WEAPON_SYSTEMS` at
 * RENDER time (invariant 2 — never a value baked into the persisted feature, so a future
 * table correction re-renders every saved plan correctly). `pts` is `[center, bearingPt]`
 * — `bearingPt` only labels the fan's facing today (every system in the table is a full
 * 360° fan); a doctrinal engagement arc is a documented future refinement, not
 * implemented here (no system in `WEAPON_SYSTEMS` currently needs one). */
export function buildRangeFanGroup(pts: Vector3[], systemId: SystemId, geoFrame: GeoFrame): Group {
  const [center, bearingPt] = pts;
  const system = WEAPON_SYSTEMS[systemId];

  const shape = new Shape();
  shape.absarc(0, 0, system.maxRangeM, 0, Math.PI * 2, false);
  if (system.minRangeM > 0) {
    const hole = new Path();
    hole.absarc(0, 0, system.minRangeM, 0, Math.PI * 2, true);
    shape.holes.push(hole);
  }

  const geo = new ShapeGeometry(shape, SANDBOX_PLAN_FEATURE.RANGE_FAN_SEGMENTS);
  geo.rotateX(-Math.PI / 2);
  const mesh = new Mesh(
    geo,
    new MeshBasicMaterial({
      color: RANGE_FAN_COLOR,
      transparent: true,
      opacity: SANDBOX_PLAN_FEATURE.RANGE_FAN_OPACITY,
      side: DoubleSide,
      depthWrite: false,
    })
  );
  mesh.position.set(center.x, center.y + 1, center.z);

  const bearing = computeBearingDeg(center, bearingPt, geoFrame);
  const g = new Group();
  g.add(mesh);
  g.add(marker(center, RANGE_FAN_COLOR, EYE_HEIGHT));
  g.add(
    label(
      center.clone().add(new Vector3(0, SANDBOX_PLAN_FEATURE.RANGE_FAN_LABEL_Y_OFFSET, 0)),
      `${system.name} · ${fmtDist(system.minRangeM)}–${fmtDist(system.maxRangeM)} · ${formatBearing(bearing)}\n(geometric range only — no terrain masking)`
    )
  );
  return g;
}

export interface LosBuildResult {
  group: Group;
  blocked: boolean;
  /** Total observer→target distance, metres. */
  distanceM: number;
  /** Distance to the blocking point, metres — present only when `blocked`. */
  blockedAtM?: number;
}

/** What a LOS raycast between two eye-height-lifted points finds — `null` when clear. The
 * one raycast implementation `buildLosGroup` (this tool's rendering) and
 * `sampleRouteExposure` (todo 31 — Wave 4 M2, a path's per-point exposure to a threat)
 * both read from, so neither can silently drift from the other. */
export function raycastLosBlockingHit(
  obsGround: Vector3,
  tgtGround: Vector3,
  raycaster: Raycaster,
  tiles: Object3D
): { point: Vector3; distance: number } | null {
  const obs = obsGround.clone().add(new Vector3(0, EYE_HEIGHT, 0));
  const tgt = tgtGround.clone().add(new Vector3(0, EYE_HEIGHT, 0));
  const dir = tgt.clone().sub(obs);
  const dist = dir.length();
  if (dist < SANDBOX_PLAN_FEATURE.BAND_EPSILON) return null;
  dir.normalize();

  raycaster.set(obs, dir);
  raycaster.far = dist - SANDBOX_PLAN_FEATURE.LOS_RAYCAST_MARGIN;
  const hits = raycaster.intersectObject(tiles, true);
  return hits.length > 0 ? { point: hits[0].point, distance: hits[0].distance } : null;
}

/** Raycast obs→tgt against the photogrammetry mesh; green/red split if a building blocks. */
export function buildLosGroup(
  obsGround: Vector3,
  tgtGround: Vector3,
  report: boolean,
  raycaster: Raycaster,
  tiles: Object3D,
  geoFrame: GeoFrame
): LosBuildResult {
  const obs = obsGround.clone().add(new Vector3(0, EYE_HEIGHT, 0));
  const tgt = tgtGround.clone().add(new Vector3(0, EYE_HEIGHT, 0));
  const dist = obs.distanceTo(tgt);
  const bearing = computeBearingDeg(obsGround, tgtGround, geoFrame);
  const blockedHit = raycastLosBlockingHit(obsGround, tgtGround, raycaster, tiles);

  const g = new Group();
  g.add(marker(obs, SANDBOX_PLAN_FEATURE.LOS_OBSERVER_COLOR));

  if (!blockedHit) {
    const line = new Line(new BufferGeometry().setFromPoints([obs, tgt]), MAT_LOS_CLEAR);
    line.renderOrder = 999;
    g.add(line);
    g.add(marker(tgt, SANDBOX_PLAN_FEATURE.LOS_CLEAR_COLOR));
    if (report) {
      g.add(
        label(
          tgt.clone().add(new Vector3(0, SANDBOX_PLAN_FEATURE.LOS_LABEL_Y_OFFSET, 0)),
          `CLEAR ${fmtDist(dist)} · ${formatBearing(bearing)}`
        )
      );
    }
    return { group: g, blocked: false, distanceM: dist };
  }

  const clearLine = new Line(
    new BufferGeometry().setFromPoints([obs, blockedHit.point]),
    MAT_LOS_CLEAR
  );
  const blockedLine = new Line(
    new BufferGeometry().setFromPoints([blockedHit.point, tgt]),
    MAT_LOS_BLOCKED
  );
  clearLine.renderOrder = 999;
  blockedLine.renderOrder = 999;
  g.add(clearLine, blockedLine);
  g.add(
    marker(
      blockedHit.point,
      SANDBOX_PLAN_FEATURE.LOS_BLOCKED_COLOR,
      SANDBOX_PLAN_FEATURE.LOS_BLOCKED_MARKER_SIZE
    )
  );
  g.add(marker(tgt, SANDBOX_PLAN_FEATURE.LOS_BLOCKED_COLOR));
  if (report) {
    g.add(
      label(
        blockedHit.point.clone().add(new Vector3(0, SANDBOX_PLAN_FEATURE.LOS_LABEL_Y_OFFSET, 0)),
        `BLOCKED @ ${fmtDist(blockedHit.distance)} · ${formatBearing(bearing)}`
      )
    );
  }
  return { group: g, blocked: true, distanceM: dist, blockedAtM: blockedHit.distance };
}

// ---------- phase tagging (todo 25) ----------

/** The sentinel `metadata.phase` value meaning "visible in every phase" — also the
 * fallback for an untagged feature (invariant 3), never a silently-hidden default. */
export const ALL_PHASES = 'all-phases';

/** Reads a feature's phase tag, validated against the plan's CURRENT phase-id set
 * (invariant 1 — no dangling references): a tag naming a phase that no longer exists
 * (e.g. the phase was deleted) falls back to `ALL_PHASES` rather than hiding the
 * feature or throwing, mirroring `unitSymbol.ts`'s `readUnitMetadata` defensive-default
 * pattern for hand-edited/older saved data. */
export function resolveFeaturePhase(
  metadata: Record<string, unknown>,
  validPhaseIds: ReadonlySet<string>
): string {
  const phase = metadata.phase;
  if (typeof phase !== 'string' || phase === ALL_PHASES) return ALL_PHASES;
  return validPhaseIds.has(phase) ? phase : ALL_PHASES;
}

/** A feature tagged `ALL_PHASES` is always visible; otherwise visible only when the
 * active filter is `ALL_PHASES` (no filter) or matches the feature's own phase exactly
 * (invariant 2 is enforced by the CALLER — this is the pure show/hide predicate only). */
export function isFeatureVisibleForPhase(featurePhase: string, filterPhase: string): boolean {
  return featurePhase === ALL_PHASES || filterPhase === ALL_PHASES || featurePhase === filterPhase;
}

// ---------- serialize / rebuild seam ----------

export function toLocalPoint(v: Vector3): LocalPoint {
  return { x: v.x, y: v.y, z: v.z };
}

/**
 * Captures a drawn feature's points as a `PlanFeature`. Geo coordinates are computed
 * NOW (draw time) via `geoFrame.localToGeo` — not recomputed on load, since the tiles
 * frame may have shifted (todo-11 invariant 2).
 */
export function serializeFeature(
  type: PlanFeatureType,
  localPoints: Vector3[],
  name: string,
  geoFrame: GeoFrame,
  metadata: Record<string, unknown> = {},
  id: string = crypto.randomUUID()
): PlanFeature {
  return {
    id,
    type,
    name,
    points: {
      local: localPoints.map(toLocalPoint),
      geo: localPoints.map((p) => geoFrame.localToGeo(p)),
    },
    metadata,
  };
}

/** What `rebuildFeature` needs to reconstruct a `los` feature's blocked/clear raycast. */
export interface RebuildContext {
  raycaster: Raycaster;
  tiles: Object3D;
  /** Needed to recompute bearing labels (todo 16) identically to how they were drawn. */
  geoFrame: GeoFrame;
}

/**
 * Reconstructs the Three.js `Group` for a `PlanFeature` — the inverse of the finalizers.
 * Reuses the same builders the live drafting tools use, so a reloaded feature renders
 * identically to a freshly-drawn one.
 */
export function rebuildFeature(pf: PlanFeature, ctx: RebuildContext): Group {
  const pts = pf.points.local.map((p) => new Vector3(p.x, p.y, p.z));
  switch (pf.type) {
    case 'distance':
      return buildDistanceGroup(pts, ctx.geoFrame);
    case 'focus':
      return buildFocusGroup(pts, pf.name);
    case 'arc':
      return buildArcGroup(pts);
    case 'los':
      return buildLosGroup(pts[0], pts[1], true, ctx.raycaster, ctx.tiles, ctx.geoFrame).group;
    case 'boundary':
    case 'phaseline':
    case 'loa':
      return buildLinearMeasureGroup(pts, pf.type, pf.name);
    case 'axis':
      return buildAxisGroup(pts, pf.name, ctx.geoFrame);
    case 'objective':
      return buildObjectiveGroup(pts, pf.name);
    case 'unit': {
      const { affiliation, echelon } = readUnitMetadata(pf.metadata);
      return buildUnitSymbolGroup(pts[0], affiliation, echelon, pf.name);
    }
    case 'rangeFan':
      return buildRangeFanGroup(pts, readRangeFanSystemId(pf.metadata), ctx.geoFrame);
    default: {
      const exhaustive: never = pf.type;
      throw new Error(`rebuildFeature: unknown PlanFeature type ${exhaustive as string}`);
    }
  }
}
