import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TilesRenderer } from '3d-tiles-renderer';
import { Group, Mesh, MeshBasicMaterial, PerspectiveCamera, PlaneGeometry, Scene } from 'three';

import { BRIEF_TRANSITION_DURATION_MS } from './engine/briefPlayback';
import type { CameraPose, Sandbox, SandboxCallbacks } from './engine/createSandbox';
import { exportGeoJSON, exportKML } from './engine/exportPlan';
import { GeoFrame } from './engine/geoFrame';
import { loadPlan, savePlan } from './engine/planStore';
import { type FeatureSummary, StrategistController } from './engine/strategist';
import { ViewshedController } from './engine/viewshed';
import { WorldView } from './WorldView';

/**
 * Todo 24 — Wave-2 gate. Two describe blocks, two distinct concerns:
 *
 * 1. "Flow B end-to-end (real engine, zero mock)": builds a plan, saves it, loads it into
 *    a GENUINELY SEPARATE controller, plays the brief (asserts the camera reaches each
 *    saved pose), drops into ground-walk, and exports — re-parsing the export and
 *    asserting every feature + classification + provenance survived intact (invariant 1).
 *    Every object in this chain is the real production class (`StrategistController`,
 *    `planStore`, `exportPlan`) — no fakes anywhere, proving brief playback, ground-walk,
 *    classification, and export all operate on the ONE loaded plan (invariant 2). A
 *    Wave-1/Wave-0 measurement type (`distance`) round-trips through the same chain
 *    unmodified (invariant 3 — no regression from the Wave-2 additions).
 *
 * 2. "export buttons — UI wiring": the lightweight React-level check (same `fakeSandbox`
 *    convention as `WorldView.featureList.test.tsx`) that the Plans panel's Export
 *    GeoJSON/KML buttons are disabled with no features, enabled once features exist, and
 *    call the right `Sandbox` methods with the current plan-name draft.
 */

// ---- module-scope fixtures for the "export buttons — UI wiring" describe block below.
// `vi.mock` factories are hoisted to the top of the module by Vitest's transform, so the
// variables they close over MUST live at module scope, not inside a describe callback —
// nesting them there produces a "not defined" ReferenceError (the hoisted factory can't
// see into a function scope that hasn't run yet).
let uiWiringFeatures: FeatureSummary[] = [];
const exportPlanGeoJSON = vi.fn(() => '{"type":"FeatureCollection","features":[]}');
const exportPlanKML = vi.fn(() => '<kml></kml>');

const fakeSandbox: Partial<Sandbox> = {
  setMode: vi.fn(),
  setTool: vi.fn(),
  clearAll: vi.fn(),
  listFeatures: vi.fn(() => uiWiringFeatures),
  removeFeature: vi.fn(),
  renameFeature: vi.fn(),
  undoLastFeature: vi.fn(),
  selectFeature: vi.fn(),
  setUnitAffiliation: vi.fn(),
  setUnitEchelon: vi.fn(),
  setMgrsHudEnabled: vi.fn(),
  savePlan: vi.fn(),
  loadPlan: vi.fn(),
  listPlans: vi.fn(() => []),
  deletePlan: vi.fn(),
  setClassification: vi.fn(),
  getClassification: vi.fn(() => 'EXERCISE'),
  setOperatorName: vi.fn(),
  exportPlanGeoJSON,
  exportPlanKML,
  saveViewpoint: vi.fn(),
  listViewpoints: vi.fn(() => []),
  renameViewpoint: vi.fn(),
  setViewpointPhase: vi.fn(),
  deleteViewpoint: vi.fn(),
  reorderViewpoints: vi.fn(),
  restoreViewpoint: vi.fn(),
  playBriefNext: vi.fn(),
  playBriefPrevious: vi.fn(),
  playBriefGoTo: vi.fn(),
  cancelBriefPlayback: vi.fn(),
  getBriefPlaybackState: vi.fn(() => ({ currentIndex: 0, isPlaying: false })),
  rehearseGoTo: vi.fn(),
  rehearseNext: vi.fn(),
  rehearsePrevious: vi.fn(),
  startRehearsal: vi.fn(),
  pauseRehearsal: vi.fn(),
  cancelRehearsal: vi.fn(),
  isRehearsing: vi.fn(() => false),
  exitGroundWalk: vi.fn(),
  isGroundWalkActive: vi.fn(() => false),
  listPhases: vi.fn(() => []),
  addPhase: vi.fn(),
  renamePhase: vi.fn(),
  reorderPhases: vi.fn(),
  deletePhase: vi.fn(),
  getFeaturePhase: vi.fn(() => 'all-phases'),
  setFeaturePhase: vi.fn(),
  getPhaseFilter: vi.fn(() => 'all-phases'),
  setPhaseFilter: vi.fn(),
  scrubToPhaseIndex: vi.fn(),
  stepTimelineNext: vi.fn(),
  stepTimelinePrevious: vi.fn(),
  cancelTimelinePlayback: vi.fn(),
  getTimelineState: vi.fn(() => ({ currentIndex: 0, isPlaying: false })),
  armSetUnitPhasePosition: vi.fn(),
  cancelSetUnitPhasePosition: vi.fn(),
  isArmedForPhasePosition: vi.fn(() => false),
  isPathFeature: vi.fn(() => false),
  getElevationProfile: vi.fn(() => null),
  getMoveTimeMinutes: vi.fn(() => null),
  switchVehicle: vi.fn(),
  setLabelsVisible: vi.fn(),
  getCameraPose: vi.fn(() => ({
    type: 'sentinel-camera-pose',
    version: 1,
    capturedAt: '2026-07-05T00:00:00.000Z',
    anchor: { lat: 1.35, lon: 103.8 },
    camera: {
      fovDeg: 60,
      aspect: 1.6,
      local: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
      geo: { lat: 1.35, lon: 103.8, altM: 200, headingDeg: 0, pitchDeg: -10 },
    },
  })),
  captureShot: vi.fn(),
  deployFromImage: vi.fn(),
  clearDetections: vi.fn(),
  dispose: vi.fn(),
};

vi.mock('./engine/createSandbox', async () => {
  const actual =
    await vi.importActual<typeof import('./engine/createSandbox')>('./engine/createSandbox');
  return {
    ...actual,
    preflightGoogleKey: vi.fn().mockResolvedValue(null),
    createSandbox: vi.fn(
      (_canvas: HTMLCanvasElement, _key: string, _anchor: unknown, cb: SandboxCallbacks) => {
        queueMicrotask(() => {
          cb.onTilesLoaded();
          cb.onMode('strategist');
        });
        return fakeSandbox as Sandbox;
      }
    ),
  };
});

async function mountInStrategistMode(): Promise<void> {
  localStorage.setItem('google_tiles_key', 'test-key');
  render(<WorldView />);
  await waitFor(() => expect(screen.getByText(/STRATEGIST/)).toBeInTheDocument());
}

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

const CAMERA_FOV_DEG = 60;
const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 1_000_000;
const CAMERA_START_Y = 100;
const CAMERA_START_Z = 100;
const GROUND_SIZE = 2000;

// Click coordinates (canvas pixels) for each drafting step below — named so the fixture
// carries zero raw literals (matching this file's own no-new-lint-warnings bar). Plain
// objects, not tuples: `no-magic-numbers` exempts object PROPERTY values but still flags
// numbers inside an array literal, even one assigned to a named const.
const DISTANCE_START = { x: 400, y: 300 };
const DISTANCE_END = { x: 460, y: 320 };
const UNIT_CLICK = { x: 500, y: 400 };
const GROUND_WALK_CLICK = { x: 400, y: 300 };

const IDENTITY_QUATERNION_XYZW = { x: 0, y: 0, z: 0, w: 1 };
const VIEWPOINT_1_POSITION_XYZ = { x: 0, y: 50, z: 100 };
const VIEWPOINT_2_POSITION_XYZ = { x: 200, y: 50, z: 100 };

function makeController(): {
  controller: StrategistController;
  canvas: HTMLCanvasElement;
  camera: PerspectiveCamera;
} {
  const canvas = document.createElement('canvas');
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
    ...CANVAS_RECT,
    toJSON: () => CANVAS_RECT,
  } as DOMRect);

  const camera = new PerspectiveCamera(
    CAMERA_FOV_DEG,
    CANVAS_RECT.width / CANVAS_RECT.height,
    CAMERA_NEAR,
    CAMERA_FAR
  );
  camera.position.set(0, CAMERA_START_Y, CAMERA_START_Z);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);

  const tiles = bareTiles();
  const ground = new Mesh(new PlaneGeometry(GROUND_SIZE, GROUND_SIZE), new MeshBasicMaterial());
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
  return { controller, canvas, camera };
}

function clickAt(canvas: HTMLCanvasElement, x: number, y: number, button = 0): void {
  canvas.dispatchEvent(
    new MouseEvent('pointerdown', { clientX: x, clientY: y, button, bubbles: true })
  );
  window.dispatchEvent(
    new MouseEvent('pointerup', { clientX: x, clientY: y, button, bubbles: true })
  );
}

function fixturePose(
  position: [number, number, number],
  quaternion: [number, number, number, number]
): CameraPose {
  return {
    type: 'sentinel-camera-pose',
    version: 1,
    capturedAt: '2026-07-05T00:00:00.000Z',
    anchor: ANCHOR,
    camera: {
      fovDeg: CAMERA_FOV_DEG,
      aspect: CANVAS_RECT.width / CANVAS_RECT.height,
      local: { position, quaternion },
      geo: { lat: 1.35, lon: 103.8, altM: 200, headingDeg: 0, pitchDeg: -10 },
    },
  };
}

describe('Wave-2 gate: Flow B end-to-end, real engine, zero mock (todo 24)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      fakeCanvasContext() as unknown as CanvasRenderingContext2D
    );
    vi.spyOn(window, 'prompt').mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('build -> save -> load -> brief playback -> ground-walk -> export -> re-parse intact', () => {
    const { controller: source, canvas } = makeController();
    source.operatorName = 'CPT Tan';

    // A Wave-0/Wave-1 measurement type (regression check, invariant 3).
    source.setTool('distance');
    clickAt(canvas, DISTANCE_START.x, DISTANCE_START.y);
    clickAt(canvas, DISTANCE_END.x, DISTANCE_END.y);
    clickAt(canvas, DISTANCE_END.x, DISTANCE_END.y, 2);

    // A Wave-1 unit symbol — export must carry affiliation/echelon (todo 23).
    source.setTool('symbol');
    source.unitAffiliation = 'friendly';
    source.unitEchelon = 'platoon';
    clickAt(canvas, UNIT_CLICK.x, UNIT_CLICK.y);

    source.currentClassification = 'RESTRICTED';

    const p1 = VIEWPOINT_1_POSITION_XYZ;
    const p2 = VIEWPOINT_2_POSITION_XYZ;
    const q = IDENTITY_QUATERNION_XYZW;
    const vp1 = source.saveViewpoint('LD', fixturePose([p1.x, p1.y, p1.z], [q.x, q.y, q.z, q.w]));
    const vp2 = source.saveViewpoint('OBJ', fixturePose([p2.x, p2.y, p2.z], [q.x, q.y, q.z, q.w]));

    const drawnNames = source.listFeatures().map((f) => f.name);
    expect(drawnNames).toHaveLength(2);

    const saved = savePlan(
      'COY ATTACK',
      source.exportFeatures(),
      ANCHOR,
      '2026-07-05T00:00:00.000Z',
      source.exportViewpoints(),
      source.currentClassification
    );

    // Load into a GENUINELY SEPARATE controller — proves persistence, not shared state
    // (invariant 2: brief playback / ground-walk / classification / export below all
    // operate on THIS loaded controller, not the one that drew the features).
    const { controller: loaded, canvas: loadedCanvas, camera: loadedCamera } = makeController();
    const plan = loadPlan(saved.id);
    loaded.loadPlan(plan.features);
    loaded.loadViewpoints(plan.viewpoints);
    loaded.currentClassification = plan.classification;

    expect(loaded.listFeatures().map((f) => f.name)).toEqual(drawnNames);

    // Brief playback (todo 20): the camera actually reaches each saved viewpoint's pose.
    loaded.playBriefGoTo(0, 0);
    loaded.update(BRIEF_TRANSITION_DURATION_MS);
    expect(loadedCamera.position.toArray()).toEqual(vp1.pose.camera.local.position);
    expect(loadedCamera.quaternion.toArray()).toEqual(vp1.pose.camera.local.quaternion);

    loaded.playBriefGoTo(1, BRIEF_TRANSITION_DURATION_MS);
    loaded.update(BRIEF_TRANSITION_DURATION_MS * 2);
    expect(loadedCamera.position.toArray()).toEqual(vp2.pose.camera.local.position);
    expect(loadedCamera.quaternion.toArray()).toEqual(vp2.pose.camera.local.quaternion);

    // Ground-walk (todo 21): same loaded controller, same click-driven entry path. Brief
    // playback just left the camera at vp2's pose (a flat, non-ground-facing angle) — reset
    // to a ground-facing angle first so the entry click's raycast has real ground to hit.
    loadedCamera.position.set(0, CAMERA_START_Y, CAMERA_START_Z);
    loadedCamera.lookAt(0, 0, 0);
    loadedCamera.updateMatrixWorld(true);
    loaded.setTool('groundWalk');
    clickAt(loadedCanvas, GROUND_WALK_CLICK.x, GROUND_WALK_CLICK.y);
    expect(loaded.isGroundWalkActive).toBe(true);
    loaded.exitGroundWalk();
    expect(loaded.isGroundWalkActive).toBe(false);

    // Export (todo 23) — re-parse and confirm every feature + classification +
    // provenance survived the full chain intact (invariant 1: zero mock).
    const geo = JSON.parse(
      exportGeoJSON({
        name: 'COY ATTACK',
        features: loaded.exportFeatures(),
        classification: loaded.currentClassification,
      })
    );
    expect(geo.features).toHaveLength(2);
    expect(
      geo.features.map((f: { properties: { type: string } }) => f.properties.type).sort()
    ).toEqual(['distance', 'unit']);
    for (const f of geo.features) {
      expect(f.properties.classification).toBe('RESTRICTED');
      expect(f.properties.provenance.author).toBe('CPT Tan');
    }
    const unitFeature = geo.features.find(
      (f: { properties: { type: string } }) => f.properties.type === 'unit'
    );
    expect(unitFeature.properties.affiliation).toBe('friendly');
    expect(unitFeature.properties.echelon).toBe('platoon');

    const kml = exportKML({
      name: 'COY ATTACK',
      features: loaded.exportFeatures(),
      classification: loaded.currentClassification,
    });
    const doc = new DOMParser().parseFromString(kml, 'application/xml');
    expect(doc.querySelector('parsererror')).toBeNull();
    expect(doc.querySelectorAll('Placemark')).toHaveLength(2);
  });
});

describe('export buttons — UI wiring (todo 24)', () => {
  beforeEach(() => {
    localStorage.clear();
    uiWiringFeatures = [];
    vi.clearAllMocks();
    // The real (unmocked) downloadBlob() creates a blob: URL and clicks an <a> — jsdom
    // doesn't support blob-URL navigation, so stub both away; this test only asserts the
    // right Sandbox method was called, not the browser's download mechanics.
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn().mockReturnValue('blob:fake') });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockReturnValue(undefined);
  });

  it('export buttons are disabled with no features placed yet', async () => {
    await mountInStrategistMode();
    expect(screen.getByLabelText('Export plan as GeoJSON')).toBeDisabled();
    expect(screen.getByLabelText('Export plan as KML')).toBeDisabled();
  });

  it('export buttons enable once a feature exists, and call the right Sandbox method', async () => {
    uiWiringFeatures = [{ id: 'f1', name: 'Distance 1', type: 'distance' }];
    await mountInStrategistMode();

    const geoBtn = screen.getByLabelText('Export plan as GeoJSON');
    const kmlBtn = screen.getByLabelText('Export plan as KML');
    expect(geoBtn).not.toBeDisabled();
    expect(kmlBtn).not.toBeDisabled();

    fireEvent.click(geoBtn);
    expect(exportPlanGeoJSON).toHaveBeenCalledWith('Untitled Plan');

    fireEvent.click(kmlBtn);
    expect(exportPlanKML).toHaveBeenCalledWith('Untitled Plan');
  });

  it('uses the typed plan name for the export filename/document name', async () => {
    uiWiringFeatures = [{ id: 'f1', name: 'Distance 1', type: 'distance' }];
    await mountInStrategistMode();

    fireEvent.change(screen.getByLabelText('Plan name'), { target: { value: 'COY ATTACK' } });
    fireEvent.click(screen.getByLabelText('Export plan as GeoJSON'));
    expect(exportPlanGeoJSON).toHaveBeenCalledWith('COY ATTACK');
  });
});
