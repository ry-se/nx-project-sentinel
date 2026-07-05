import { Quaternion, Vector3 } from 'three';

import type { CameraPose } from './createSandbox';
import type { Viewpoint } from './viewpoint';

/** A named constant, not a magic literal at the call site (invariant 4). */
export const BRIEF_TRANSITION_DURATION_MS = 1500;

export interface LocalPose {
  position: [number, number, number];
  quaternion: [number, number, number, number];
}

/** Lerps position, SLERPS the quaternion (invariant 2 — never lerp-then-normalize euler
 * angles, which introduces gimbal/roll artifacts). `t` is clamped to [0, 1] — `t=0` is
 * exactly `from`, `t=1` is exactly `to` (endpoint-exact, per the todo's own acceptance).
 * `from` is the LIVE camera's current transient position (never a saved pose); `to` is a
 * saved viewpoint's `CameraPose`. */
export function interpolatePose(from: LocalPose, to: CameraPose, t: number): LocalPose {
  const clampedT = Math.min(1, Math.max(0, t));
  const position = new Vector3(...from.position).lerp(
    new Vector3(...to.camera.local.position),
    clampedT
  );
  const quaternion = new Quaternion(...from.quaternion).slerp(
    new Quaternion(...to.camera.local.quaternion),
    clampedT
  );
  return {
    position: position.toArray() as [number, number, number],
    quaternion: quaternion.toArray() as [number, number, number, number],
  };
}

/**
 * Steps through an ordered viewpoint list, interpolating the camera from its CURRENT
 * (live) pose to the target viewpoint's saved pose over `BRIEF_TRANSITION_DURATION_MS`.
 * Every method takes `nowMs` as an explicit argument (never reads `performance.now()`
 * internally), so the stepper stays deterministically testable.
 */
export class BriefPlaybackStepper {
  private index = 0;
  private transitionFrom: LocalPose | null = null;
  private transitionStartMs: number | null = null;
  private playing = false;

  constructor(private getViewpoints: () => Viewpoint[]) {}

  public get isPlaying(): boolean {
    return this.playing;
  }

  /** The viewpoint index the stepper is currently AT or TRANSITIONING TO. */
  public get currentIndex(): number {
    return this.index;
  }

  /** Steps in the viewpoint `order` (invariant 1) — `getViewpoints()` is expected to
   * already be sorted by order (`StrategistController.listViewpoints()`'s contract). */
  public goTo(index: number, fromLocal: LocalPose, nowMs: number): void {
    const viewpoints = this.getViewpoints();
    if (index < 0 || index >= viewpoints.length) return;
    this.index = index;
    this.transitionFrom = fromLocal;
    this.transitionStartMs = nowMs;
    this.playing = true;
  }

  public next(fromLocal: LocalPose, nowMs: number): void {
    this.goTo(this.index + 1, fromLocal, nowMs);
  }

  public previous(fromLocal: LocalPose, nowMs: number): void {
    this.goTo(this.index - 1, fromLocal, nowMs);
  }

  /** Manual camera input cancels playback without leaving the camera half-interpolated
   * (invariant 3) — the camera simply stops wherever it was; nothing snaps. */
  public cancel(): void {
    this.playing = false;
    this.transitionFrom = null;
    this.transitionStartMs = null;
  }

  /** Called every frame. Returns the pose to apply to the camera this frame, or `null`
   * when not transitioning (idle, or the transition just finished). */
  public tick(nowMs: number): LocalPose | null {
    if (!this.playing || !this.transitionFrom || this.transitionStartMs === null) return null;
    const target = this.getViewpoints()[this.index];
    if (!target) {
      this.cancel();
      return null;
    }
    const t = (nowMs - this.transitionStartMs) / BRIEF_TRANSITION_DURATION_MS;
    const pose = interpolatePose(this.transitionFrom, target.pose, t);
    if (t >= 1) this.playing = false;
    return pose;
  }
}
