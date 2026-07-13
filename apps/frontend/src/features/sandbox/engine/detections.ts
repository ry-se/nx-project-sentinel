import type { UnitType, Vec3 } from '@org/simulation-core';
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

import type { DetectionClass } from '../detectionSchema';

import { disposeObject3D, disposeObjectChildren } from './disposeThree';
import type { ModelLibrary } from './modelCatalog';

import { SANDBOX_DETECTIONS } from '@/constants/sandbox';

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

/** A geolocated intel contact ready to be handed to the battle layer without leaking
 * Three.js vectors across the integration boundary. */
export interface ProjectedIntelContact {
  readonly detection: SentinelDetection;
  readonly worldPosition: Vec3;
  readonly localHeadingRad?: number;
}

/** Exhaustive intel-class -> battle-unit bridge. `satisfies` makes a newly-added
 * DetectionClass a compile error here rather than silently falling through. */
export const DETECTION_CLASS_TO_BATTLE_UNIT = {
  armored_fighting_vehicle: 'tank',
  light_military_vehicle: 'car',
  aircraft: 'jet',
} as const satisfies Readonly<Record<DetectionClass, UnitType>>;

const HOSTILE_RED = SANDBOX_DETECTIONS.HOSTILE_RED;
const HOSTILE_DARK = SANDBOX_DETECTIONS.HOSTILE_DARK;
const BATTLE_LINKED_RING_OPACITY_MULTIPLIER = 0.35;
const BATTLE_LINKED_TAG_OPACITY = 0.62;

/** Maps detection confidence [0,1] to ring opacity so low-confidence detections render
 * visibly fainter than high-confidence ones. 1.0 confidence -> 0.7 opacity, matching the
 * pre-W4 constant so fully-confident (and manual) detections render unchanged. */
export function confidenceToRingOpacity(confidence: number): number {
  const clamped = Math.min(1, Math.max(0, confidence));
  return (
    SANDBOX_DETECTIONS.CONFIDENCE_MIN_OPACITY +
    clamped * SANDBOX_DETECTIONS.CONFIDENCE_OPACITY_RANGE
  );
}

interface DetectionRenderEntry {
  readonly group: Group;
  readonly model: Group;
  readonly ring: Mesh<RingGeometry, MeshStandardMaterial>;
  readonly tag: Sprite;
  readonly baseRingOpacity: number;
}

/** Renders deployed detections as red hostile models with rings + labels. */
export class DetectionLayer {
  private readonly root = new Group();
  private readonly lib: ModelLibrary;
  private readonly rendersByDetectionId = new Map<string, DetectionRenderEntry>();

  constructor(scene: Scene, lib: ModelLibrary) {
    this.lib = lib;
    scene.add(this.root);
  }

  public spawn(
    localPos: Vector3,
    localYaw: number,
    cls: DetectionClass,
    name: string,
    opts?: { confidence?: number; uncertaintyM?: number; detectionId?: string }
  ): void {
    const detectionId = opts?.detectionId;
    if (detectionId !== undefined) this.removeRegisteredDetection(detectionId);

    const group = new Group();
    const model = this.lib.instance(
      DETECTION_CLASS_TO_BATTLE_UNIT[cls],
      () => buildModel(cls),
      HOSTILE_RED
    );
    group.add(model);

    const baseRingOpacity = confidenceToRingOpacity(opts?.confidence ?? 1.0);
    const ring = new Mesh(
      new RingGeometry(
        SANDBOX_DETECTIONS.RING_INNER_RADIUS,
        SANDBOX_DETECTIONS.RING_OUTER_RADIUS,
        SANDBOX_DETECTIONS.RING_SEGMENTS
      ),
      new MeshStandardMaterial({
        color: SANDBOX_DETECTIONS.RING_COLOR,
        transparent: true,
        opacity: baseRingOpacity,
      })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = SANDBOX_DETECTIONS.RING_Y;
    group.add(ring);

    const label = opts?.uncertaintyM !== undefined ? `${name} ±${opts.uncertaintyM}m` : name;
    const tag = makeTag(label);
    group.add(tag);

    group.position.copy(localPos);
    group.rotation.y = localYaw;
    group.traverse((o) => o.layers.set(SANDBOX_DETECTIONS.MODEL_LAYER));
    this.root.add(group);

    if (detectionId !== undefined) {
      group.name = `sentinel-detection-${detectionId}`;
      model.name = `sentinel-detection-model-${detectionId}`;
      group.userData.detectionId = detectionId;
      group.userData.battleLinked = false;
      this.rendersByDetectionId.set(detectionId, {
        group,
        model,
        ring,
        tag,
        baseRingOpacity,
      });
    }
  }

  /** Hides only the duplicated vehicle model for battle-linked contacts. The subdued
   * ring and tag remain as the original intel/provenance cue. Unknown ids are ignored. */
  public setBattleLinked(ids: readonly string[], linked: boolean): void {
    for (const id of ids) {
      const entry = this.rendersByDetectionId.get(id);
      if (!entry) continue;
      entry.model.visible = !linked;
      entry.ring.material.opacity = linked
        ? entry.baseRingOpacity * BATTLE_LINKED_RING_OPACITY_MULTIPLIER
        : entry.baseRingOpacity;
      entry.tag.material.opacity = linked ? BATTLE_LINKED_TAG_OPACITY : 1;
      entry.group.userData.battleLinked = linked;
    }
  }

  public clear(): void {
    this.rendersByDetectionId.clear();
    disposeObjectChildren(this.root);
  }

  public dispose(): void {
    this.rendersByDetectionId.clear();
    disposeObject3D(this.root);
  }

  public get count(): number {
    return this.root.children.length;
  }

  private removeRegisteredDetection(detectionId: string): void {
    const existing = this.rendersByDetectionId.get(detectionId);
    if (!existing) return;
    this.rendersByDetectionId.delete(detectionId);
    disposeObject3D(existing.group);
  }
}

function buildModel(cls: DetectionClass): Group {
  const g = new Group();
  const body = new MeshStandardMaterial({ color: HOSTILE_RED, roughness: 0.7 });
  const dark = new MeshStandardMaterial({ color: HOSTILE_DARK, roughness: 0.9 });

  if (cls === 'armored_fighting_vehicle') {
    const hull = new Mesh(
      new BoxGeometry(
        SANDBOX_DETECTIONS.TANK_HULL_W,
        SANDBOX_DETECTIONS.TANK_HULL_H,
        SANDBOX_DETECTIONS.TANK_HULL_D
      ),
      body
    );
    hull.position.y = SANDBOX_DETECTIONS.TANK_HULL_Y;
    const turret = new Mesh(
      new BoxGeometry(
        SANDBOX_DETECTIONS.TANK_TURRET_W,
        SANDBOX_DETECTIONS.TANK_TURRET_H,
        SANDBOX_DETECTIONS.TANK_TURRET_D
      ),
      body
    );
    turret.position.set(0, SANDBOX_DETECTIONS.TANK_TURRET_Y, SANDBOX_DETECTIONS.TANK_TURRET_Z);
    const barrel = new Mesh(
      new CylinderGeometry(
        SANDBOX_DETECTIONS.TANK_BARREL_RADIUS_TOP,
        SANDBOX_DETECTIONS.TANK_BARREL_RADIUS_BOTTOM,
        SANDBOX_DETECTIONS.TANK_BARREL_LENGTH,
        SANDBOX_DETECTIONS.TANK_BARREL_SEGMENTS
      ),
      dark
    );
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, SANDBOX_DETECTIONS.TANK_BARREL_Y, SANDBOX_DETECTIONS.TANK_BARREL_Z);
    g.add(hull, turret, barrel);
  } else if (cls === 'light_military_vehicle') {
    const hull = new Mesh(
      new BoxGeometry(
        SANDBOX_DETECTIONS.LMV_HULL_W,
        SANDBOX_DETECTIONS.LMV_HULL_H,
        SANDBOX_DETECTIONS.LMV_HULL_D
      ),
      body
    );
    hull.position.y = SANDBOX_DETECTIONS.LMV_HULL_Y;
    const cab = new Mesh(
      new BoxGeometry(
        SANDBOX_DETECTIONS.LMV_CAB_W,
        SANDBOX_DETECTIONS.LMV_CAB_H,
        SANDBOX_DETECTIONS.LMV_CAB_D
      ),
      dark
    );
    cab.position.set(0, SANDBOX_DETECTIONS.LMV_CAB_Y, SANDBOX_DETECTIONS.LMV_CAB_Z);
    g.add(hull, cab);
  } else {
    const fuselage = new Mesh(
      new CylinderGeometry(
        SANDBOX_DETECTIONS.AIRCRAFT_FUSELAGE_RADIUS_TOP,
        SANDBOX_DETECTIONS.AIRCRAFT_FUSELAGE_RADIUS_BOTTOM,
        SANDBOX_DETECTIONS.AIRCRAFT_FUSELAGE_LENGTH,
        SANDBOX_DETECTIONS.AIRCRAFT_FUSELAGE_SEGMENTS
      ),
      body
    );
    fuselage.rotation.x = Math.PI / 2;
    fuselage.position.y = SANDBOX_DETECTIONS.AIRCRAFT_FUSELAGE_Y;
    const wing = new Mesh(
      new BoxGeometry(
        SANDBOX_DETECTIONS.AIRCRAFT_WING_W,
        SANDBOX_DETECTIONS.AIRCRAFT_WING_H,
        SANDBOX_DETECTIONS.AIRCRAFT_WING_D
      ),
      body
    );
    wing.position.y = SANDBOX_DETECTIONS.AIRCRAFT_WING_Y;
    const fin = new Mesh(
      new BoxGeometry(
        SANDBOX_DETECTIONS.AIRCRAFT_FIN_W,
        SANDBOX_DETECTIONS.AIRCRAFT_FIN_H,
        SANDBOX_DETECTIONS.AIRCRAFT_FIN_D
      ),
      dark
    );
    fin.position.set(0, SANDBOX_DETECTIONS.AIRCRAFT_FIN_Y, SANDBOX_DETECTIONS.AIRCRAFT_FIN_Z);
    g.add(fuselage, wing, fin);
  }
  return g;
}

function makeTag(text: string): Sprite {
  const canvas = document.createElement('canvas');
  const measure = canvas.getContext('2d');
  if (!measure) throw new Error('2D canvas context unavailable');
  measure.font = `600 ${SANDBOX_DETECTIONS.TAG_FONT_SIZE}px monospace`;
  canvas.width = Math.min(
    Math.ceil(measure.measureText(text).width) + SANDBOX_DETECTIONS.TAG_PADDING_X,
    SANDBOX_DETECTIONS.TAG_MAX_WIDTH
  );
  canvas.height = SANDBOX_DETECTIONS.TAG_HEIGHT;

  measure.font = `600 ${SANDBOX_DETECTIONS.TAG_FONT_SIZE}px monospace`;
  measure.textBaseline = 'middle';
  measure.fillStyle = 'rgba(140, 20, 20, 0.92)';
  measure.fillRect(0, 0, canvas.width, canvas.height);
  measure.fillStyle = '#ffffff';
  measure.fillText(text, SANDBOX_DETECTIONS.TAG_PADDING_X / 2, SANDBOX_DETECTIONS.TAG_BASELINE_Y);

  const sprite = new Sprite(
    new SpriteMaterial({
      map: new CanvasTexture(canvas),
      sizeAttenuation: false,
      depthTest: false,
      transparent: true,
    })
  );
  sprite.position.set(0, SANDBOX_DETECTIONS.TAG_Y, 0);
  const h = SANDBOX_DETECTIONS.TAG_SCALE_HEIGHT;
  sprite.scale.set(h * (canvas.width / canvas.height), h, 1);
  sprite.renderOrder = 960;
  return sprite;
}
