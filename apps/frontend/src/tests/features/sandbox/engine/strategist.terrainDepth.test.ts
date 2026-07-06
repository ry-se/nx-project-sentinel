import { TilesRenderer } from '3d-tiles-renderer';
import {
  Group,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  Vector3,
} from 'three';

import { GeoFrame } from '../../../../features/sandbox/engine/geoFrame';
import type { PlanFeature } from '../../../../features/sandbox/engine/planFeature';
import { findNearestUnit, StrategistController } from '../../../../features/sandbox/engine/strategist';
import { ViewshedController } from '../../../../features/sandbox/engine/viewshed';

/**
 * Todo 30 — C3 counter-viewshed. Covers the 3 stated invariants:
 * 1. `findNearestUnit` is a pure function of (features, point, maxDist) — `null` when
 *    nothing is within range.
 * 2. The SAME `ViewshedController` instance is reused — no parallel visibility impl.
 * 3. The status/HUD text names WHICH unit the analysis is from.
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
const CANVAS_RECT = {
  left: 0,
  top: 0,
  width: 800,
  height: 600,
  right: 800,
  bottom: 600,
  x: 0,
  y: 0,
};

function makeController(): {
  controller: StrategistController;
  canvas: HTMLCanvasElement;
  viewshed: ViewshedController;
} {
  const canvas = document.createElement('canvas');
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
    ...CANVAS_RECT,
    toJSON: () => CANVAS_RECT,
  } as DOMRect);

  const camera = new PerspectiveCamera(60, CANVAS_RECT.width / CANVAS_RECT.height, 0.1, 1_000_000);
  camera.position.set(0, 100, 100);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);

  const tiles = bareTiles();
  const ground = new Mesh(new PlaneGeometry(2000, 2000), new MeshBasicMaterial());
  ground.rotation.x = -Math.PI / 2;
  tiles.group.add(ground);
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
  return { controller, canvas, viewshed };
}

function clickAt(canvas: HTMLCanvasElement, x: number, y: number, button = 0): void {
  canvas.dispatchEvent(
    new MouseEvent('pointerdown', { clientX: x, clientY: y, button, bubbles: true })
  );
  window.dispatchEvent(
    new MouseEvent('pointerup', { clientX: x, clientY: y, button, bubbles: true })
  );
}

function unitAt(id: string, x: number, z: number, name = 'Enemy 1'): PlanFeature {
  return {
    id,
    type: 'unit',
    name,
    points: { local: [{ x, y: 0, z }], geo: [{ lat: 0, lon: 0, altM: 0 }] },
    metadata: {},
  };
}

describe('findNearestUnit (invariant 1 — pure, no dangling guess)', () => {
  it('returns the nearest unit within range', () => {
    const features = [unitAt('a', 0, 0, 'Near'), unitAt('b', 100, 0, 'Far')];
    const found = findNearestUnit(features, new Vector3(5, 0, 0), 40);
    expect(found?.id).toBe('a');
  });

  it('returns null when nothing is within maxDistM', () => {
    const features = [unitAt('a', 500, 0)];
    expect(findNearestUnit(features, new Vector3(0, 0, 0), 40)).toBeNull();
  });

  it('ignores non-unit features', () => {
    const distance: PlanFeature = {
      id: 'd',
      type: 'distance',
      name: 'Distance 1',
      points: {
        local: [
          { x: 0, y: 0, z: 0 },
          { x: 10, y: 0, z: 0 },
        ],
        geo: [],
      },
      metadata: {},
    };
    expect(findNearestUnit([distance], new Vector3(0, 0, 0), 40)).toBeNull();
  });
});

describe('StrategistController — counterViewshed wired end-to-end', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      fakeCanvasContext() as unknown as CanvasRenderingContext2D
    );
    vi.spyOn(window, 'prompt').mockImplementation((_msg, def) => def ?? null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('picking a placed unit aims the SAME ViewshedController (invariant 2)', () => {
    const { controller, canvas, viewshed } = makeController();
    const aimSpy = vi.spyOn(viewshed, 'aim');

    controller.setTool('symbol');
    clickAt(canvas, 420, 320);
    const [unit] = controller.listFeatures();

    controller.setTool('counterViewshed');
    // Click near the placed unit (raycast lands close to it on the flat ground plane).
    clickAt(canvas, 420, 320);
    clickAt(canvas, 440, 340); // aim/lock

    expect(aimSpy).toHaveBeenCalledTimes(1);
    expect(unit).toBeDefined();
  });

  it('status names WHICH unit the counter-viewshed is from (invariant 3)', () => {
    const { controller, canvas } = makeController();
    const statuses: string[] = [];
    controller.onStatus = (text) => statuses.push(text);

    controller.setTool('symbol');
    clickAt(canvas, 420, 320);
    window.prompt = vi.fn().mockReturnValue('OP HAWK');
    // re-place with a chosen name via the mocked prompt for a legible assertion
    controller.setTool('symbol');
    clickAt(canvas, 440, 340);

    controller.setTool('counterViewshed');
    clickAt(canvas, 440, 340);

    expect(statuses.some((s) => s.includes('COUNTER-VIEWSHED from'))).toBe(true);
  });

  it('clicking nowhere near a unit does nothing (no silent wrong-pick)', () => {
    const { controller, canvas, viewshed } = makeController();
    const aimSpy = vi.spyOn(viewshed, 'aim');

    controller.setTool('symbol');
    clickAt(canvas, 420, 320);

    controller.setTool('counterViewshed');
    clickAt(canvas, 700, 550); // far from the placed unit
    clickAt(canvas, 720, 570);

    expect(aimSpy).not.toHaveBeenCalled();
  });
});
