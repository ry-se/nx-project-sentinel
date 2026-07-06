import { TilesRenderer } from '3d-tiles-renderer';
import { Group, Mesh, MeshBasicMaterial, PerspectiveCamera, PlaneGeometry, Scene } from 'three';

import { GeoFrame } from '../../../../features/sandbox/engine/geoFrame';
import { ALL_PHASES, isFeatureVisibleForPhase, resolveFeaturePhase } from '../../../../features/sandbox/engine/planFeature';
import { loadPlan, savePlan } from '../../../../features/sandbox/engine/planStore';
import { StrategistController } from '../../../../features/sandbox/engine/strategist';
import { ViewshedController } from '../../../../features/sandbox/engine/viewshed';

/**
 * Todo 25 — phase tagging. Covers the four stated invariants:
 * 1. `metadata.phase` validated against `Plan.phases` — no dangling references.
 * 2. Show/hide toggles `Group.visible`, not add/remove.
 * 3. An untagged feature defaults to "all phases" (always visible).
 * 4. Phases + tags survive save/load/export.
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

/** `StrategistController.features` is private — reached here only to assert `Group.visible`
 * directly (invariant 2 is specifically about the `Group`, not about a public getter this
 * todo doesn't otherwise need). Throws rather than non-null-asserting on a missing id. */
function groupVisible(controller: StrategistController, featureId: string): boolean {
  const internals = controller as unknown as {
    features: { id: string; group: { visible: boolean } }[];
  };
  const feature = internals.features.find((f) => f.id === featureId);
  if (!feature) throw new Error(`no feature with id ${featureId}`);
  return feature.group.visible;
}

describe('resolveFeaturePhase (invariant 1 + 3 — pure validation)', () => {
  it('an untagged feature (no metadata.phase) resolves to ALL_PHASES', () => {
    expect(resolveFeaturePhase({}, new Set(['p1']))).toBe(ALL_PHASES);
  });

  it('a feature tagged to a phase that still exists resolves to that phase', () => {
    expect(resolveFeaturePhase({ phase: 'p1' }, new Set(['p1', 'p2']))).toBe('p1');
  });

  it('a dangling reference (tagged phase no longer in the valid set) falls back to ALL_PHASES', () => {
    expect(resolveFeaturePhase({ phase: 'deleted-phase' }, new Set(['p1']))).toBe(ALL_PHASES);
  });

  it('a malformed metadata.phase (non-string) falls back to ALL_PHASES', () => {
    expect(resolveFeaturePhase({ phase: 42 }, new Set(['p1']))).toBe(ALL_PHASES);
  });
});

describe('isFeatureVisibleForPhase (pure show/hide predicate)', () => {
  it('an all-phase feature is always visible, regardless of filter', () => {
    expect(isFeatureVisibleForPhase(ALL_PHASES, 'p1')).toBe(true);
    expect(isFeatureVisibleForPhase(ALL_PHASES, ALL_PHASES)).toBe(true);
  });

  it('with no filter (ALL_PHASES) every feature is visible', () => {
    expect(isFeatureVisibleForPhase('p1', ALL_PHASES)).toBe(true);
  });

  it('a phase-tagged feature is visible only when the filter matches', () => {
    expect(isFeatureVisibleForPhase('p1', 'p1')).toBe(true);
    expect(isFeatureVisibleForPhase('p1', 'p2')).toBe(false);
  });
});

describe('Plan.phases persistence (invariant 4)', () => {
  beforeEach(() => localStorage.clear());

  it('savePlan defaults phases to an empty list when not specified', () => {
    const saved = savePlan('Untitled', [], ANCHOR, '2026-07-06T00:00:00.000Z');
    expect(saved.phases).toEqual([]);
  });

  it('savePlan persists an explicit phase list through load', () => {
    const phases = [
      { id: 'p1', name: 'Move to FUP', order: 0 },
      { id: 'p2', name: 'Assault', order: 1 },
    ];
    const saved = savePlan(
      'COY ATTACK',
      [],
      ANCHOR,
      '2026-07-06T00:00:00.000Z',
      [],
      'EXERCISE',
      phases
    );
    expect(loadPlan(saved.id).phases).toEqual(phases);
  });
});

describe('StrategistController — phase tagging wired end-to-end', () => {
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

  it('addPhase/renamePhase/reorderPhases manage the plan-level phase list', () => {
    const { controller } = makeController();
    const p1 = controller.addPhase('Move to FUP');
    const p2 = controller.addPhase('Assault');
    expect(controller.listPhases().map((p) => p.name)).toEqual(['Move to FUP', 'Assault']);

    controller.renamePhase(p1.id, 'Move to Assembly Area');
    expect(controller.listPhases()[0].name).toBe('Move to Assembly Area');

    controller.reorderPhases([p2.id, p1.id]);
    expect(controller.listPhases().map((p) => p.id)).toEqual([p2.id, p1.id]);
  });

  it('an untagged feature stays visible under any phase filter (invariant 3)', () => {
    const { controller, canvas } = makeController();
    const phase = controller.addPhase('Phase 1');
    controller.setTool('objective');
    clickAt(canvas, 420, 320);
    const [feature] = controller.listFeatures();

    controller.setPhaseFilter(phase.id);
    expect(controller.getFeaturePhase(feature.id)).toBe(ALL_PHASES);
  });

  it('setPhaseFilter shows only the tagged phase (+ all-phase) features via Group.visible (invariant 2)', () => {
    const { controller, canvas } = makeController();
    const phase1 = controller.addPhase('Phase 1');
    const phase2 = controller.addPhase('Phase 2');

    controller.setTool('objective');
    clickAt(canvas, 420, 320);
    const [objA] = controller.listFeatures();
    controller.setFeaturePhase(objA.id, phase1.id);

    controller.setTool('objective');
    clickAt(canvas, 440, 340);
    const objB = controller.listFeatures().find((f) => f.id !== objA.id);
    if (!objB) throw new Error('expected a second placed feature');
    controller.setFeaturePhase(objB.id, phase2.id);

    controller.setPhaseFilter(phase1.id);
    expect(groupVisible(controller, objA.id)).toBe(true);
    expect(groupVisible(controller, objB.id)).toBe(false);

    // Groups are still present (not destroyed) — only visibility toggled.
    expect(controller.featureCount).toBe(2);
  });

  it('deletePhase clears dangling references back to ALL_PHASES (invariant 1)', () => {
    const { controller, canvas } = makeController();
    const phase = controller.addPhase('Phase 1');
    controller.setTool('objective');
    clickAt(canvas, 420, 320);
    const [feature] = controller.listFeatures();
    controller.setFeaturePhase(feature.id, phase.id);
    expect(controller.getFeaturePhase(feature.id)).toBe(phase.id);

    controller.deletePhase(phase.id);
    expect(controller.listPhases()).toEqual([]);
    expect(controller.getFeaturePhase(feature.id)).toBe(ALL_PHASES);
  });

  it('phases + feature tags survive save -> fresh-controller load (invariant 4)', () => {
    const { controller: source, canvas } = makeController();
    const phase1 = source.addPhase('Move to FUP');
    source.addPhase('Assault');
    source.setTool('objective');
    clickAt(canvas, 420, 320);
    const [feature] = source.listFeatures();
    source.setFeaturePhase(feature.id, phase1.id);

    const saved = savePlan(
      'COY ATTACK',
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

    expect(target.listPhases().map((p) => p.name)).toEqual(['Move to FUP', 'Assault']);
    const [loadedFeature] = target.listFeatures();
    expect(target.getFeaturePhase(loadedFeature.id)).toBe(phase1.id);
  });
});
