import type { PlanPhase } from './planStore';
import type { Viewpoint } from './viewpoint';

export interface RehearsalStep {
  viewpointIndex: number;
  /** The phase index this step's viewpoint narrates, or `null` when the viewpoint
   * declares no phase (or names one that no longer exists) — the timeline is left
   * untouched for this step rather than forced to some default. */
  phaseIndex: number | null;
}

/**
 * Resolves a rehearsal step from a viewpoint index alone (todo 27 invariant 1 — camera
 * and timeline are driven from ONE step index, so they cannot desync: `phaseIndex` is
 * DERIVED from `viewpointIndex`, never tracked as a second, independent counter). Pure
 * function of the viewpoint/phase lists — no stepper state, independently testable.
 */
export function resolveRehearsalStep(
  viewpoints: Viewpoint[],
  phases: PlanPhase[],
  viewpointIndex: number
): RehearsalStep | null {
  const viewpoint = viewpoints[viewpointIndex];
  if (!viewpoint) return null;
  const phaseIndex = viewpoint.phaseId ? phases.findIndex((p) => p.id === viewpoint.phaseId) : -1;
  return { viewpointIndex, phaseIndex: phaseIndex === -1 ? null : phaseIndex };
}
