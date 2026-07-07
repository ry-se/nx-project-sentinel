import { type ClassificationLevel, DEFAULT_CLASSIFICATION } from './classification';
import type { PlanFeature } from './planFeature';
import type { Viewpoint } from './viewpoint';

/** Bumped when the `Plan` shape changes incompatibly — `loadPlan` fails loud on a
 * mismatch (invariant 3) rather than silently misreading an older/newer format. */
export const PLAN_SCHEMA_VERSION = 1;

/** A plan-defined phase ("Move to FUP", "Assault", "Consolidation") — todo 25. Features
 * tag themselves to a phase id via `PlanFeature.metadata.phase`; the phase LIST itself
 * lives at the `Plan` level since phases are shared across every feature, not per-feature
 * data. */
export interface PlanPhase {
  id: string;
  name: string;
  order: number;
}

export interface Plan {
  id: string;
  name: string;
  version: number;
  anchor: { lat: number; lon: number };
  createdAt: string;
  updatedAt: string;
  features: PlanFeature[];
  /** The brief sequence (todo 19) — persists/exports with the plan (invariant 2). */
  viewpoints: Viewpoint[];
  /** Defaults to EXERCISE (todo 22 invariant 2) — never silently blank. */
  classification: ClassificationLevel;
  /** The plan's phase list (todo 25 invariant 4 — survives save/load/export), ordered by
   * `order`. Empty for a plan with no phasing (every feature reads as `ALL_PHASES`). */
  phases: PlanPhase[];
}

export class UnknownPlanSchemaVersionError extends Error {
  constructor(public readonly foundVersion: number) {
    super(`Unknown plan schema version: ${foundVersion} (expected ${PLAN_SCHEMA_VERSION})`);
    this.name = 'UnknownPlanSchemaVersionError';
  }
}

const STORAGE_PREFIX = 'sentinel.plan.';

function storageKey(id: string): string {
  return `${STORAGE_PREFIX}${id}`;
}

function getPlanStorage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    // Touching length catches browsers that expose localStorage but deny access.
    void localStorage.length;
    return localStorage;
  } catch {
    return null;
  }
}

function requirePlanStorage(): Storage {
  const storage = getPlanStorage();
  if (!storage) throw new Error('Plan storage is unavailable in this browser context');
  return storage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseStoredPlan(raw: string): Plan {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) throw new Error('Invalid saved plan record');
  const foundVersion = parsed.version;
  if (foundVersion !== PLAN_SCHEMA_VERSION) {
    throw new UnknownPlanSchemaVersionError(
      typeof foundVersion === 'number' ? foundVersion : Number.NaN
    );
  }
  if (
    typeof parsed.id !== 'string' ||
    typeof parsed.name !== 'string' ||
    typeof parsed.createdAt !== 'string' ||
    typeof parsed.updatedAt !== 'string' ||
    !isRecord(parsed.anchor) ||
    !Array.isArray(parsed.features)
  ) {
    throw new Error('Invalid saved plan record');
  }

  return {
    ...(parsed as unknown as Plan),
    viewpoints: Array.isArray(parsed.viewpoints) ? (parsed.viewpoints as Viewpoint[]) : [],
    classification:
      typeof parsed.classification === 'string'
        ? (parsed.classification as ClassificationLevel)
        : DEFAULT_CLASSIFICATION,
    phases: Array.isArray(parsed.phases) ? (parsed.phases as PlanPhase[]) : [],
  };
}

function readAllPlans(): Plan[] {
  const storage = getPlanStorage();
  if (!storage) return [];
  const plans: Plan[] = [];
  let length = 0;
  try {
    length = storage.length;
  } catch {
    return [];
  }
  for (let i = 0; i < length; i++) {
    try {
      const key = storage.key(i);
      if (!key?.startsWith(STORAGE_PREFIX)) continue;
      const raw = storage.getItem(key);
      if (!raw) continue;
      plans.push(parseStoredPlan(raw));
    } catch {
      continue; // unavailable/corrupted/foreign entry — skip, don't crash listPlans()
    }
  }
  return plans;
}

/** Saves the CURRENT feature set as a `Plan`. The store only ever sees `PlanFeature[]`
 * data (invariant 1) — it has no idea what a Three.js `Group` is. Saving under a name
 * that already exists UPDATES that plan (bumps `updatedAt`, keeps `id`/`createdAt`) rather
 * than creating a duplicate (invariant 4). `now` is passed in, not read via `Date.now()`
 * inside this function, so the store stays deterministically testable (invariant 5). */
export function savePlan(
  name: string,
  features: PlanFeature[],
  anchor: { lat: number; lon: number },
  now: string,
  viewpoints: Viewpoint[] = [],
  classification: ClassificationLevel = DEFAULT_CLASSIFICATION,
  phases: PlanPhase[] = []
): Plan {
  const existing = readAllPlans().find((p) => p.name === name);
  const storage = requirePlanStorage();
  const plan: Plan = {
    id: existing?.id ?? crypto.randomUUID(),
    name,
    version: PLAN_SCHEMA_VERSION,
    anchor,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    features,
    viewpoints,
    classification,
    phases,
  };
  storage.setItem(storageKey(plan.id), JSON.stringify(plan));
  return plan;
}

/** Loads a saved `Plan` by id. The caller rebuilds every feature via `rebuildFeature` — this
 * store has no per-type knowledge of what a `PlanFeature` renders as (invariant 2). Throws
 * `UnknownPlanSchemaVersionError` on a version mismatch — fails loud, never silently
 * misreads an incompatible format (invariant 3). */
export function loadPlan(id: string): Plan {
  const storage = requirePlanStorage();
  const raw = storage.getItem(storageKey(id));
  if (!raw) throw new Error(`No saved plan with id "${id}"`);
  return parseStoredPlan(raw);
}

/** Lists every saved plan, most recently updated first. */
export function listPlans(): Plan[] {
  return readAllPlans().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function deletePlan(id: string): void {
  const storage = getPlanStorage();
  if (!storage) return;
  try {
    storage.removeItem(storageKey(id));
  } catch {
    // Storage can become unavailable after the initial probe; deleting should stay best-effort.
  }
}
