import type { BattleScenario, TeamDefinition, UnitSpawn, Vec3 } from './types';

const BLUE_TEAM: TeamDefinition = Object.freeze({
  id: 'blue',
  name: 'Blue Force',
  color: '#38bdf8',
});

const RED_TEAM: TeamDefinition = Object.freeze({
  id: 'red',
  name: 'Red Force',
  color: '#fb7185',
});

const FACE_NORTH = 0;
const FACE_SOUTH = Math.PI;

export function createArmoredSkirmishScenario(): BattleScenario {
  return freezeScenario({
    id: 'armored-skirmish',
    name: 'Armored Skirmish',
    description: 'Two balanced armored patrols close distance and engage across open ground.',
    seed: 7_301,
    maxDurationSeconds: 150,
    teams: [BLUE_TEAM, RED_TEAM],
    units: [
      armoredUnit('blue-tank-1', 'Blue Anvil', 'tank', 'blue', -24, -165, FACE_NORTH),
      armoredUnit('blue-tank-2', 'Blue Hammer', 'tank', 'blue', 24, -165, FACE_NORTH),
      armoredUnit('blue-car-1', 'Blue Scout', 'car', 'blue', 0, -128, FACE_NORTH),
      armoredUnit('red-tank-1', 'Red Bastion', 'tank', 'red', -24, 165, FACE_SOUTH),
      armoredUnit('red-tank-2', 'Red Rampart', 'tank', 'red', 24, 165, FACE_SOUTH),
      armoredUnit('red-car-1', 'Red Scout', 'car', 'red', 0, 128, FACE_SOUTH),
    ],
  });
}

export function createCombinedArmsScenario(): BattleScenario {
  return freezeScenario({
    id: 'combined-arms',
    name: 'Combined Arms',
    description:
      'Infantry screens, armored vehicles, scouts, and aircraft coordinate in a mixed engagement.',
    seed: 91_117,
    maxDurationSeconds: 180,
    teams: [BLUE_TEAM, RED_TEAM],
    units: [
      combinedUnit('blue-infantry-1', 'Blue Alpha', 'infantry', 'blue', -18, 0, -82, FACE_NORTH),
      combinedUnit('blue-infantry-2', 'Blue Bravo', 'infantry', 'blue', 18, 0, -82, FACE_NORTH),
      combinedUnit('blue-car-1', 'Blue Pathfinder', 'car', 'blue', -48, 0, -125, FACE_NORTH),
      combinedUnit('blue-tank-1', 'Blue Guardian', 'tank', 'blue', 0, 0, -142, FACE_NORTH),
      combinedUnit('blue-jet-1', 'Blue Falcon', 'jet', 'blue', 75, 90, -255, FACE_NORTH),
      combinedUnit('red-infantry-1', 'Red Alpha', 'infantry', 'red', -18, 0, 82, FACE_SOUTH),
      combinedUnit('red-infantry-2', 'Red Bravo', 'infantry', 'red', 18, 0, 82, FACE_SOUTH),
      combinedUnit('red-car-1', 'Red Pathfinder', 'car', 'red', 48, 0, 125, FACE_SOUTH),
      combinedUnit('red-tank-1', 'Red Guardian', 'tank', 'red', 0, 0, 142, FACE_SOUTH),
      combinedUnit('red-jet-1', 'Red Falcon', 'jet', 'red', -75, 90, 255, FACE_SOUTH),
    ],
  });
}

export const EXAMPLE_SCENARIOS: readonly BattleScenario[] = Object.freeze([
  createArmoredSkirmishScenario(),
  createCombinedArmsScenario(),
]);

function armoredUnit(
  id: string,
  name: string,
  type: 'tank' | 'car',
  teamId: string,
  x: number,
  z: number,
  heading: number
): UnitSpawn {
  return Object.freeze({
    id,
    name,
    type,
    teamId,
    position: point(x, 0, z),
    heading,
    order: Object.freeze({ kind: 'pursue' }),
  });
}

function combinedUnit(
  id: string,
  name: string,
  type: UnitSpawn['type'],
  teamId: string,
  x: number,
  y: number,
  z: number,
  heading: number
): UnitSpawn {
  return Object.freeze({
    id,
    name,
    type,
    teamId,
    position: point(x, y, z),
    heading,
    order: Object.freeze({ kind: 'pursue' }),
  });
}

function point(x: number, y: number, z: number): Vec3 {
  return Object.freeze({ x, y, z });
}

function freezeScenario(scenario: BattleScenario): BattleScenario {
  return Object.freeze({
    ...scenario,
    teams: Object.freeze([...scenario.teams]),
    units: Object.freeze([...scenario.units]),
  });
}
