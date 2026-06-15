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

export type DetectionClass =
  | 'armored_fighting_vehicle'
  | 'light_military_vehicle'
  | 'aircraft';

export const DETECTION_CLASSES: Array<{ id: DetectionClass; label: string }> = [
  { id: 'armored_fighting_vehicle', label: 'AFV (tank)' },
  { id: 'light_military_vehicle', label: 'LMV (light vehicle)' },
  { id: 'aircraft', label: 'Aircraft' },
];

/** Locked Sentinel detection schema — the AI service must emit this too. */
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
}

const HOSTILE_RED = 0x8c1f1f;
const HOSTILE_DARK = 0x4d1212;

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

  public spawn(localPos: Vector3, localYaw: number, cls: DetectionClass, name: string): void {
    const group = new Group();
    group.add(this.lib.instance(CLASS_TO_ASSET[cls], () => buildModel(cls), HOSTILE_RED));

    const ring = new Mesh(
      new RingGeometry(4.2, 4.8, 32),
      new MeshStandardMaterial({ color: 0xff3b30, transparent: true, opacity: 0.7 })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.15;
    group.add(ring);

    group.add(makeTag(name));

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
