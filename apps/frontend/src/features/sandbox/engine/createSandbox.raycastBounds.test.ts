import {
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Raycaster,
  Vector2,
} from 'three';

import { DEPLOY_RAYCAST_MAX_DISTANCE, raycastBoundedHit } from './createSandbox';

/** Real Three.js primitives throughout — Raycaster/Camera/Mesh are deterministic geometry
 * math, no WebGL/canvas needed, so this exercises the actual bound behavior rather than a
 * mock of it. Regression guard for workspaces/sentinel/journal/0012 (unbounded raycast
 * produced a wild-outlier world placement). */
function camera(): PerspectiveCamera {
  const cam = new PerspectiveCamera(60, 1, 0.1, 1_000_000);
  // Default orientation looks down -Z — place targets at negative Z ahead of it.
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  return cam;
}

/** A large flat plane, face-on to the camera at the origin, positioned so the raycast hit
 * lands at EXACTLY `distance` from the camera — a plane's own thickness is zero, unlike a
 * box's half-extent, so there's no surface-offset to account for. */
function planeAtDistance(distance: number): Mesh {
  const mesh = new Mesh(new PlaneGeometry(2000, 2000), new MeshBasicMaterial());
  mesh.position.set(0, 0, -distance); // default plane normal is +Z — faces back at the camera
  mesh.updateMatrixWorld(true);
  return mesh;
}

describe('raycastBoundedHit', () => {
  it('finds a hit well within the bound', () => {
    const hit = raycastBoundedHit(
      new Raycaster(),
      new Vector2(0, 0),
      camera(),
      planeAtDistance(DEPLOY_RAYCAST_MAX_DISTANCE - 100)
    );
    expect(hit).not.toBeNull();
  });

  it('rejects a hit beyond the bound — the wild-outlier regression guard', () => {
    const hit = raycastBoundedHit(
      new Raycaster(),
      new Vector2(0, 0),
      camera(),
      planeAtDistance(DEPLOY_RAYCAST_MAX_DISTANCE + 100)
    );
    expect(hit).toBeNull();
  });

  it('finds a hit exactly at the bound edge (inclusive)', () => {
    const hit = raycastBoundedHit(
      new Raycaster(),
      new Vector2(0, 0),
      camera(),
      planeAtDistance(DEPLOY_RAYCAST_MAX_DISTANCE)
    );
    expect(hit).not.toBeNull();
  });

  it('a previously-unbounded case (10x the max distance) is now rejected, not placed', () => {
    // This is exactly the class of failure journal/0012 traced: an imprecise pixel
    // coordinate aiming the ray toward geometry far beyond any plausible capture range.
    const hit = raycastBoundedHit(
      new Raycaster(),
      new Vector2(0, 0),
      camera(),
      planeAtDistance(DEPLOY_RAYCAST_MAX_DISTANCE * 10)
    );
    expect(hit).toBeNull();
  });
});
