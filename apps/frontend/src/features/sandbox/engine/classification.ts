/** A configurable list (invariant 4) — never hardcoded at call sites. Training-lane scope
 * (viability Gate 6 — no real classified data); real accreditation/handling-caveat
 * enforcement is an environment gate, not code. */
export type ClassificationLevel = 'EXERCISE' | 'UNCLASSIFIED' | 'RESTRICTED' | 'CONFIDENTIAL';

export const CLASSIFICATION_LEVELS: ClassificationLevel[] = [
  'EXERCISE',
  'UNCLASSIFIED',
  'RESTRICTED',
  'CONFIDENTIAL',
];

/** Training-lane default — NEVER silently blank, which would imply unclassified handling
 * (invariant 2). */
export const DEFAULT_CLASSIFICATION: ClassificationLevel = 'EXERCISE';

/** Banner background color per level — distinct, legible against white banner text. */
export const CLASSIFICATION_COLOR: Record<ClassificationLevel, string> = {
  EXERCISE: '#1565c0',
  UNCLASSIFIED: '#2e7d32',
  RESTRICTED: '#f9a825',
  CONFIDENTIAL: '#c62828',
};

/** Author + created/updated timestamps captured at draw time (invariant 3) — travels
 * with the `PlanFeature` through save/load/export via `PlanFeature.metadata.provenance`. */
export interface Provenance {
  author: string;
  createdAt: string;
  updatedAt: string;
}
