import { TilesRenderer } from '3d-tiles-renderer';
import { Group, Mesh, MeshBasicMaterial, PerspectiveCamera, PlaneGeometry, Scene } from 'three';

import { GeoFrame } from '../../../../features/sandbox/engine/geoFrame';
import { StrategistController } from '../../../../features/sandbox/engine/strategist';
import { ViewshedController } from '../../../../features/sandbox/engine/viewshed';

/**
 * Todo 12: `listFeatures`/`removeFeature`/`renameFeature`/`undoLast`/`selectFeature`,
 * driven through the REAL pointer-event drafting path (not a bypass) so the test proves
 * the controller's public feature-list API against features actually drawn.
 */

function fakeCanvasContext() {
  const measureText = () => ({ width: 42 });
  return new Proxy(
    { measureText },
    { get: (target, prop) => (prop in target ? (target as never)[prop] : vi.fn()) }
  );
}

/** An untransformed tiles group (identity matrix) — these tests exercise the picking +
 * feature-list API, not geo accuracy, so the anchor-recentering rotation deployE2E.test.ts
 * needs is unnecessary overhead here. */
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

function makeController(): { controller: StrategistController; canvas: HTMLCanvasElement } {
  const canvas = document.createElement('canvas');
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
    ...CANVAS_RECT,
    toJSON: () => CANVAS_RECT,
  } as DOMRect);

  // Angled downward look (avoids the lookAt() singularity of a straight-down view) at a
  // large horizontal ground plane, so every click on the canvas raycasts to a real point.
  const camera = new PerspectiveCamera(60, CANVAS_RECT.width / CANVAS_RECT.height, 0.1, 1_000_000);
  camera.position.set(0, 100, 100);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);

  const tiles = bareTiles();
  const ground = new Mesh(new PlaneGeometry(2000, 2000), new MeshBasicMaterial());
  ground.rotation.x = -Math.PI / 2; // lie flat, normal facing +Y (up)
  tiles.group.add(ground);
  // `TilesGroup.updateMatrixWorld` only cascades to children when the GROUP's own transform
  // changed since last update — update the freshly-added child directly (see the identical
  // note in strategist.planFeature.test.ts).
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

// jsdom does not implement the PointerEvent constructor; the controller's handlers only
// read clientX/clientY/button, so a plain MouseEvent dispatched under the 'pointerdown'/
// 'pointerup' type strings triggers the same listeners.
function clickAt(canvas: HTMLCanvasElement, x: number, y: number, button = 0): void {
  canvas.dispatchEvent(
    new MouseEvent('pointerdown', { clientX: x, clientY: y, button, bubbles: true })
  );
  window.dispatchEvent(
    new MouseEvent('pointerup', { clientX: x, clientY: y, button, bubbles: true })
  );
}

describe('StrategistController — feature list API (todo 12)', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      fakeCanvasContext() as unknown as CanvasRenderingContext2D
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists, renames, selects, deletes, and undoes features drawn via real pointer events', () => {
    const { controller, canvas } = makeController();

    controller.setTool('distance');
    clickAt(canvas, 400, 300);
    clickAt(canvas, 460, 320);
    clickAt(canvas, 460, 320, 2); // right-click finishes the polyline

    controller.setTool('arc');
    clickAt(canvas, 400, 300);
    clickAt(canvas, 440, 300);
    clickAt(canvas, 400, 260); // 3rd point auto-finalizes the arc

    expect(controller.featureCount).toBe(2);
    const afterDraw = controller.listFeatures();
    expect(afterDraw.map((f) => f.type)).toEqual(['distance', 'arc']);

    const [distanceRow, arcRow] = afterDraw;

    controller.renameFeature(distanceRow.id, 'PL COBRA');
    expect(controller.listFeatures()[0].name).toBe('PL COBRA');

    controller.selectFeature(distanceRow.id);
    expect(controller.selectedFeatureId).toBe(distanceRow.id);
    controller.selectFeature(null);
    expect(controller.selectedFeatureId).toBeNull();

    controller.removeFeature(arcRow.id);
    expect(controller.featureCount).toBe(1);
    expect(controller.listFeatures().map((f) => f.id)).toEqual([distanceRow.id]);

    controller.undoLast();
    expect(controller.featureCount).toBe(0);
    expect(controller.listFeatures()).toEqual([]);
  });

  it('renameFeature/removeFeature/undoLast on an unknown id are no-ops', () => {
    const { controller, canvas } = makeController();
    controller.setTool('distance');
    clickAt(canvas, 400, 300);
    clickAt(canvas, 460, 320);
    clickAt(canvas, 460, 320, 2);

    controller.renameFeature('does-not-exist', 'x');
    controller.removeFeature('does-not-exist');
    expect(controller.featureCount).toBe(1);
  });

  it('notifies onFeaturesChanged on add, rename, remove, undo, and clearAll', () => {
    const { controller, canvas } = makeController();
    const spy = vi.fn();
    controller.onFeaturesChanged = spy;

    controller.setTool('distance');
    clickAt(canvas, 400, 300);
    clickAt(canvas, 460, 320);
    clickAt(canvas, 460, 320, 2);
    expect(spy).toHaveBeenCalledTimes(1);

    const id = controller.listFeatures()[0].id;
    controller.renameFeature(id, 'renamed');
    expect(spy).toHaveBeenCalledTimes(2);

    controller.undoLast();
    expect(spy).toHaveBeenCalledTimes(3);

    controller.clearAll();
    expect(spy).toHaveBeenCalledTimes(4); // clearAll fires even with zero features left
  });

  it('clearAll and removeFeature drop the in-scene selection highlight', () => {
    const { controller, canvas } = makeController();
    controller.setTool('distance');
    clickAt(canvas, 400, 300);
    clickAt(canvas, 460, 320);
    clickAt(canvas, 460, 320, 2);

    const id = controller.listFeatures()[0].id;
    controller.selectFeature(id);
    expect(controller.selectedFeatureId).toBe(id);

    controller.removeFeature(id);
    expect(controller.selectedFeatureId).toBeNull();
  });
});
