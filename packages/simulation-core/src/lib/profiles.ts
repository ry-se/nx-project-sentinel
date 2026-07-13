import type { UnitProfile, UnitType } from './types';

const INFANTRY_PROFILE: UnitProfile = Object.freeze({
  maxHealth: 100,
  maxSpeed: 4.2,
  turnRateRadians: 2.8,
  sensorRange: 230,
  preferredRange: 70,
  weapon: Object.freeze({
    range: 95,
    damage: 13,
    cooldownSeconds: 0.8,
    hitChance: 0.58,
  }),
});

const CAR_PROFILE: UnitProfile = Object.freeze({
  maxHealth: 170,
  maxSpeed: 15,
  turnRateRadians: 1.4,
  sensorRange: 340,
  preferredRange: 92,
  weapon: Object.freeze({
    range: 125,
    damage: 11,
    cooldownSeconds: 0.55,
    hitChance: 0.55,
  }),
});

const TANK_PROFILE: UnitProfile = Object.freeze({
  maxHealth: 480,
  maxSpeed: 6.4,
  turnRateRadians: 0.72,
  sensorRange: 430,
  preferredRange: 178,
  weapon: Object.freeze({
    range: 230,
    damage: 82,
    cooldownSeconds: 2.6,
    hitChance: 0.73,
  }),
});

const JET_PROFILE: UnitProfile = Object.freeze({
  maxHealth: 300,
  maxSpeed: 42,
  turnRateRadians: 0.85,
  sensorRange: 820,
  preferredRange: 330,
  weapon: Object.freeze({
    range: 460,
    damage: 105,
    cooldownSeconds: 3.8,
    hitChance: 0.68,
  }),
});

export const UNIT_PROFILES: Readonly<Record<UnitType, UnitProfile>> = Object.freeze({
  infantry: INFANTRY_PROFILE,
  car: CAR_PROFILE,
  tank: TANK_PROFILE,
  jet: JET_PROFILE,
});
