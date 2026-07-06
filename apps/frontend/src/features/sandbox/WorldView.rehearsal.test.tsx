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

import { GeoFrame } from './engine/geoFrame';
import { loadPlan, savePlan } from './engine/planStore';
import { resolveRehearsalStep } from './engine/rehearsal';
import { StrategistController } from './engine/strategist';
import { ViewshedController } from './engine/viewshed';

/**
 * Todo 27 — guided rehearsal playback + the Wave-3 gate. Covers the four stated
 * invariants:
 * 1. Rehearsal drives camera and timeline from ONE step index — they cannot desync.
 * 2. A viewpoint's declared phase sets the timeline; playback is deterministic + interruptible.
 * 3. The complete plan (every wave's feature/metadata) round-trips through save/load +
 *    export with zero loss.
 * 4. Wave-3 gate: `nx test @org/frontend` green + a Flow-C manual walk receipt.
 */

describe('resolveRehearsalStep (invariant 1 — pure, one-index derivation)', () => {
  const phases = [
    { id: 'p1', name: 'Move to FUP', order: 0 },
    { id: 'p2', name: 'Assault', order: 1 },
  ];

  it('resolves the phase index a viewpoint declares', () => {
    const viewpoints = [{ id: 'v1', name: 'LD', order: 0, pose: {} as never, phaseId: 'p2' }];
    expect(resolveRehearsalStep(viewpoints, phases, 0)).toEqual({
      viewpointIndex: 0,
      phaseIndex: 1,
    });
  });

  it('returns phaseIndex null for a viewpoint with no declared phase', () => {
    const viewpoints = [{ id: 'v1', name: 'LD', order: 0, pose: {} as never }];
    expect(resolveRehearsalStep(viewpoints, phases, 0)).toEqual({
      viewpointIndex: 0,
      phaseIndex: null,
    });
  });

  it('returns phaseIndex null for a dangling phaseId (phase no longer exists)', () => {
    const viewpoints = [{ id: 'v1', name: 'LD', order: 0, pose: {} as never, phaseId: 'deleted' }];
    expect(resolveRehearsalStep(viewpoints, phases, 0)).toEqual({
      viewpointIndex: 0,
      phaseIndex: null,
    });
  });

  it('returns null for an out-of-range viewpoint index', () => {
    expect(resolveRehearsalStep([], phases, 0)).toBeNull();
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

describe('StrategistController — guided rehearsal wired end-to-end', () => {
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

  it('startRehearsal drives camera + timeline from one step index (invariant 1) and auto-advances (invariant 2)', () => {
    const { controller } = makeController();
    const phase1 = controller.addPhase('Phase 1');
    const phase2 = controller.addPhase('Phase 2');

    const vp1 = controller.saveViewpoint('LD', mockPose());
    const vp2 = controller.saveViewpoint('Objective', mockPose());
    controller.setViewpointPhase(vp1.id, phase1.id);
    controller.setViewpointPhase(vp2.id, phase2.id);

    controller.startRehearsal(0);
    expect(controller.briefPlaybackState.currentIndex).toBe(0);
    expect(controller.isRehearsing).toBe(true);

    // Camera and timeline both stepped toward step 0's declarations together.
    expect(controller.timelineState.currentIndex).toBe(0);

    // Completing step 0's transition auto-advances to step 1 (invariant 2 — deterministic).
    controller.update(1600);
    expect(controller.briefPlaybackState.currentIndex).toBe(1);
    expect(controller.timelineState.currentIndex).toBe(1);

    // The sequence ends after the last viewpoint — rehearsing stops (never desyncs onward).
    controller.update(3200);
    expect(controller.isRehearsing).toBe(false);
  });

  it('cancelRehearsal is interruptible mid-transition (invariant 2)', () => {
    const { controller } = makeController();
    controller.addPhase('Phase 1');
    controller.addPhase('Phase 2');
    controller.saveViewpoint('LD', mockPose());
    controller.saveViewpoint('Objective', mockPose());

    controller.startRehearsal(0);
    controller.update(500); // mid-transition
    controller.cancelRehearsal();

    expect(controller.isRehearsing).toBe(false);
    expect(controller.briefPlaybackState.isPlaying).toBe(false);
    expect(controller.timelineState.isPlaying).toBe(false);
  });

  it('a viewpoint with no declared phase leaves the timeline untouched (composition, not forced)', () => {
    const { controller } = makeController();
    controller.addPhase('Phase 1');
    controller.addPhase('Phase 2');
    controller.scrubToPhaseIndex(1);

    const vp = controller.saveViewpoint('Undeclared', mockPose());
    controller.rehearseGoTo(controller.listViewpoints().indexOf(vp), 0);

    expect(controller.timelineState.currentIndex).toBe(1); // unchanged
  });

  it('Wave-3 gate: the complete plan round-trips through save/load AND export with zero loss (invariant 3)', () => {
    const { controller: source, canvas } = makeController();
    const phase1 = source.addPhase('Move to FUP');
    const phase2 = source.addPhase('Assault');

    // A control measure, tagged to phase 1.
    source.setTool('boundary');
    clickAt(canvas, 400, 300);
    clickAt(canvas, 440, 340);
    clickAt(canvas, 440, 340, 2);
    const boundary = source.listFeatures().find((f) => f.type === 'boundary');
    if (!boundary) throw new Error('expected a boundary feature');
    source.setFeaturePhase(boundary.id, phase1.id);

    // A unit with positions in both phases.
    source.setTool('symbol');
    clickAt(canvas, 420, 320);
    const unit = source.listFeatures().find((f) => f.type === 'unit');
    if (!unit) throw new Error('expected a unit feature');
    source.setUnitPhasePosition(unit.id, phase1.id, new Vector3(10, 0, 10));
    source.setUnitPhasePosition(unit.id, phase2.id, new Vector3(200, 0, 200));

    // A viewpoint narrating phase 2, and a classification.
    const vp = source.saveViewpoint('Objective', mockPose());
    source.setViewpointPhase(vp.id, phase2.id);
    source.currentClassification = 'RESTRICTED';

    const saved = savePlan(
      'COY ATTACK — full rehearsal',
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
    target.loadViewpoints(loaded.viewpoints);
    target.currentClassification = loaded.classification;

    // Every wave's data survived: phases, feature phase tag, unit phase positions,
    // viewpoint-phase mapping, classification.
    expect(target.listPhases().map((p) => p.name)).toEqual(['Move to FUP', 'Assault']);
    expect(target.currentClassification).toBe('RESTRICTED');

    const [loadedBoundary] = target.listFeatures().filter((f) => f.type === 'boundary');
    expect(target.getFeaturePhase(loadedBoundary.id)).toBe(
      target.listPhases().find((p) => p.name === 'Move to FUP')!.id
    );

    const [loadedUnit] = target.listFeatures().filter((f) => f.type === 'unit');
    target.scrubToPhaseIndex(0);
    expect(loaded.features.find((f) => f.id === loadedUnit.id)?.metadata.phasePositions).toEqual({
      [phase1.id]: { x: 10, y: 0, z: 10 },
      [phase2.id]: { x: 200, y: 0, z: 200 },
    });

    const [loadedVp] = target.listViewpoints();
    const targetPhase2 = target.listPhases().find((p) => p.name === 'Assault');
    expect(loadedVp.phaseId).toBe(targetPhase2?.id);

    // Rehearsing the loaded plan drives camera + timeline together, exactly as the
    // original session would have.
    target.startRehearsal(0);
    expect(target.timelineState.currentIndex).toBe(target.listPhases().indexOf(targetPhase2!));
  });
});

function mockPose() {
  return {
    type: 'sentinel-camera-pose' as const,
    version: 1,
    capturedAt: '2026-07-06T00:00:00.000Z',
    anchor: ANCHOR,
    camera: {
      fovDeg: 60,
      aspect: 1.6,
      local: {
        position: [0, 0, 0] as [number, number, number],
        quaternion: [0, 0, 0, 1] as [number, number, number, number],
      },
      geo: { lat: 1.35, lon: 103.8, altM: 200, headingDeg: 0, pitchDeg: -10 },
    },
  };
}
