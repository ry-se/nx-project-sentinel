import type { PlanFeature } from './planFeature';

/** Bumped when the `Plan` shape changes incompatibly — `loadPlan` fails loud on a
 * mismatch (invariant 3) rather than silently misreading an older/newer format. */
export const PLAN_SCHEMA_VERSION = 1;

export interface Plan {
  id: string;
  name: string;
  version: number;
  anchor: { lat: number; lon: number };
  createdAt: string;
  updatedAt: string;
  features: PlanFeature[];
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

function readAllPlans(): Plan[] {
  const plans: Plan[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(STORAGE_PREFIX)) continue;
    const raw = localStorage.getItem(key);
    if (!raw) continue;
    try {
      plans.push(JSON.parse(raw) as Plan);
    } catch {
      continue; // a corrupted/foreign entry under our prefix — skip, don't crash listPlans()
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
  now: string
): Plan {
  const existing = readAllPlans().find((p) => p.name === name);
  const plan: Plan = {
    id: existing?.id ?? crypto.randomUUID(),
    name,
    version: PLAN_SCHEMA_VERSION,
    anchor,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    features,
  };
  localStorage.setItem(storageKey(plan.id), JSON.stringify(plan));
  return plan;
}

/** Loads a saved `Plan` by id. The caller rebuilds every feature via `rebuildFeature` — this
 * store has no per-type knowledge of what a `PlanFeature` renders as (invariant 2). Throws
 * `UnknownPlanSchemaVersionError` on a version mismatch — fails loud, never silently
 * misreads an incompatible format (invariant 3). */
export function loadPlan(id: string): Plan {
  const raw = localStorage.getItem(storageKey(id));
  if (!raw) throw new Error(`No saved plan with id "${id}"`);
  const plan = JSON.parse(raw) as Plan;
  if (plan.version !== PLAN_SCHEMA_VERSION) throw new UnknownPlanSchemaVersionError(plan.version);
  return plan;
}

/** Lists every saved plan, most recently updated first. */
export function listPlans(): Plan[] {
  return readAllPlans().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function deletePlan(id: string): void {
  localStorage.removeItem(storageKey(id));
}
