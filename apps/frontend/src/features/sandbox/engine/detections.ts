import {
  BoxGeometry,
  CanvasTexture,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  RingGeometry,
  Scene,
  Sprite,
  SpriteMaterial,
  Vector3,
} from 'three';

import type { ModelLibrary } from './modelCatalog';

export type DetectionClass = 'armored_fighting_vehicle' | 'light_military_vehicle' | 'aircraft';

export const DETECTION_CLASSES: Array<{ id: DetectionClass; label: string }> = [
  { id: 'armored_fighting_vehicle', label: 'AFV (tank)' },
  { id: 'light_military_vehicle', label: 'LMV (light vehicle)' },
  { id: 'aircraft', label: 'Aircraft' },
];

/** Locked Sentinel detection schema — the AI service must emit this too.
 * `method`/`model`/`detected_at`/`uncertainty_m` are additive (W4) — existing consumers
 * that only read the original fields are unaffected. */
export interface SentinelDetection {
  detection_id: string;
  image_id: string;
  class: DetectionClass;
  confidence: number;
  bbox_pixel: { x: number; y: number; w: number; h: number; theta: number };
  lat: number;
  lon: number;
  world_heading: number;
  heading_confidence: 'high' | 'medium' | 'low';
  timestamp: string;
  source_image_url: string;
  /** How this detection was produced — every detection is one or the other. */
  method: 'manual' | 'auto';
  /** Detector model id — present only for `method: 'auto'`. */
  model?: string;
  /** When the detector produced this box (ISO 8601) — present only for `method: 'auto'`. */
  detected_at?: string;
  /** Rough CEP-style ground-placement uncertainty in metres — see `estimateGeoUncertaintyM`
   * in createSandbox.ts for the (documented-approximation) derivation. */
  uncertainty_m?: number;
}

const HOSTILE_RED = 0x8c1f1f;
const HOSTILE_DARK = 0x4d1212;

/** Maps detection confidence [0,1] to ring opacity so low-confidence detections render
 * visibly fainter than high-confidence ones. 1.0 confidence -> 0.7 opacity, matching the
 * pre-W4 constant so fully-confident (and manual) detections render unchanged. */
export function confidenceToRingOpacity(confidence: number): number {
  const clamped = Math.min(1, Math.max(0, confidence));
  return 0.2 + clamped * 0.5;
}

const CLASS_TO_ASSET: Record<DetectionClass, string> = {
  armored_fighting_vehicle: 'tank',
  light_military_vehicle: 'car',
  aircraft: 'jet',
};

/** Renders deployed detections as red hostile models with rings + labels. */
export class DetectionLayer {
  private root = new Group();
  private lib: ModelLibrary;

  constructor(scene: Scene, lib: ModelLibrary) {
    this.lib = lib;
    scene.add(this.root);
  }

  public spawn(
    localPos: Vector3,
    localYaw: number,
    cls: DetectionClass,
    name: string,
    opts?: { confidence?: number; uncertaintyM?: number }
  ): void {
    const group = new Group();
    group.add(this.lib.instance(CLASS_TO_ASSET[cls], () => buildModel(cls), HOSTILE_RED));

    const ring = new Mesh(
      new RingGeometry(4.2, 4.8, 32),
      new MeshStandardMaterial({
        color: 0xff3b30,
        transparent: true,
        opacity: confidenceToRingOpacity(opts?.confidence ?? 1.0),
      })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.15;
    group.add(ring);

    const label = opts?.uncertaintyM !== undefined ? `${name} ±${opts.uncertaintyM}m` : name;
    group.add(makeTag(label));

    group.position.copy(localPos);
    group.rotation.y = localYaw;
    group.traverse((o) => o.layers.set(1));
    this.root.add(group);
  }

  public clear(): void {
    this.root.clear();
  }

  public get count(): number {
    return this.root.children.length;
  }
}

function buildModel(cls: DetectionClass): Group {
  const g = new Group();
  const body = new MeshStandardMaterial({ color: HOSTILE_RED, roughness: 0.7 });
  const dark = new MeshStandardMaterial({ color: HOSTILE_DARK, roughness: 0.9 });

  if (cls === 'armored_fighting_vehicle') {
    const hull = new Mesh(new BoxGeometry(3.5, 1.2, 6.0), body);
    hull.position.y = 0.6;
    const turret = new Mesh(new BoxGeometry(2.4, 0.8, 3.0), body);
    turret.position.set(0, 1.6, -0.3);
    const barrel = new Mesh(new CylinderGeometry(0.14, 0.16, 4.2, 10), dark);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 1.7, 2.4);
    g.add(hull, turret, barrel);
  } else if (cls === 'light_military_vehicle') {
    const hull = new Mesh(new BoxGeometry(2.0, 1.0, 4.2), body);
    hull.position.y = 0.8;
    const cab = new Mesh(new BoxGeometry(1.8, 0.7, 1.6), dark);
    cab.position.set(0, 1.6, 0.8);
    g.add(hull, cab);
  } else {
    const fuselage = new Mesh(new CylinderGeometry(0.5, 0.3, 8, 10), body);
    fuselage.rotation.x = Math.PI / 2;
    fuselage.position.y = 1.2;
    const wing = new Mesh(new BoxGeometry(8, 0.12, 2.2), body);
    wing.position.y = 1.0;
    const fin = new Mesh(new BoxGeometry(0.1, 1.6, 1.3), dark);
    fin.position.set(0, 2.0, -3.5);
    g.add(fuselage, wing, fin);
  }
  return g;
}

function makeTag(text: string): Sprite {
  const canvas = document.createElement('canvas');
  const measure = canvas.getContext('2d')!;
  measure.font = '600 30px monospace';
  canvas.width = Math.min(Math.ceil(measure.measureText(text).width) + 24, 512);
  canvas.height = 44;

  const ctx = canvas.getContext('2d')!;
  ctx.font = '600 30px monospace';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(140, 20, 20, 0.92)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, 12, 24);

  const sprite = new Sprite(
    new SpriteMaterial({
      map: new CanvasTexture(canvas),
      sizeAttenuation: false,
      depthTest: false,
      transparent: true,
    })
  );
  sprite.position.set(0, 6, 0);
  const h = 0.022;
  sprite.scale.set(h * (canvas.width / canvas.height), h, 1);
  sprite.renderOrder = 960;
  return sprite;
}
