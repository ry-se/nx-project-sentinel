import type { PerspectiveCamera } from 'three';

import type { CameraPose } from './createSandbox';

/** A saved camera bookmark, ordered into a brief sequence. Reuses the existing
 * intel-import `CameraPose` serialization (lossless position+quaternion) — not a
 * lat/lon-only summary — so a bookmark restores the EXACT view (invariant 1). */
export interface Viewpoint {
  id: string;
  name: string;
  order: number;
  pose: CameraPose;
  /** The phase this viewpoint narrates (todo 27, Wave 3 R3) — when a guided rehearsal
   * steps to this viewpoint, the timeline (todo 26) also advances to this phase, so the
   * audience sees the right vantage of the right phase together. `undefined` (no
   * declared phase) leaves the timeline exactly where it was — not every viewpoint needs
   * to narrate a phase change. */
  phaseId?: string;
}

/** Restores the camera's exact position AND orientation (invariant 3 — not just
 * position) from a saved viewpoint's lossless pose. */
export function restoreViewpointPose(camera: PerspectiveCamera, pose: CameraPose): void {
  camera.position.fromArray(pose.camera.local.position);
  camera.quaternion.fromArray(pose.camera.local.quaternion);
  camera.updateMatrixWorld();
}
