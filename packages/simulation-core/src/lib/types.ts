export const FIXED_TICK_RATE_HZ = 20;
export const FIXED_STEP_SECONDS = 1 / FIXED_TICK_RATE_HZ;

export const UNIT_TYPES = ['infantry', 'car', 'tank', 'jet'] as const;

export type UnitType = (typeof UNIT_TYPES)[number];
export type UnitId = string;
export type TeamId = string;

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface WeaponProfile {
  readonly range: number;
  readonly damage: number;
  readonly cooldownSeconds: number;
  readonly hitChance: number;
}

export interface UnitProfile {
  readonly maxHealth: number;
  readonly maxSpeed: number;
  readonly turnRateRadians: number;
  readonly sensorRange: number;
  readonly preferredRange: number;
  readonly weapon: WeaponProfile;
}

export type UnitProfileOverrides = Readonly<
  Partial<Omit<UnitProfile, 'weapon'>> & {
    readonly weapon?: Partial<WeaponProfile>;
  }
>;

export interface TeamDefinition {
  readonly id: TeamId;
  readonly name: string;
  readonly color: string;
}

export type UnitOrder =
  | Readonly<{
      kind: 'hold';
    }>
  | Readonly<{
      kind: 'pursue';
      targetId?: UnitId;
    }>
  | Readonly<{
      kind: 'move';
      destination: Vec3;
      stopRadius?: number;
    }>;

export interface UnitSpawn {
  readonly id: UnitId;
  readonly name?: string;
  readonly type: UnitType;
  readonly teamId: TeamId;
  readonly position: Vec3;
  readonly heading?: number;
  readonly order?: UnitOrder;
  readonly profile?: UnitProfileOverrides;
}

export interface BattleScenario {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly seed?: number;
  readonly maxDurationSeconds?: number;
  readonly teams: readonly TeamDefinition[];
  readonly units: readonly UnitSpawn[];
}

export type BattlePhase = 'ready' | 'running' | 'paused' | 'victory' | 'draw';

export interface BattleStatus {
  readonly phase: BattlePhase;
  readonly winnerTeamId?: TeamId;
  readonly reason?: string;
}

export type BattleEventType =
  | 'battle-started'
  | 'target-acquired'
  | 'weapon-fired'
  | 'hit'
  | 'miss'
  | 'unit-destroyed'
  | 'victory'
  | 'draw';

export interface BattleEvent {
  readonly id: string;
  readonly sequence: number;
  readonly tick: number;
  readonly timeSeconds: number;
  readonly type: BattleEventType;
  readonly actorId?: UnitId;
  readonly targetId?: UnitId;
  readonly teamId?: TeamId;
  readonly amount?: number;
  readonly message: string;
}

export interface UnitSnapshot {
  readonly id: UnitId;
  readonly name: string;
  readonly type: UnitType;
  readonly teamId: TeamId;
  readonly position: Vec3;
  readonly previousPosition: Vec3;
  readonly heading: number;
  readonly previousHeading: number;
  readonly velocity: Vec3;
  readonly speed: number;
  readonly health: number;
  readonly maxHealth: number;
  readonly alive: boolean;
  readonly targetId?: UnitId;
  readonly order: UnitOrder;
  readonly cooldownRemaining: number;
}

export interface TeamSnapshot extends TeamDefinition {
  readonly aliveUnits: number;
  readonly totalUnits: number;
}

export interface BattleSnapshot {
  readonly scenarioId: string;
  readonly scenarioName: string;
  readonly tick: number;
  readonly timeSeconds: number;
  readonly interpolationAlpha: number;
  readonly status: BattleStatus;
  readonly teams: readonly TeamSnapshot[];
  readonly units: readonly UnitSnapshot[];
  readonly events: readonly BattleEvent[];
}

export interface AdvanceResult {
  readonly steps: number;
  readonly alpha: number;
  readonly snapshot: BattleSnapshot;
}

export interface PassabilityQuery {
  readonly unitId: UnitId;
  readonly unitType: UnitType;
  readonly teamId: TeamId;
  /** Start of the short movement segment being tested. */
  readonly from: Vec3;
  /** End of the short movement segment being tested. */
  readonly candidate: Vec3;
}

/** Returns whether a ground unit may synchronously traverse the queried segment. */
export type PassabilityCallback = (query: PassabilityQuery) => boolean;

export interface BattleSimulationOptions {
  readonly seed?: number;
  readonly eventLogLimit?: number;
  readonly maxFrameSeconds?: number;
  readonly maxSubSteps?: number;
  readonly isPositionPassable?: PassabilityCallback;
}
