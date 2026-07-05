import { TilesRenderer } from '3d-tiles-renderer';
import { Group, Mesh, MeshBasicMaterial, PerspectiveCamera, PlaneGeometry, Scene } from 'three';

import { GeoFrame } from './geoFrame';
import { loadPlan, savePlan } from './planStore';
import { StrategistController } from './strategist';
import { ViewshedController } from './viewshed';

/**
 * Todo 18 — the Wave-1 gate: builds a mixed feature set (control measures + a unit
 * symbol + a pre-existing measurement tool), saves it, reloads it into a FRESH
 * `StrategistController` (a genuinely separate instance — no shared in-memory state),
 * and asserts the rebuilt scene matches. Every layer is REAL: real pointer-event
 * drafting, the real `planStore` over jsdom's real `localStorage`, the real
 * `rebuildFeature` seam — zero mock/placeholder data anywhere in the load path
 * (invariant 3).
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

function makeController(): { controller: StrategistController; canvas: HTMLCanvasElement } {
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

describe('plan persistence — Wave-1 gate: mixed feature set survives save -> fresh-controller load', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      fakeCanvasContext() as unknown as CanvasRenderingContext2D
    );
    vi.spyOn(window, 'prompt').mockImplementation((_msg, def) => def ?? null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('every Wave-1 feature type round-trips through save/load into a fresh controller (invariant 1)', () => {
    const source = makeController();

    // A pre-existing measurement tool (distance)...
    source.controller.setTool('distance');
    clickAt(source.canvas, 400, 300);
    clickAt(source.canvas, 460, 320);
    clickAt(source.canvas, 460, 320, 2);

    // ...a control measure (boundary)...
    source.controller.setTool('boundary');
    clickAt(source.canvas, 400, 300);
    clickAt(source.canvas, 440, 340);
    clickAt(source.canvas, 440, 340, 2);

    // ...an axis of advance...
    source.controller.setTool('axis');
    clickAt(source.canvas, 400, 300);
    clickAt(source.canvas, 380, 340);
    clickAt(source.canvas, 380, 340, 2);

    // ...and a unit symbol.
    source.controller.unitAffiliation = 'enemy';
    source.controller.unitEchelon = 'section';
    source.controller.setTool('symbol');
    clickAt(source.canvas, 420, 320);

    expect(source.controller.featureCount).toBe(4);
    const original = source.controller.exportFeatures();
    expect(original.map((f) => f.type).sort()).toEqual(
      ['axis', 'boundary', 'distance', 'unit'].sort()
    );

    const saved = savePlan('COY ATTACK', original, ANCHOR, '2026-07-05T00:00:00.000Z');

    // A GENUINELY separate controller — its own canvas, camera, scene, tiles, viewshed.
    const target = makeController();
    expect(target.controller.featureCount).toBe(0);

    const loaded = loadPlan(saved.id);
    target.controller.loadPlan(loaded.features);

    expect(target.controller.featureCount).toBe(4);
    const rebuilt = target.controller.listFeatures();
    expect(rebuilt.map((f) => f.type).sort()).toEqual(original.map((f) => f.type).sort());
    expect(rebuilt.map((f) => f.name).sort()).toEqual(original.map((f) => f.name).sort());

    // Reload restores features at their captured geo positions (invariant 2 / todo 11
    // invariant 2) — every point's geo survives the round trip byte-for-byte, since
    // rebuildFeature never recomputes geo, only local->Group.
    const reExported = target.controller.exportFeatures();
    const byId = new Map(original.map((f) => [f.id, f]));
    for (const f of reExported) {
      expect(f.points.geo).toEqual(byId.get(f.id)?.points.geo);
    }
  });

  it('loadPlan on the SAME controller replaces (not appends to) the current scene', () => {
    const { controller, canvas } = makeController();
    controller.setTool('distance');
    clickAt(canvas, 400, 300);
    clickAt(canvas, 460, 320);
    clickAt(canvas, 460, 320, 2);
    expect(controller.featureCount).toBe(1);

    const saved = savePlan('Solo', controller.exportFeatures(), ANCHOR, '2026-07-05T00:00:00.000Z');
    controller.loadPlan(loadPlan(saved.id).features);

    expect(controller.featureCount).toBe(1); // not 2 — load replaces, doesn't append
  });
});
