import type { PlanFeature } from './planFeature';
import {
  deletePlan,
  listPlans,
  loadPlan,
  PLAN_SCHEMA_VERSION,
  savePlan,
  UnknownPlanSchemaVersionError,
} from './planStore';

/** Todo 17: savePlan/loadPlan round-trip, name-based upsert, version-mismatch failing
 * loud, list/delete — all against jsdom's real (in-memory) `localStorage`, no custom
 * shim needed (invariant 5's testability is what makes this possible: timestamps are
 * passed in, so every assertion below is deterministic). */

const ANCHOR = { lat: 1.35, lon: 103.8 };

function fixtureFeature(id: string, name: string): PlanFeature {
  return {
    id,
    type: 'distance',
    name,
    points: {
      local: [
        { x: 0, y: 0, z: 0 },
        { x: 50, y: 0, z: 0 },
      ],
      geo: [
        { lat: 1.35, lon: 103.8, altM: 0 },
        { lat: 1.351, lon: 103.8, altM: 0 },
      ],
    },
    metadata: {},
  };
}

describe('planStore — save/load/list/delete (todo 17)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('savePlan then loadPlan reconstructs an equal feature set (deep-equal)', () => {
    const features = [fixtureFeature('f1', 'Leg 1'), fixtureFeature('f2', 'Leg 2')];
    const saved = savePlan('COY ATTACK', features, ANCHOR, '2026-07-05T00:00:00.000Z');

    const loaded = loadPlan(saved.id);
    expect(loaded.features).toEqual(features);
    expect(loaded.name).toBe('COY ATTACK');
    expect(loaded.version).toBe(PLAN_SCHEMA_VERSION);
    expect(loaded.anchor).toEqual(ANCHOR);
  });

  it('the store never reaches into anything beyond PlanFeature data (invariant 1)', () => {
    const features = [fixtureFeature('f1', 'Leg 1')];
    const saved = savePlan('Plain', features, ANCHOR, '2026-07-05T00:00:00.000Z');
    // Round-trips through JSON — a Three.js Group/Vector3 would not survive this; a
    // PlanFeature (plain data) does, byte for byte.
    expect(JSON.parse(JSON.stringify(saved.features))).toEqual(saved.features);
  });

  it('saving under an existing name UPDATES that plan — same id, bumped updatedAt, not a duplicate', () => {
    const first = savePlan(
      'COY ATTACK',
      [fixtureFeature('f1', 'v1')],
      ANCHOR,
      '2026-07-05T00:00:00.000Z'
    );
    const second = savePlan(
      'COY ATTACK',
      [fixtureFeature('f1', 'v2')],
      ANCHOR,
      '2026-07-05T01:00:00.000Z'
    );

    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBe('2026-07-05T01:00:00.000Z');
    expect(listPlans()).toHaveLength(1);
    expect(loadPlan(first.id).features[0].name).toBe('v2');
  });

  it('an unknown schema version fails loud, not silently', () => {
    const saved = savePlan('X', [], ANCHOR, '2026-07-05T00:00:00.000Z');
    const raw = localStorage.getItem(`sentinel.plan.${saved.id}`)!;
    const corrupted = { ...JSON.parse(raw), version: 999 };
    localStorage.setItem(`sentinel.plan.${saved.id}`, JSON.stringify(corrupted));

    expect(() => loadPlan(saved.id)).toThrow(UnknownPlanSchemaVersionError);
  });

  it('loadPlan on a missing id throws rather than returning an empty/fake plan', () => {
    expect(() => loadPlan('does-not-exist')).toThrow(/No saved plan/);
  });

  it('listPlans returns every saved plan, most recently updated first', () => {
    savePlan('Old', [], ANCHOR, '2026-07-05T00:00:00.000Z');
    savePlan('New', [], ANCHOR, '2026-07-05T02:00:00.000Z');
    savePlan('Middle', [], ANCHOR, '2026-07-05T01:00:00.000Z');

    expect(listPlans().map((p) => p.name)).toEqual(['New', 'Middle', 'Old']);
  });

  it('deletePlan removes it from storage and from listPlans', () => {
    const saved = savePlan('Gone Soon', [], ANCHOR, '2026-07-05T00:00:00.000Z');
    deletePlan(saved.id);

    expect(listPlans()).toHaveLength(0);
    expect(() => loadPlan(saved.id)).toThrow(/No saved plan/);
  });
});
