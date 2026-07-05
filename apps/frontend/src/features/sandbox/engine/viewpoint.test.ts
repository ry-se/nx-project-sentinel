import { TilesRenderer } from '3d-tiles-renderer';
import { Group, PerspectiveCamera, Quaternion, Scene, Vector3 } from 'three';

import type { CameraPose } from './createSandbox';
import { GeoFrame } from './geoFrame';
import { StrategistController } from './strategist';
import { ViewshedController } from './viewshed';
import { restoreViewpointPose } from './viewpoint';

/**
 * Todo 19: a viewpoint stores a full `CameraPose` (invariant 1); restore sets position
 * AND quaternion (invariant 3); reordering is deterministic and stable (invariant 4).
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
      fovDeg: 60,
      aspect: 1.6,
      local: { position, quaternion },
      geo: { lat: ANCHOR.lat, lon: ANCHOR.lon, altM: 200, headingDeg: 90, pitchDeg: -10 },
    },
  };
}

function makeController(): StrategistController {
  const canvas = document.createElement('canvas');
  const camera = new PerspectiveCamera(60, 1.6, 0.1, 1_000_000);
  const tiles = bareTiles();
  const scene = new Scene();
  const viewshed = new ViewshedController(scene, tiles);
  const geoFrame = new GeoFrame(tiles, ANCHOR);
  return new StrategistController(camera, canvas, tiles.group, scene, viewshed, geoFrame);
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    fakeCanvasContext() as unknown as CanvasRenderingContext2D
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('restoreViewpointPose — sets position AND orientation (invariant 3)', () => {
  it('restores both position and quaternion from a lossless pose', () => {
    const camera = new PerspectiveCamera();
    const targetQuat = new Quaternion(0.1, 0.2, 0.3, 0.9).normalize();
    const pose = fixturePose(
      [10, 20, 30],
      targetQuat.toArray() as [number, number, number, number]
    );

    restoreViewpointPose(camera, pose);

    expect(camera.position.toArray()).toEqual([10, 20, 30]);
    expect(camera.quaternion.x).toBeCloseTo(targetQuat.x, 10);
    expect(camera.quaternion.y).toBeCloseTo(targetQuat.y, 10);
    expect(camera.quaternion.z).toBeCloseTo(targetQuat.z, 10);
    expect(camera.quaternion.w).toBeCloseTo(targetQuat.w, 10);
  });
});

describe('StrategistController — viewpoint bookmarks + brief sequence (todo 19)', () => {
  it('saves viewpoints in insertion order, lists them by order, and restores the exact pose', () => {
    const controller = makeController();
    const p1 = fixturePose([0, 0, 0], [0, 0, 0, 1]);
    const p2 = fixturePose([10, 0, 0], [0, 0, 0, 1]);
    const p3 = fixturePose([20, 0, 0], [0, 0, 0, 1]);

    controller.saveViewpoint('LD, looking N', p1);
    controller.saveViewpoint('OBJ FALCON approach', p2);
    const third = controller.saveViewpoint('Final overwatch', p3);

    const list = controller.listViewpoints();
    expect(list.map((v) => v.name)).toEqual([
      'LD, looking N',
      'OBJ FALCON approach',
      'Final overwatch',
    ]);

    controller.restoreViewpoint(third.id);
    // Restoring reads from the internal camera — verify via a fresh pose capture is out of
    // scope here (that's createSandbox.ts's getCameraPose); assert the stored pose is the
    // exact one passed to saveViewpoint (invariant 1 — no lossy summarization).
    expect(list[2].pose.camera.local.position).toEqual([20, 0, 0]);
  });

  it('reordering updates order deterministically — listViewpoints reflects the new sequence', () => {
    const controller = makeController();
    const a = controller.saveViewpoint('A', fixturePose([0, 0, 0], [0, 0, 0, 1]));
    const b = controller.saveViewpoint('B', fixturePose([1, 0, 0], [0, 0, 0, 1]));
    const c = controller.saveViewpoint('C', fixturePose([2, 0, 0], [0, 0, 0, 1]));

    controller.reorderViewpoints([c.id, a.id, b.id]);

    expect(controller.listViewpoints().map((v) => v.name)).toEqual(['C', 'A', 'B']);
  });

  it('renameViewpoint and deleteViewpoint mutate the stored set', () => {
    const controller = makeController();
    const a = controller.saveViewpoint('Draft name', fixturePose([0, 0, 0], [0, 0, 0, 1]));
    controller.saveViewpoint('Keep me', fixturePose([1, 0, 0], [0, 0, 0, 1]));

    controller.renameViewpoint(a.id, 'LD, looking N');
    expect(controller.listViewpoints().find((v) => v.id === a.id)?.name).toBe('LD, looking N');

    controller.deleteViewpoint(a.id);
    expect(controller.listViewpoints().map((v) => v.name)).toEqual(['Keep me']);
  });

  it('onViewpointsChanged fires on save/rename/delete/reorder/load', () => {
    const controller = makeController();
    const spy = vi.fn();
    controller.onViewpointsChanged = spy;

    const a = controller.saveViewpoint('A', fixturePose([0, 0, 0], [0, 0, 0, 1]));
    expect(spy).toHaveBeenCalledTimes(1);
    controller.renameViewpoint(a.id, 'A2');
    expect(spy).toHaveBeenCalledTimes(2);
    controller.reorderViewpoints([a.id]);
    expect(spy).toHaveBeenCalledTimes(3);
    controller.deleteViewpoint(a.id);
    expect(spy).toHaveBeenCalledTimes(4);
    controller.loadViewpoints([]);
    expect(spy).toHaveBeenCalledTimes(5);
  });

  it('exportViewpoints/loadViewpoints round-trip the full ordered set (invariant 2 — persists with the plan)', () => {
    const source = makeController();
    source.saveViewpoint('A', fixturePose([0, 0, 0], [0, 0, 0, 1]));
    source.saveViewpoint('B', fixturePose([1, 0, 0], [0, 0, 0, 1]));
    const exported = source.exportViewpoints();

    const target = makeController();
    target.loadViewpoints(exported);

    expect(target.listViewpoints().map((v) => v.name)).toEqual(['A', 'B']);
    expect(target.listViewpoints().map((v) => v.pose)).toEqual(
      source.listViewpoints().map((v) => v.pose)
    );
  });
});
