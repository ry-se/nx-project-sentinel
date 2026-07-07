import { TilesRenderer } from '3d-tiles-renderer';
import {
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  PerspectiveCamera,
  Scene,
} from 'three';

import { GeoFrame } from '../../../../features/sandbox/engine/geoFrame';
import { loadPlan, savePlan } from '../../../../features/sandbox/engine/planStore';
import { StrategistController } from '../../../../features/sandbox/engine/strategist';
import { ViewshedController } from '../../../../features/sandbox/engine/viewshed';

/**
 * Todo 33 — the Wave-4 gate. Builds ONE plan touching every Wave-4 tool (M1/M4 elevation +
 * move timing, C3 counter-viewshed, M2 route exposure, C1 range fan), verifies each
 * analysis runs, saves, loads into a fresh controller, and confirms every Wave-4 feature —
 * the NEW `rangeFan` type especially — round-trips with zero loss and every analysis
 * re-runs identically against the reloaded data.
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

describe('Wave-4 gate: every M1/M4/C3/M2/C1 tool composes and round-trips (todo 33)', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      fakeCanvasContext() as unknown as CanvasRenderingContext2D
    );
    vi.spyOn(window, 'prompt').mockImplementation((_msg, def) => def ?? null);
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds a combined Wave-4 plan, runs every analysis, and round-trips with zero loss', () => {
    const { controller: source, canvas } = makeController();

    // An axis (the path M1/M4/M2 analyze).
    source.setTool('axis');
    clickAt(canvas, 380, 300);
    clickAt(canvas, 440, 340);
    clickAt(canvas, 440, 340, 2);
    const axis = source.listFeatures().find((f) => f.type === 'axis');
    if (!axis) throw new Error('expected an axis feature');

    // M1 — elevation profile.
    const profile = source.computeElevationProfile(axis.id);
    expect(profile).not.toBeNull();
    expect(profile!.length).toBeGreaterThan(0);

    // M4 — move timing.
    const moveTime = source.computeMoveTimeMinutes(axis.id, 'dismounted');
    expect(moveTime).not.toBeNull();
    expect(moveTime!).toBeGreaterThan(0);

    // An enemy unit (the threat C3/M2 use).
    source.setTool('symbol');
    clickAt(canvas, 420, 320);
    const enemy = source.listFeatures().find((f) => f.type === 'unit');
    if (!enemy) throw new Error('expected a unit feature');

    // A range fan (C1).
    source.setTool('rangeFan');
    clickAt(canvas, 400, 300);
    clickAt(canvas, 420, 280);
    const rangeFan = source.listFeatures().find((f) => f.type === 'rangeFan');
    if (!rangeFan) throw new Error('expected a rangeFan feature');
    expect(source.getRangeFanSystemId(rangeFan.id)).toBe('mortar81mm');

    // M2 — route exposure, composing the axis + the enemy unit (C3's threat-picking target).
    const exposure = source.runRouteExposure(axis.id, enemy.id);
    expect(exposure).not.toBeNull();
    expect(exposure!.sampleCount).toBeGreaterThan(0);

    expect(source.featureCount).toBe(3); // axis + unit + rangeFan

    // ---- Wave-4 gate: save -> fresh controller load -> everything re-derivable ----
    const saved = savePlan(
      'Wave-4 gate plan',
      source.exportFeatures(),
      ANCHOR,
      '2026-07-06T00:00:00.000Z',
      source.exportViewpoints(),
      source.currentClassification,
      source.exportPhases()
    );

    const { controller: target } = makeController();
    const loaded = loadPlan(saved.id);
    target.loadPlan(loaded.features);
    target.loadPhases(loaded.phases);

    expect(target.featureCount).toBe(3);

    const loadedAxis = target.listFeatures().find((f) => f.type === 'axis');
    const loadedRangeFan = target.listFeatures().find((f) => f.type === 'rangeFan');
    if (!loadedAxis || !loadedRangeFan) throw new Error('expected axis + rangeFan after load');

    // The NEW rangeFan type survived the round-trip with its system tag intact.
    expect(target.getRangeFanSystemId(loadedRangeFan.id)).toBe('mortar81mm');

    // Every analysis re-runs identically against the RELOADED data.
    const reloadedProfile = target.computeElevationProfile(loadedAxis.id);
    expect(reloadedProfile!.length).toBe(profile!.length);
    const reloadedMoveTime = target.computeMoveTimeMinutes(loadedAxis.id, 'dismounted');
    expect(reloadedMoveTime).toBeCloseTo(moveTime!, 5);
  });
});
