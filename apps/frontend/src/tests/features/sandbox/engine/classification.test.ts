import { TilesRenderer } from '3d-tiles-renderer';
import { Group, Mesh, MeshBasicMaterial, PerspectiveCamera, PlaneGeometry, Scene } from 'three';

import {
  CLASSIFICATION_COLOR,
  CLASSIFICATION_LEVELS,
  DEFAULT_CLASSIFICATION,
} from '../../../../features/sandbox/engine/classification';
import { GeoFrame } from '../../../../features/sandbox/engine/geoFrame';
import { loadPlan, savePlan } from '../../../../features/sandbox/engine/planStore';
import { StrategistController } from '../../../../features/sandbox/engine/strategist';
import { ViewshedController } from '../../../../features/sandbox/engine/viewshed';

/**
 * Todo 22: default classification is EXERCISE and never silently blank (invariant 2);
 * the classification list is a config, not hardcoded per call site (invariant 4);
 * provenance is captured at draw time and travels with the `PlanFeature` through
 * save/load (invariant 3).
 */

function fakeCanvasContext() {
  const measureText = () => ({ width: 42 });
  return new Proxy(
    { measureText },
    { get: (target, prop) => (prop in target ? (target as never)[prop] : vi.fn()) }
  );
}

function bareTiles(): TilesRenderer {
  const tiles = new TilesRenderer();
  tiles.group.raycast = Group.prototype.raycast;
  return tiles;
}

const ANCHOR = { lat: 1.35, lon: 103.8 };

function makeController(): { controller: StrategistController; canvas: HTMLCanvasElement } {
  const canvas = document.createElement('canvas');
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    width: 800,
    height: 600,
    right: 800,
    bottom: 600,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
  // Angled downward look at a large horizontal ground plane, so every click on the
  // canvas raycasts to a real point (see the identical setup in strategist.featureList.test.ts).
  const camera = new PerspectiveCamera(60, 800 / 600, 0.1, 1_000_000);
  camera.position.set(0, 100, 100);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);

  const tiles = bareTiles();
  const ground = new Mesh(new PlaneGeometry(2000, 2000), new MeshBasicMaterial());
  ground.rotation.x = -Math.PI / 2;
  tiles.group.add(ground);
  // `TilesGroup.updateMatrixWorld` only cascades to children when the GROUP's own
  // transform changed since last update — update the freshly-added child directly.
  ground.updateMatrixWorld(true);

  const scene = new Scene();
  const viewshed = new ViewshedController(scene, tiles);
  const geoFrame = new GeoFrame(tiles, ANCHOR);
  const controller = new StrategistController(
    camera,
    canvas,
    tiles.group,
    scene,
    viewshed,
    geoFrame
  );
  controller.enabled = true;
  return { controller, canvas };
}

function clickAt(canvas: HTMLCanvasElement, x: number, y: number, button = 0): void {
  canvas.dispatchEvent(
    new MouseEvent('pointerdown', { clientX: x, clientY: y, button, bubbles: true })
  );
  window.dispatchEvent(
    new MouseEvent('pointerup', { clientX: x, clientY: y, button, bubbles: true })
  );
}

describe('classification config (invariants 2 + 4)', () => {
  it('the level list is a config array, not scattered literals', () => {
    expect(CLASSIFICATION_LEVELS).toEqual([
      'EXERCISE',
      'UNCLASSIFIED',
      'RESTRICTED',
      'CONFIDENTIAL',
    ]);
  });

  it('the default is EXERCISE — never silently blank', () => {
    expect(DEFAULT_CLASSIFICATION).toBe('EXERCISE');
    expect(DEFAULT_CLASSIFICATION).not.toBe('');
  });

  it('every level has a distinct banner color', () => {
    const colors = CLASSIFICATION_LEVELS.map((l) => CLASSIFICATION_COLOR[l]);
    expect(new Set(colors).size).toBe(CLASSIFICATION_LEVELS.length);
  });
});

describe('Plan.classification (todo 22 + todo 17 store)', () => {
  beforeEach(() => localStorage.clear());

  it('savePlan defaults classification to EXERCISE when not specified', () => {
    const saved = savePlan('Untitled', [], ANCHOR, '2026-07-05T00:00:00.000Z');
    expect(saved.classification).toBe('EXERCISE');
  });

  it('savePlan persists an explicit classification through load', () => {
    const saved = savePlan('COY ATTACK', [], ANCHOR, '2026-07-05T00:00:00.000Z', [], 'RESTRICTED');
    expect(loadPlan(saved.id).classification).toBe('RESTRICTED');
  });
});

describe('StrategistController — provenance captured at draw time (invariant 3)', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      fakeCanvasContext() as unknown as CanvasRenderingContext2D
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('every drawn feature carries author + created/updated timestamps', () => {
    const { controller, canvas } = makeController();
    controller.operatorName = 'CPT Tan';
    controller.enabled = true;
    controller.setTool('distance');

    clickAt(canvas, 400, 300);
    clickAt(canvas, 460, 320);
    clickAt(canvas, 460, 320, 2);

    const [row] = controller.listFeatures();
    expect(row.provenance?.author).toBe('CPT Tan');
    expect(row.provenance?.createdAt).toBeTruthy();
    expect(row.provenance?.updatedAt).toBe(row.provenance?.createdAt);
  });

  it('provenance travels through export/save/load into a fresh controller', () => {
    const { controller: source, canvas: sourceCanvas } = makeController();
    source.operatorName = 'LT Lim';
    source.enabled = true;
    source.setTool('distance');
    clickAt(sourceCanvas, 400, 300);
    clickAt(sourceCanvas, 460, 320);
    clickAt(sourceCanvas, 460, 320, 2);

    const saved = savePlan('P', source.exportFeatures(), ANCHOR, '2026-07-05T00:00:00.000Z');
    const { controller: target } = makeController();
    target.loadPlan(loadPlan(saved.id).features);

    const [row] = target.listFeatures();
    expect(row.provenance?.author).toBe('LT Lim');
  });

  it('operatorName defaults to a non-empty placeholder, not blank', () => {
    const { controller } = makeController();
    expect(controller.operatorName).toBeTruthy();
  });

  it('currentClassification defaults to EXERCISE on a fresh controller', () => {
    const { controller } = makeController();
    expect(controller.currentClassification).toBe('EXERCISE');
  });
});
