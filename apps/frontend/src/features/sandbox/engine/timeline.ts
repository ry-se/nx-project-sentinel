import type { LocalPoint } from './planFeature';

/** A named constant, not a magic literal at the call site (invariant 5) — matches the
 * `BRIEF_TRANSITION_DURATION_MS` convention in `briefPlayback.ts`. */
export const PHASE_TRANSITION_DURATION_MS = 1500;

/** A unit's saved position per phase, keyed by phase id (`PlanFeature.metadata.phasePositions`). */
export type PhasePositions = Record<string, LocalPoint>;

/**
 * A unit's position interpolated from its `phaseA` position toward its `phaseB` position at
 * parameter `t` (clamped to [0, 1] — endpoint-exact, mirrors `briefPlayback.ts`'s
 * `interpolatePose`). Pure function of `phasePositions` + the two phase ids — no Three.js
 * scene access, deterministically unit-testable (invariant 1).
 *
 * Invariant 2 (holds its last known position, never jumps to origin): a phase with no
 * recorded position is treated as "stay wherever the OTHER endpoint says" rather than
 * interpolating toward an undefined point — missing `phaseB` holds at `phaseA`'s position
 * for the whole segment; missing `phaseA` (nothing recorded yet at the segment's start)
 * shows `phaseB`'s position immediately rather than interpolating from nothing. Returns
 * `null` only when NEITHER phase has a recorded position — the caller (the render loop)
 * then leaves the unit at wherever it currently is, never snapping it to world origin.
 */
export function unitPositionAt(
  phasePositions: PhasePositions,
  phaseA: string,
  phaseB: string,
  t: number
): LocalPoint | null {
  const posA = phasePositions[phaseA];
  const posB = phasePositions[phaseB];
  if (!posA && !posB) return null;
  if (!posA) return posB;
  if (!posB) return posA;

  const clampedT = Math.min(1, Math.max(0, t));
  return {
    x: posA.x + (posB.x - posA.x) * clampedT,
    y: posA.y + (posB.y - posA.y) * clampedT,
    z: posA.z + (posB.z - posA.z) * clampedT,
  };
}

export interface TimelineBlend {
  fromIndex: number;
  toIndex: number;
  t: number;
}

/**
 * Steps through an ordered phase list — a slider/stepper over `Plan.phases` (todo 26).
 * `scrubTo` jumps instantly (dragging the slider — matches the user-flow's "Scrub to
 * Phase 1" being an immediate cut, not an animation); `goTo`/`next`/`previous` animate the
 * transition over `PHASE_TRANSITION_DURATION_MS` (the stepper buttons / guided playback).
 * Mirrors `briefPlayback.ts`'s `BriefPlaybackStepper` shape — every method takes `nowMs`
 * explicitly, never reads a clock internally, so the stepper stays deterministically
 * testable.
 */
export class TimelineStepper {
  private index = 0;
  private transitionFrom: number | null = null;
  private transitionStartMs: number | null = null;
  private playing = false;

  constructor(private getPhaseCount: () => number) {}

  public get isPlaying(): boolean {
    return this.playing;
  }

  /** The phase index the stepper is currently AT or TRANSITIONING TO. */
  public get currentIndex(): number {
    return this.index;
  }

  /** Instant jump — no transition. The visibility filter + unit positions both read
   * `currentIndex` directly once this returns (no `tick` blend needed). */
  public scrubTo(index: number): boolean {
    const count = this.getPhaseCount();
    if (count === 0 || index < 0 || index >= count) return false;
    this.index = index;
    this.cancel();
    return true;
  }

  /** Starts an animated transition from the CURRENT index to `index`. */
  public goTo(index: number, nowMs: number): boolean {
    const count = this.getPhaseCount();
    if (count === 0 || index < 0 || index >= count || index === this.index) return false;
    this.transitionFrom = this.index;
    this.index = index;
    this.transitionStartMs = nowMs;
    this.playing = true;
    return true;
  }

  public next(nowMs: number): boolean {
    return this.goTo(this.index + 1, nowMs);
  }

  public previous(nowMs: number): boolean {
    return this.goTo(this.index - 1, nowMs);
  }

  /** Interrupts a playing transition without leaving the timeline half-interpolated —
   * mirrors `BriefPlaybackStepper.cancel`'s invariant 3 (manual input stops cleanly). */
  public cancel(): void {
    this.playing = false;
    this.transitionFrom = null;
    this.transitionStartMs = null;
  }

  /** Called every frame. Returns the blend to render this frame, or `null` when idle
   * (not transitioning — the caller shows `currentIndex` as a plain cut). */
  public tick(nowMs: number): TimelineBlend | null {
    if (!this.playing || this.transitionFrom === null || this.transitionStartMs === null) {
      return null;
    }
    const t = (nowMs - this.transitionStartMs) / PHASE_TRANSITION_DURATION_MS;
    if (t >= 1) {
      this.cancel();
      return null;
    }
    return { fromIndex: this.transitionFrom, toIndex: this.index, t: Math.max(0, t) };
  }
}
