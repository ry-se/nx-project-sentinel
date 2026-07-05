import { TilesRenderer } from '3d-tiles-renderer';
import {
  Euler,
  Group,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Raycaster,
  Vector3,
} from 'three';

import {
  computeLookQuaternion,
  EYE_HEIGHT_STANDING_M,
  GroundWalkController,
  groundWalkEyeY,
} from './groundWalk';

/**
 * Todo 21: ground-walk height tracks the terrain surface via re-raycasting (invariant 1),
 * entering/exiting preserves the prior camera exactly (invariant 2), mouse-look clamps
 * pitch with no roll (invariant 3), and the eye height is a named constant (invariant 4).
 */

function bareTiles(): TilesRenderer {
  const tiles = new TilesRenderer();
  tiles.group.raycast = Group.prototype.raycast;
  return tiles;
}

function flatGround(tiles: TilesRenderer, y = 0): void {
  const ground = new Mesh(new PlaneGeometry(2000, 2000), new MeshBasicMaterial());
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = y;
  tiles.group.add(ground);
  ground.updateMatrixWorld(true);
}

describe('groundWalkEyeY — surface-follow height (invariant 1)', () => {
  it('returns surfaceY + eyeHeight when the raycast hits ground', () => {
    const tiles = bareTiles();
    flatGround(tiles, 0);
    const y = groundWalkEyeY(new Raycaster(), tiles.group, 0, 0);
    expect(y).toBeCloseTo(EYE_HEIGHT_STANDING_M, 6);
  });

  it('tracks a DIFFERENT surface height at a different XZ (a "hill")', () => {
    const tiles = bareTiles();
    // Two disjoint ground patches at different heights, standing in for a hill.
    const low = new Mesh(new PlaneGeometry(100, 100), new MeshBasicMaterial());
    low.rotation.x = -Math.PI / 2;
    low.position.set(0, 0, 0);
    const high = new Mesh(new PlaneGeometry(100, 100), new MeshBasicMaterial());
    high.rotation.x = -Math.PI / 2;
    high.position.set(500, 20, 0);
    tiles.group.add(low, high);
    low.updateMatrixWorld(true);
    high.updateMatrixWorld(true);

    const yLow = groundWalkEyeY(new Raycaster(), tiles.group, 0, 0);
    const yHigh = groundWalkEyeY(new Raycaster(), tiles.group, 500, 0);
    expect(yLow).toBeCloseTo(EYE_HEIGHT_STANDING_M, 6);
    expect(yHigh).toBeCloseTo(20 + EYE_HEIGHT_STANDING_M, 6);
  });

  it('returns null when nothing is under the point (off the loaded tile area)', () => {
    const tiles = bareTiles(); // no ground mesh at all
    expect(groundWalkEyeY(new Raycaster(), tiles.group, 0, 0)).toBeNull();
  });

  it('uses a custom eye height when provided', () => {
    const tiles = bareTiles();
    flatGround(tiles, 0);
    expect(groundWalkEyeY(new Raycaster(), tiles.group, 0, 0, 2.5)).toBeCloseTo(2.5, 6);
  });
});

describe('computeLookQuaternion — no roll, pitch clamped (invariant 3)', () => {
  it('clamps pitch so the camera never flips past straight up/down', () => {
    const extreme = computeLookQuaternion(0, Math.PI); // 180 deg — way past vertical
    const camera = new PerspectiveCamera();
    camera.quaternion.copy(extreme);
    const forward = new Vector3();
    camera.getWorldDirection(forward);
    // Clamped to ~89 degrees — forward.y should approach but never reach +-1 (straight
    // up/down), and critically must not flip past it to the opposite hemisphere.
    expect(Math.abs(forward.y)).toBeLessThan(1);
    expect(Math.abs(forward.y)).toBeGreaterThan(0.9);
  });

  it('produces zero roll at any yaw/pitch — the camera "up" stays world-up-ish', () => {
    const quat = computeLookQuaternion(Math.PI / 3, 0.4);
    const camera = new PerspectiveCamera();
    camera.quaternion.copy(quat);
    const up = new Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    // With zero roll, the camera's local up has no world-Z-axis-driven sideways lean
    // beyond what pitch alone produces; the vector stays in the (rotated) vertical plane
    // through the look direction, i.e. its horizontal component is purely a function of
    // yaw — not an independent roll term. Assert via a round-trip: reconstructing the
    // Euler from this quaternion (same 'YXZ' order) must yield ~zero Z (roll).
    const roundTrip = new Euler().setFromQuaternion(quat, 'YXZ');
    expect(roundTrip.z).toBeCloseTo(0, 6);
    void up;
  });
});

describe('GroundWalkController — enter/exit restores the exact prior camera (invariant 2)', () => {
  function makeCamera(): PerspectiveCamera {
    const cam = new PerspectiveCamera(60, 1.6, 0.1, 1_000_000);
    cam.position.set(10, 200, 30);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld(true);
    return cam;
  }

  it('drops the camera to eye height at the clicked point on enter', () => {
    const tiles = bareTiles();
    flatGround(tiles, 0);
    const camera = makeCamera();
    const controller = new GroundWalkController();

    controller.enter(camera, new Vector3(15, 0, 25), new Raycaster(), tiles.group);

    expect(camera.position.x).toBeCloseTo(15, 6);
    expect(camera.position.z).toBeCloseTo(25, 6);
    expect(camera.position.y).toBeCloseTo(EYE_HEIGHT_STANDING_M, 6);
    expect(controller.isActive).toBe(true);
  });

  it('exit restores position AND orientation exactly as they were before entering', () => {
    const tiles = bareTiles();
    flatGround(tiles, 0);
    const camera = makeCamera();
    const originalPosition = camera.position.clone();
    const originalQuaternion = camera.quaternion.clone();
    const controller = new GroundWalkController();

    controller.enter(camera, new Vector3(0, 0, 0), new Raycaster(), tiles.group);
    controller.look(0.5, 0.2); // look around while walking
    controller.exit(camera);

    expect(camera.position.toArray()).toEqual(originalPosition.toArray());
    expect(camera.quaternion.toArray()).toEqual(originalQuaternion.toArray());
    expect(controller.isActive).toBe(false);
  });

  it('a second enter() while already active re-teleports WITHOUT clobbering the original saved state', () => {
    const tiles = bareTiles();
    flatGround(tiles, 0);
    const camera = makeCamera();
    const originalPosition = camera.position.clone();
    const controller = new GroundWalkController();

    controller.enter(camera, new Vector3(0, 0, 0), new Raycaster(), tiles.group);
    controller.enter(camera, new Vector3(50, 0, 50), new Raycaster(), tiles.group); // re-click elsewhere
    expect(camera.position.x).toBeCloseTo(50, 6); // moved to the new spot

    controller.exit(camera);
    expect(camera.position.toArray()).toEqual(originalPosition.toArray()); // still restores the ORIGINAL
  });

  it('update() moves along the look direction and re-raycasts for height (invariant 1)', () => {
    const tiles = bareTiles();
    const low = new Mesh(new PlaneGeometry(2000, 2000), new MeshBasicMaterial());
    low.rotation.x = -Math.PI / 2;
    low.position.y = 0;
    // A small raised step a few metres along the walk's forward path (-Z from origin) —
    // small enough (half-extent 4) that its z-range [-9, -1] does NOT cover the z=0
    // starting point, so entry still measures the flat `low` ground underneath it.
    const step = new Mesh(new PlaneGeometry(8, 8), new MeshBasicMaterial());
    step.rotation.x = -Math.PI / 2;
    step.position.set(0, 5, -5);
    tiles.group.add(low, step);
    low.updateMatrixWorld(true);
    step.updateMatrixWorld(true);

    const camera = makeCamera();
    const controller = new GroundWalkController();
    controller.enter(camera, new Vector3(0, 0, 0), new Raycaster(), tiles.group);
    expect(camera.position.y).toBeCloseTo(EYE_HEIGHT_STANDING_M, 6);

    controller.setMoving('forward', true);
    // 60 frames at 1/30s and 3.5 m/s covers 7m toward -Z — comfortably into the step's
    // z-range [-9, -1], where the raycaster hits the (higher) step, not the flat ground.
    for (let i = 0; i < 60; i++) {
      controller.update(camera, new Raycaster(), tiles.group, 1 / 30);
    }
    expect(camera.position.z).toBeLessThan(-1); // confirms it actually walked into the step's footprint
    expect(camera.position.y).toBeGreaterThan(EYE_HEIGHT_STANDING_M);
  });

  it('exit() clears all held-movement state so a stale key does not move the NEXT walk', () => {
    const tiles = bareTiles();
    flatGround(tiles, 0);
    const camera = makeCamera();
    const controller = new GroundWalkController();

    controller.enter(camera, new Vector3(0, 0, 0), new Raycaster(), tiles.group);
    controller.setMoving('forward', true);
    controller.exit(camera);

    controller.enter(camera, new Vector3(0, 0, 0), new Raycaster(), tiles.group);
    const before = camera.position.clone();
    controller.update(camera, new Raycaster(), tiles.group, 1 / 30);
    expect(camera.position.x).toBeCloseTo(before.x, 6);
    expect(camera.position.z).toBeCloseTo(before.z, 6);
  });
});
