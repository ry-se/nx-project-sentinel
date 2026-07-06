import {
  Euler,
  type Object3D,
  type PerspectiveCamera,
  Quaternion,
  Raycaster,
  Vector3,
} from 'three';

import { SANDBOX_COMMON, SANDBOX_MISC } from '@/constants';

/** A standing soldier's eye height above the ground — extends the LOS `EYE_HEIGHT`
 * naming convention (`planFeature.ts`) into this distinct domain (invariant 4). */
export const EYE_HEIGHT_STANDING_M = 1.7;

const MAX_PITCH_RAD = (SANDBOX_MISC.GROUND_WALK_PITCH_DEG * Math.PI) / SANDBOX_COMMON.DEGREES_HALF_TURN;
const MOVE_SPEED_M_PER_S = 3.5;
/** How far above the anchor to start the down-raycast from — comfortably above any
 * plausible terrain/building height in this engine's scenes. */
const RAYCAST_START_HEIGHT_M = 5000;

/** Raycasts straight down at `(x, z)` to find the terrain surface, returning
 * `surfaceY + eyeHeight` — or `null` if nothing is hit (e.g. off the loaded tile area).
 * Re-raycasting per position (rather than interpolating/assuming) is what keeps the
 * walk height honest as the ground rises and falls (invariant 1). */
export function groundWalkEyeY(
  raycaster: Raycaster,
  tiles: Object3D,
  x: number,
  z: number,
  eyeHeight: number = EYE_HEIGHT_STANDING_M
): number | null {
  raycaster.set(new Vector3(x, RAYCAST_START_HEIGHT_M, z), new Vector3(0, -1, 0));
  raycaster.far = RAYCAST_START_HEIGHT_M * 2;
  const hits = raycaster.intersectObject(tiles, true);
  return hits.length > 0 ? hits[0].point.y + eyeHeight : null;
}

/** Yaw/pitch -> a look quaternion with NO roll (invariant 3). Pitch is clamped so the
 * camera can never rotate past looking straight up/down — no disorienting flip. Euler
 * order `'YXZ'` (yaw about world Y, then pitch about the resulting local X) is the
 * standard first-person-look convention. */
export function computeLookQuaternion(yaw: number, pitch: number): Quaternion {
  const clampedPitch = Math.max(-MAX_PITCH_RAD, Math.min(MAX_PITCH_RAD, pitch));
  return new Quaternion().setFromEuler(new Euler(clampedPitch, yaw, 0, 'YXZ'));
}

export interface SavedCameraState {
  position: [number, number, number];
  quaternion: [number, number, number, number];
}

export type MoveDirection = 'forward' | 'back' | 'left' | 'right';

/** Drops the camera to eye height at a clicked ground point and lets mouse-look + WASD/
 * arrow movement explore from there — a look-around confirm tool, not a full FPS
 * controller (no collision; walking through buildings is acceptable for a briefing
 * tool). Exiting restores the exact prior camera state (invariant 2). */
export class GroundWalkController {
  private yaw = 0;
  private pitch = 0;
  private x = 0;
  private z = 0;
  private saved: SavedCameraState | null = null;
  private moving: Record<MoveDirection, boolean> = {
    forward: false,
    back: false,
    left: false,
    right: false,
  };

  public get isActive(): boolean {
    return this.saved !== null;
  }

  public enter(
    camera: PerspectiveCamera,
    groundPoint: Vector3,
    raycaster: Raycaster,
    tiles: Object3D
  ): void {
    // Only capture the ORIGINAL camera on first entry — a fresh click while already
    // walking re-teleports without clobbering what exit() should restore (invariant 2).
    this.saved ??= {
      position: camera.position.toArray() as [number, number, number],
      quaternion: camera.quaternion.toArray() as [number, number, number, number],
    };
    this.x = groundPoint.x;
    this.z = groundPoint.z;
    this.yaw = 0;
    this.pitch = 0;
    const y =
      groundWalkEyeY(raycaster, tiles, this.x, this.z) ?? groundPoint.y + EYE_HEIGHT_STANDING_M;
    camera.position.set(this.x, y, this.z);
    camera.quaternion.copy(computeLookQuaternion(this.yaw, this.pitch));
  }

  public exit(camera: PerspectiveCamera): void {
    if (!this.saved) return;
    camera.position.fromArray(this.saved.position);
    camera.quaternion.fromArray(this.saved.quaternion);
    this.saved = null;
    this.moving = { forward: false, back: false, left: false, right: false };
  }

  public look(deltaYaw: number, deltaPitch: number): void {
    if (!this.isActive) return;
    this.yaw -= deltaYaw;
    this.pitch = Math.max(-MAX_PITCH_RAD, Math.min(MAX_PITCH_RAD, this.pitch - deltaPitch));
  }

  public setMoving(direction: MoveDirection, active: boolean): void {
    this.moving[direction] = active;
  }

  /** Called every frame while active: moves along the camera's own forward/right,
   * projected flat onto the XZ plane (so looking down/up doesn't tilt movement into the
   * ground or sky), then re-raycasts down for the new eye height (invariant 1). */
  public update(
    camera: PerspectiveCamera,
    raycaster: Raycaster,
    tiles: Object3D,
    dtSeconds: number
  ): void {
    if (!this.isActive) return;
    const forward = new Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new Vector3(forward.z, 0, -forward.x);
    const move = new Vector3();
    if (this.moving.forward) move.add(forward);
    if (this.moving.back) move.sub(forward);
    if (this.moving.right) move.add(right);
    if (this.moving.left) move.sub(right);
    if (move.lengthSq() > 0) {
      move.normalize().multiplyScalar(MOVE_SPEED_M_PER_S * dtSeconds);
      this.x += move.x;
      this.z += move.z;
    }
    const y = groundWalkEyeY(raycaster, tiles, this.x, this.z);
    camera.position.set(this.x, y ?? camera.position.y, this.z);
    camera.quaternion.copy(computeLookQuaternion(this.yaw, this.pitch));
  }
}
