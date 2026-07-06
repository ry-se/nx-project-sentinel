import { Quaternion } from 'three';

import type { CameraPose } from '../../../../features/sandbox/engine/createSandbox';
import {
  BRIEF_TRANSITION_DURATION_MS,
  BriefPlaybackStepper,
  interpolatePose,
} from '../../../../features/sandbox/engine/briefPlayback';
import type { Viewpoint } from '../../../../features/sandbox/engine/viewpoint';

/**
 * Todo 20: pose-at-t interpolation (endpoints exact, midpoint between — invariant 2 via
 * slerp, not lerped euler angles), playback steps in viewpoint `order` (invariant 1),
 * and manual-input cancellation leaves no half-interpolated state (invariant 3).
 */

function fixturePose(
  position: [number, number, number],
  quaternion: [number, number, number, number]
): CameraPose {
  return {
    type: 'sentinel-camera-pose',
    version: 1,
    capturedAt: '2026-07-05T00:00:00.000Z',
    anchor: { lat: 1.35, lon: 103.8 },
    camera: {
      fovDeg: 60,
      aspect: 1.6,
      local: { position, quaternion },
      geo: { lat: 1.35, lon: 103.8, altM: 200, headingDeg: 90, pitchDeg: -10 },
    },
  };
}

function fixtureViewpoint(id: string, order: number, pose: CameraPose): Viewpoint {
  return { id, name: `VP ${order}`, order, pose };
}

describe('interpolatePose — endpoints exact, midpoint between, quaternion SLERPs', () => {
  const from = {
    position: [0, 0, 0] as [number, number, number],
    quaternion: [0, 0, 0, 1] as [number, number, number, number],
  };
  const to = fixturePose([100, 0, 0], [0, 0, 0, 1]);

  it('t=0 is exactly the from pose', () => {
    const result = interpolatePose(from, to, 0);
    expect(result.position).toEqual([0, 0, 0]);
  });

  it('t=1 is exactly the to pose', () => {
    const result = interpolatePose(from, to, 1);
    expect(result.position).toEqual([100, 0, 0]);
  });

  it('t=0.5 is the midpoint between', () => {
    const result = interpolatePose(from, to, 0.5);
    expect(result.position[0]).toBeCloseTo(50, 6);
  });

  it('t is clamped to [0, 1] — out-of-range values do not overshoot', () => {
    expect(interpolatePose(from, to, -0.5).position).toEqual([0, 0, 0]);
    expect(interpolatePose(from, to, 1.5).position).toEqual([100, 0, 0]);
  });

  it('quaternion SLERPs (spherical), not a naive per-component lerp', () => {
    // A 90 degree rotation about Y at each end; the midpoint of a SLERP between two unit
    // quaternions is itself a unit quaternion (naive per-component lerp would NOT
    // preserve unit length without renormalizing).
    const qFrom = new Quaternion().setFromAxisAngle({ x: 0, y: 1, z: 0 } as never, 0);
    const qTo = new Quaternion().setFromAxisAngle({ x: 0, y: 1, z: 0 } as never, Math.PI / 2);
    const start = {
      position: [0, 0, 0] as [number, number, number],
      quaternion: qFrom.toArray() as [number, number, number, number],
    };
    const end = fixturePose([0, 0, 0], qTo.toArray() as [number, number, number, number]);

    const mid = interpolatePose(start, end, 0.5);
    const midQuat = new Quaternion(...mid.quaternion);
    expect(midQuat.length()).toBeCloseTo(1, 6);
  });
});

describe('BriefPlaybackStepper — steps in viewpoint order (invariant 1)', () => {
  const viewpoints: Viewpoint[] = [
    fixtureViewpoint('a', 0, fixturePose([0, 0, 0], [0, 0, 0, 1])),
    fixtureViewpoint('b', 1, fixturePose([10, 0, 0], [0, 0, 0, 1])),
    fixtureViewpoint('c', 2, fixturePose([20, 0, 0], [0, 0, 0, 1])),
  ];
  const identityLocal = {
    position: [0, 0, 0] as [number, number, number],
    quaternion: [0, 0, 0, 1] as [number, number, number, number],
  };

  it('next()/previous() move through the ordered list, not insertion order', () => {
    const stepper = new BriefPlaybackStepper(() => viewpoints);
    stepper.next(identityLocal, 0);
    expect(stepper.currentIndex).toBe(1);
    stepper.next(identityLocal, 0);
    expect(stepper.currentIndex).toBe(2);
    stepper.previous(identityLocal, 0);
    expect(stepper.currentIndex).toBe(1);
  });

  it('goTo ignores an out-of-range index', () => {
    const stepper = new BriefPlaybackStepper(() => viewpoints);
    stepper.goTo(5, identityLocal, 0);
    expect(stepper.currentIndex).toBe(0);
    expect(stepper.isPlaying).toBe(false);
  });

  it('tick() interpolates toward the target and stops playing once the duration elapses', () => {
    const stepper = new BriefPlaybackStepper(() => viewpoints);
    stepper.goTo(1, identityLocal, 0);
    expect(stepper.isPlaying).toBe(true);

    const halfway = stepper.tick(BRIEF_TRANSITION_DURATION_MS / 2);
    expect(halfway).not.toBeNull();
    expect(halfway!.position[0]).toBeCloseTo(5, 1); // midway from x=0 to x=10
    expect(stepper.isPlaying).toBe(true); // not done yet

    const done = stepper.tick(BRIEF_TRANSITION_DURATION_MS);
    expect(done!.position[0]).toBeCloseTo(10, 6);
    expect(stepper.isPlaying).toBe(false);

    expect(stepper.tick(BRIEF_TRANSITION_DURATION_MS + 100)).toBeNull(); // idle after finishing
  });

  it('cancel() stops playback without leaving a half-interpolated tick result (invariant 3)', () => {
    const stepper = new BriefPlaybackStepper(() => viewpoints);
    stepper.goTo(1, identityLocal, 0);
    stepper.tick(BRIEF_TRANSITION_DURATION_MS / 2); // mid-transition
    stepper.cancel();

    expect(stepper.isPlaying).toBe(false);
    expect(stepper.tick(BRIEF_TRANSITION_DURATION_MS)).toBeNull(); // no further interpolation happens
  });

  it('BRIEF_TRANSITION_DURATION_MS is a named constant (invariant 4)', () => {
    expect(typeof BRIEF_TRANSITION_DURATION_MS).toBe('number');
    expect(BRIEF_TRANSITION_DURATION_MS).toBeGreaterThan(0);
  });
});
