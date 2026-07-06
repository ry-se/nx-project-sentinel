export interface WeaponSystem {
  name: string;
  minRangeM: number;
  maxRangeM: number;
}

export type SystemId = 'mortar81mm' | 'atgmMedium' | 'groundSurveillanceRadar';

/**
 * Representative, publicly-documented NATO-class system parameters (todo 32) — training/
 * exercise use per Gate 6 (`01-analysis/04-army-strategist/04-viability-gates.md`), NOT
 * validated targeting data for any specific real system variant. Every entry cites its
 * source class so the numbers are traceable, not invented (`rules/zero-tolerance.md`
 * Rule 2):
 *
 * - **81mm Mortar** — commonly-cited NATO 81mm class (e.g. L16-pattern) figures: ~100m
 *   minimum safe range, ~5,600m maximum range at full HE charge.
 * - **Medium ATGM** — representative shoulder-fired medium ATGM class (e.g. Javelin-class)
 *   figures: ~65m minimum arming distance, ~4,000m maximum engagement range.
 * - **Ground Surveillance Radar** — representative medium ground-surveillance radar class:
 *   no true minimum range; a nominal 100m blind-zone is stated for UI clarity, ~20,000m
 *   maximum detection range.
 *
 * `rebuildFeature` reads this table at RENDER time, not a value baked into the persisted
 * `PlanFeature` — a future correction to these figures re-renders every saved plan
 * correctly without a data migration (invariant 2).
 */
export const WEAPON_SYSTEMS: Record<SystemId, WeaponSystem> = {
  mortar81mm: { name: '81mm Mortar', minRangeM: 100, maxRangeM: 5600 },
  atgmMedium: { name: 'Medium ATGM', minRangeM: 65, maxRangeM: 4000 },
  groundSurveillanceRadar: { name: 'Ground Surveillance Radar', minRangeM: 100, maxRangeM: 20000 },
};
