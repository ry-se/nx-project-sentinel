import {
  BufferGeometry,
  CanvasTexture,
  DoubleSide,
  EdgesGeometry,
  ExtrudeGeometry,
  Group,
  Line,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  Raycaster,
  Shape,
  ShapeGeometry,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Vector3,
} from 'three';

import type { GeoFrame, GeoPosition } from './geoFrame';

/** A JSON-safe stand-in for a Three.js `Vector3` — the shape every `PlanFeature` persists. */
export interface LocalPoint {
  x: number;
  y: number;
  z: number;
}

export type PlanFeatureType = 'distance' | 'focus' | 'arc' | 'los';

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

export const EYE_HEIGHT = 2; // metres above clicked surface for LOS endpoints

export const MAT_MEASURE = new LineBasicMaterial({
  color: 0x35d4ff,
  depthTest: false,
  transparent: true,
});
export const MAT_LOS_CLEAR = new LineBasicMaterial({
  color: 0x55ff55,
  depthTest: false,
  transparent: true,
});
export const MAT_LOS_BLOCKED = new LineBasicMaterial({
  color: 0xff4444,
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
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${m.toFixed(0)} m`;
}

export function fmtArea(m2: number): string {
  if (m2 >= 1_000_000) return `${(m2 / 1_000_000).toFixed(2)} km²`;
  if (m2 >= 10_000) return `${(m2 / 10_000).toFixed(1)} ha`;
  return `${m2.toFixed(0)} m²`;
}

export function marker(at: Vector3, color: number, size = 2): Mesh {
  const m = new Mesh(
    new SphereGeometry(size, 12, 12),
    new MeshBasicMaterial({ color, depthTest: false, transparent: true })
  );
  m.position.copy(at);
  m.renderOrder = 1000;
  return m;
}

export function label(at: Vector3, text: string): Sprite {
  const lines = text.split('\n');
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 64 + lines.length * 56;
  const ctx = canvas.getContext('2d')!;
  ctx.font = 'bold 44px monospace';
  ctx.textAlign = 'center';
  ctx.lineWidth = 10;
  ctx.strokeStyle = 'rgba(0,0,0,0.9)';
  ctx.fillStyle = '#ffffff';
  lines.forEach((line, i) => {
    const y = 56 + i * 56;
    ctx.strokeText(line, 256, y);
    ctx.fillText(line, 256, y);
  });

  const sprite = new Sprite(
    new SpriteMaterial({
      map: new CanvasTexture(canvas),
      depthTest: false,
      transparent: true,
    })
  );
  sprite.position.copy(at);
  const w = 70;
  sprite.scale.set(w, w * (canvas.height / canvas.width), 1);
  sprite.renderOrder = 1001;
  return sprite;
}

// ---------- pure group builders (data-in, Group-out — shared by live draft + rebuild) ----------

export function buildDistanceGroup(pts: Vector3[]): Group {
  const total = pathLength(pts);
  const g = new Group();
  const line = new Line(new BufferGeometry().setFromPoints(pts), MAT_MEASURE);
  line.renderOrder = 999;
  g.add(line);
  for (const p of pts) g.add(marker(p, 0x35d4ff));
  g.add(label(pts[pts.length - 1].clone().add(new Vector3(0, 12, 0)), fmtDist(total)));
  return g;
}

export function buildFocusGroup(pts: Vector3[], name: string): Group {
  const minY = Math.min(...pts.map((p) => p.y));
  const maxY = Math.max(...pts.map((p) => p.y));
  const height = maxY - minY + 80;

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
  mesh.position.set(cx, minY - 5, cz);

  const edges = new LineSegments(
    new EdgesGeometry(geo),
    new LineBasicMaterial({ color: 0xffb74d, transparent: true, opacity: 0.8 })
  );
  edges.position.copy(mesh.position);

  const areaM2 = shoelaceXZ(pts);
  const g = new Group();
  g.add(mesh, edges);
  g.add(label(new Vector3(cx, maxY + 95, cz), `${name}\n${fmtArea(areaM2)}`));
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

  const geo = new ShapeGeometry(shape, 48);
  geo.rotateX(-Math.PI / 2);
  const mesh = new Mesh(
    geo,
    new MeshBasicMaterial({
      color: 0xef5350,
      transparent: true,
      opacity: 0.22,
      side: DoubleSide,
      depthWrite: false,
    })
  );
  mesh.position.set(center.x, center.y + 1.5, center.z);

  const g = new Group();
  g.add(mesh);
  g.add(marker(center, 0xef5350));
  g.add(label(center.clone().add(new Vector3(0, 25, 0)), `r=${fmtDist(r)}`));
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

/** Raycast obs→tgt against the photogrammetry mesh; green/red split if a building blocks. */
export function buildLosGroup(
  obsGround: Vector3,
  tgtGround: Vector3,
  report: boolean,
  raycaster: Raycaster,
  tiles: Object3D
): LosBuildResult {
  const obs = obsGround.clone().add(new Vector3(0, EYE_HEIGHT, 0));
  const tgt = tgtGround.clone().add(new Vector3(0, EYE_HEIGHT, 0));
  const dir = tgt.clone().sub(obs);
  const dist = dir.length();
  dir.normalize();

  raycaster.set(obs, dir);
  raycaster.far = dist - 2;
  const hits = raycaster.intersectObject(tiles, true);
  const blockedHit = hits.length > 0 ? hits[0] : null;

  const g = new Group();
  g.add(marker(obs, 0xffffff));

  if (!blockedHit) {
    const line = new Line(new BufferGeometry().setFromPoints([obs, tgt]), MAT_LOS_CLEAR);
    line.renderOrder = 999;
    g.add(line);
    g.add(marker(tgt, 0x55ff55));
    if (report) g.add(label(tgt.clone().add(new Vector3(0, 14, 0)), `CLEAR ${fmtDist(dist)}`));
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
  g.add(marker(blockedHit.point, 0xff4444, 3));
  g.add(marker(tgt, 0xff4444));
  if (report) {
    g.add(
      label(
        blockedHit.point.clone().add(new Vector3(0, 14, 0)),
        `BLOCKED @ ${fmtDist(blockedHit.distance)}`
      )
    );
  }
  return { group: g, blocked: true, distanceM: dist, blockedAtM: blockedHit.distance };
}

// ---------- serialize / rebuild seam ----------

function toLocalPoint(v: Vector3): LocalPoint {
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
      return buildDistanceGroup(pts);
    case 'focus':
      return buildFocusGroup(pts, pf.name);
    case 'arc':
      return buildArcGroup(pts);
    case 'los':
      return buildLosGroup(pts[0], pts[1], true, ctx.raycaster, ctx.tiles).group;
    default: {
      const exhaustive: never = pf.type;
      throw new Error(`rebuildFeature: unknown PlanFeature type ${exhaustive as string}`);
    }
  }
}
