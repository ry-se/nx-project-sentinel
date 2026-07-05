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

import { GeoFrame } from './geoFrame';
import { loadPlan, savePlan } from './planStore';
import { StrategistController } from './strategist';
import { PHASE_TRANSITION_DURATION_MS, TimelineStepper, unitPositionAt } from './timeline';
import { ViewshedController } from './viewshed';

/**
 * Todo 26 — timeline scrubber + unit movement between phases. Covers the five stated
 * invariants:
 * 1. Unit interpolation is a pure function of `phasePositions` + t (endpoint-exact, midpoint between).
 * 2. A unit with no position for a phase holds its last known position (never jumps to origin).
 * 3. Scrubbing composes with the todo-25 visibility filter (covered in strategist-level tests).
 * 4. `phasePositions` persist/export with the unit feature (covered in strategist-level tests).
 * 5. Interpolation duration/curve is a named constant.
 */

describe('unitPositionAt (invariant 1 — pure interpolation)', () => {
  const A = { x: 0, y: 0, z: 0 };
  const B = { x: 100, y: 10, z: 200 };

  it('is exact at t=0 (phaseA position) and t=1 (phaseB position)', () => {
    const positions = { p1: A, p2: B };
    expect(unitPositionAt(positions, 'p1', 'p2', 0)).toEqual(A);
    expect(unitPositionAt(positions, 'p1', 'p2', 1)).toEqual(B);
  });

  it('is the midpoint at t=0.5', () => {
    const positions = { p1: A, p2: B };
    expect(unitPositionAt(positions, 'p1', 'p2', 0.5)).toEqual({ x: 50, y: 5, z: 100 });
  });

  it('clamps t outside [0, 1]', () => {
    const positions = { p1: A, p2: B };
    expect(unitPositionAt(positions, 'p1', 'p2', -1)).toEqual(A);
    expect(unitPositionAt(positions, 'p1', 'p2', 2)).toEqual(B);
  });
});

describe('unitPositionAt (invariant 2 — holds last known position, never jumps to origin)', () => {
  const A = { x: 10, y: 0, z: 10 };
  const B = { x: 200, y: 0, z: 200 };

  it('holds at phaseA when phaseB has no recorded position', () => {
    const positions = { p1: A };
    expect(unitPositionAt(positions, 'p1', 'p2', 0)).toEqual(A);
    expect(unitPositionAt(positions, 'p1', 'p2', 0.5)).toEqual(A);
    expect(unitPositionAt(positions, 'p1', 'p2', 1)).toEqual(A);
  });

  it('shows phaseB immediately when phaseA has no recorded position (never a jump-from-nothing)', () => {
    const positions = { p2: B };
    expect(unitPositionAt(positions, 'p1', 'p2', 0)).toEqual(B);
    expect(unitPositionAt(positions, 'p1', 'p2', 1)).toEqual(B);
  });

  it('returns null (never origin) when neither phase has a recorded position', () => {
    expect(unitPositionAt({}, 'p1', 'p2', 0.5)).toBeNull();
  });
});

describe('PHASE_TRANSITION_DURATION_MS (invariant 5 — named constant)', () => {
  it('is a positive, named duration', () => {
    expect(PHASE_TRANSITION_DURATION_MS).toBeGreaterThan(0);
  });
});

describe('TimelineStepper', () => {
  it('scrubTo jumps instantly with no transition', () => {
    const stepper = new TimelineStepper(() => 3);
    expect(stepper.scrubTo(2)).toBe(true);
    expect(stepper.currentIndex).toBe(2);
    expect(stepper.isPlaying).toBe(false);
    expect(stepper.tick(1000)).toBeNull();
  });

  it('scrubTo rejects an out-of-range index and leaves the current index unchanged', () => {
    const stepper = new TimelineStepper(() => 3);
    stepper.scrubTo(1);
    expect(stepper.scrubTo(5)).toBe(false);
    expect(stepper.scrubTo(-1)).toBe(false);
    expect(stepper.currentIndex).toBe(1);
  });

  it('scrubTo on an empty phase list always fails', () => {
    const stepper = new TimelineStepper(() => 0);
    expect(stepper.scrubTo(0)).toBe(false);
  });

  it('next() animates a transition that ticks a blend then completes', () => {
    const stepper = new TimelineStepper(() => 3);
    expect(stepper.next(0)).toBe(true);
    expect(stepper.currentIndex).toBe(1);
    expect(stepper.isPlaying).toBe(true);

    const midBlend = stepper.tick(PHASE_TRANSITION_DURATION_MS / 2);
    expect(midBlend).toEqual({ fromIndex: 0, toIndex: 1, t: 0.5 });

    // Past the duration, the transition completes — tick returns null, playing stops.
    expect(stepper.tick(PHASE_TRANSITION_DURATION_MS + 1)).toBeNull();
    expect(stepper.isPlaying).toBe(false);
    expect(stepper.currentIndex).toBe(1);
  });

  it('previous() animates backward and next()/previous() are no-ops at the boundaries', () => {
    const stepper = new TimelineStepper(() => 3);
    stepper.scrubTo(0);
    expect(stepper.previous(0)).toBe(false); // already at index 0

    stepper.scrubTo(2);
    expect(stepper.next(0)).toBe(false); // already at the last index

    expect(stepper.previous(1000)).toBe(true);
    expect(stepper.currentIndex).toBe(1);
  });

  it('cancel() stops mid-transition without leaving it half-interpolated', () => {
    const stepper = new TimelineStepper(() => 3);
    stepper.next(0);
    expect(stepper.tick(100)).not.toBeNull();
    stepper.cancel();
    expect(stepper.isPlaying).toBe(false);
    expect(stepper.tick(200)).toBeNull();
  });

  it('tick() is null while idle', () => {
    const stepper = new TimelineStepper(() => 3);
    expect(stepper.tick(0)).toBeNull();
  });
});

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

interface ControllerInternals {
  features: {
    id: string;
    group: { visible: boolean; children: { position: { x: number; y: number; z: number } }[] };
  }[];
}

function findFeature(controller: StrategistController, featureId: string) {
  const feature = (controller as unknown as ControllerInternals).features.find(
    (f) => f.id === featureId
  );
  if (!feature) throw new Error(`no feature with id ${featureId}`);
  return feature;
}

function spritePosition(
  controller: StrategistController,
  featureId: string
): { x: number; y: number; z: number } {
  return findFeature(controller, featureId).group.children[0].position;
}

function groupVisible(controller: StrategistController, featureId: string): boolean {
  return findFeature(controller, featureId).group.visible;
}

describe('StrategistController — timeline wired end-to-end', () => {
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

  it('scrubToPhaseIndex composes visibility (todo 25) with unit position (invariant 3)', () => {
    const { controller, canvas } = makeController();
    const phase1 = controller.addPhase('Phase 1');
    const phase2 = controller.addPhase('Phase 2');

    controller.setTool('symbol');
    clickAt(canvas, 420, 320);
    const [unit] = controller.listFeatures();
    controller.setUnitPhasePosition(unit.id, phase1.id, new Vector3(10, 0, 10));
    controller.setUnitPhasePosition(unit.id, phase2.id, new Vector3(200, 0, 200));

    controller.setTool('boundary');
    clickAt(canvas, 400, 300);
    clickAt(canvas, 440, 340);
    clickAt(canvas, 440, 340, 2);
    const boundary = controller.listFeatures().find((f) => f.type === 'boundary');
    if (!boundary) throw new Error('expected a boundary feature');
    controller.setFeaturePhase(boundary.id, phase1.id);

    controller.scrubToPhaseIndex(1);
    // Visibility: phase1-only boundary hides at phase 2 (todo 25 composition).
    expect(controller.getFeaturePhase(boundary.id)).toBe(phase1.id);
    expect(groupVisible(controller, boundary.id)).toBe(false);
    // Position: the unit snaps to its recorded phase-2 position (+ the sprite lift).
    const pos = spritePosition(controller, unit.id);
    expect(pos.x).toBe(200);
    expect(pos.z).toBe(200);
  });

  it('unit positions interpolate smoothly during an animated timeline step (invariant 1 wired)', () => {
    const { controller, canvas } = makeController();
    const phase1 = controller.addPhase('Phase 1');
    const phase2 = controller.addPhase('Phase 2');

    controller.setTool('symbol');
    clickAt(canvas, 420, 320);
    const [unit] = controller.listFeatures();
    controller.setUnitPhasePosition(unit.id, phase1.id, new Vector3(0, 0, 0));
    controller.setUnitPhasePosition(unit.id, phase2.id, new Vector3(100, 0, 100));
    controller.scrubToPhaseIndex(0);

    controller.stepTimelineNext(0);
    controller.update(PHASE_TRANSITION_DURATION_MS / 2);

    const mid = spritePosition(controller, unit.id);
    expect(mid.x).toBeCloseTo(50);
    expect(mid.z).toBeCloseTo(50);
  });

  it('phasePositions persist through save -> fresh-controller load (invariant 4)', () => {
    const { controller: source, canvas } = makeController();
    const phase1 = source.addPhase('Move to FUP');

    source.setTool('symbol');
    clickAt(canvas, 420, 320);
    const [unit] = source.listFeatures();
    source.setUnitPhasePosition(unit.id, phase1.id, new Vector3(30, 0, 40));

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

    const [loadedUnit] = target.listFeatures();
    target.scrubToPhaseIndex(0);
    const pos = spritePosition(target, loadedUnit.id);
    expect(pos.x).toBe(30);
    expect(pos.z).toBe(40);
  });

  it('armSetUnitPhasePosition captures the next map click as the position (invariant 4 UI path)', () => {
    const { controller, canvas } = makeController();
    const phase1 = controller.addPhase('Phase 1');

    controller.setTool('symbol');
    clickAt(canvas, 420, 320);
    const [unit] = controller.listFeatures();

    controller.armSetUnitPhasePosition(unit.id, phase1.id);
    expect(controller.isArmedForPhasePosition).toBe(true);
    clickAt(canvas, 440, 340);
    expect(controller.isArmedForPhasePosition).toBe(false);

    controller.scrubToPhaseIndex(0);
    const pos = spritePosition(controller, unit.id);
    expect(pos.x).not.toBe(0);
  });
});
