import { createCombinedArmsScenario, EXAMPLE_SCENARIOS } from './scenarios';
import { BattleSimulation } from './simulation-core';
import {
  FIXED_STEP_SECONDS,
  type BattleScenario,
  type PassabilityQuery,
  type UnitProfileOverrides,
  type UnitType,
} from './types';

describe('BattleSimulation', () => {
  it('replays the same scenario deterministically from the same seed', () => {
    const first = new BattleSimulation(createCombinedArmsScenario());
    const second = new BattleSimulation(createCombinedArmsScenario());
    const frameTimes = [0.016, 0.034, 0.05, 0.021, 0.079];

    first.start();
    second.start();
    for (let index = 0; index < 1_200; index += 1) {
      const elapsed = frameTimes[index % frameTimes.length] ?? 0;
      first.advance(elapsed);
      second.advance(elapsed);
    }

    expect(first.getSnapshot()).toEqual(second.getSnapshot());
  });

  it('uses clean turn-rate and speed-limited movement', () => {
    const scenario = movementScenario();
    const simulation = new BattleSimulation(scenario);

    const firstTick = simulation.step();
    const mover = firstTick.units.find((unit) => unit.id === 'blue-mover');

    expect(mover).toBeDefined();
    expect(mover?.heading).toBeCloseTo(0.05, 8);
    expect(mover?.speed).toBeLessThanOrEqual(2);
    expect(mover?.position.x).toBeGreaterThan(0);
    expect(mover?.position.z).toBeGreaterThan(0);

    const afterOneSecond = simulation.step(19);
    const advancedMover = afterOneSecond.units.find((unit) => unit.id === 'blue-mover');
    expect(advancedMover?.position.x).toBeLessThanOrEqual(2);
    expect(advancedMover?.position.z).toBeLessThanOrEqual(2);
  });

  it('takes a deterministic, turn-limited side-step when the direct path is blocked', () => {
    const queries: PassabilityQuery[] = [];
    const passability = (query: PassabilityQuery): boolean => {
      queries.push(query);
      return query.candidate.z <= 0 || Math.abs(query.candidate.x) >= 0.005;
    };
    const first = new BattleSimulation(obstacleScenario(), {
      isPositionPassable: passability,
    });
    const second = new BattleSimulation(obstacleScenario(), {
      isPositionPassable: (query) => query.candidate.z <= 0 || Math.abs(query.candidate.x) >= 0.005,
    });

    const firstSnapshot = first.step();
    const secondSnapshot = second.step();
    const mover = firstSnapshot.units.find((unit) => unit.id === 'blue-mover');

    expect(firstSnapshot).toEqual(secondSnapshot);
    expect(mover?.position.x).toBeGreaterThan(0);
    expect(mover?.position.z).toBeGreaterThan(0);
    expect(mover?.heading).toBeCloseTo(0.1, 8);
    expect(mover?.speed).toBeLessThanOrEqual(20);
    expect(queries[0]).toMatchObject({
      unitId: 'blue-mover',
      unitType: 'car',
      teamId: 'blue',
    });
    expect(Object.isFrozen(queries[0])).toBe(true);
    expect(Object.isFrozen(queries[0]?.candidate)).toBe(true);
  });

  it('stays in place when every bounded alternative is blocked', () => {
    const simulation = new BattleSimulation(obstacleScenario(), {
      isPositionPassable: () => false,
    });

    const mover = simulation.step().units.find((unit) => unit.id === 'blue-mover');

    expect(mover?.position).toEqual({ x: 0, y: 0, z: 0 });
    expect(mover?.velocity).toEqual({ x: 0, y: 0, z: 0 });
    expect(mover?.heading).toBeCloseTo(0.1, 8);
  });

  it('probes the full path so fast units cannot tunnel through a thin obstacle', () => {
    const simulation = new BattleSimulation(obstacleScenario(), {
      isPositionPassable: ({ candidate }) => candidate.z < 0.45 || candidate.z > 0.55,
    });

    const mover = simulation.step().units.find((unit) => unit.id === 'blue-mover');

    expect(mover?.position).toEqual({ x: 0, y: 0, z: 0 });
    expect(mover?.speed).toBe(0);
  });

  it('keeps movement unchanged when passability is absent or always true', () => {
    const withoutQuery = new BattleSimulation(obstacleScenario());
    const passable = new BattleSimulation(obstacleScenario(), {
      isPositionPassable: () => true,
    });

    expect(withoutQuery.step(12)).toEqual(passable.step(12));
  });

  it('does not apply ground passability to jets', () => {
    let queryCount = 0;
    const simulation = new BattleSimulation(obstacleScenario('jet'), {
      isPositionPassable: () => {
        queryCount += 1;
        return false;
      },
    });

    const jet = simulation.step().units.find((unit) => unit.id === 'blue-mover');

    expect(queryCount).toBe(0);
    expect(jet?.position.z).toBeGreaterThan(0);
  });

  it('resolves combat, destruction, and victory with typed events', () => {
    const simulation = new BattleSimulation(decisiveDuelScenario());
    const snapshot = simulation.step();
    const redUnit = snapshot.units.find((unit) => unit.id === 'red-target');

    expect(snapshot.status.phase).toBe('victory');
    expect(snapshot.status.winnerTeamId).toBe('blue');
    expect(redUnit?.alive).toBe(false);
    expect(redUnit?.health).toBe(0);
    expect(snapshot.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['weapon-fired', 'hit', 'unit-destroyed', 'victory'])
    );
    expect(snapshot.events.every((event) => event.id.startsWith('event-'))).toBe(true);
  });

  it('accumulates at 20 Hz and does not consume time while paused', () => {
    const simulation = new BattleSimulation(movementScenario());

    expect(simulation.advance(0.2).steps).toBe(0);
    simulation.start();

    const partial = simulation.advance(FIXED_STEP_SECONDS - 0.001);
    expect(partial.steps).toBe(0);
    expect(partial.alpha).toBeCloseTo(0.98, 8);

    const completed = simulation.advance(0.001);
    expect(completed.steps).toBe(1);
    expect(completed.snapshot.tick).toBe(1);
    expect(completed.alpha).toBeCloseTo(0, 8);

    simulation.pause();
    const paused = simulation.advance(0.2);
    expect(paused.steps).toBe(0);
    expect(paused.snapshot.tick).toBe(1);
    expect(paused.snapshot.status.phase).toBe('paused');

    simulation.setPaused(false);
    expect(simulation.advance(FIXED_STEP_SECONDS).snapshot.tick).toBe(2);
  });

  it('returns deeply frozen snapshots that cannot mutate simulation state', () => {
    const simulation = new BattleSimulation(movementScenario());
    const snapshot = simulation.getSnapshot();
    const firstUnit = snapshot.units[0];

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.units)).toBe(true);
    expect(Object.isFrozen(firstUnit)).toBe(true);
    expect(Object.isFrozen(firstUnit?.position)).toBe(true);
    expect(Object.isFrozen(firstUnit?.order)).toBe(true);

    if (firstUnit !== undefined) {
      const writableView = firstUnit as { health: number };
      expect(() => {
        writableView.health = 0;
      }).toThrow();
    }
    expect(simulation.getSnapshot().units[0]?.health).toBeGreaterThan(0);
  });

  it.each(EXAMPLE_SCENARIOS)(
    '$name reaches a terminal result with real combat activity',
    (scenario) => {
      const simulation = new BattleSimulation(scenario);
      const maxTicks = Math.ceil((scenario.maxDurationSeconds ?? 200) / FIXED_STEP_SECONDS) + 1;

      simulation.start();
      const snapshot = simulation.step(maxTicks);

      expect(['victory', 'draw']).toContain(snapshot.status.phase);
      expect(snapshot.events.some((event) => event.type === 'weapon-fired')).toBe(true);
      expect(snapshot.units.some((unit) => !unit.alive)).toBe(true);
    }
  );
});

function movementScenario(): BattleScenario {
  const slowMover: UnitProfileOverrides = {
    maxHealth: 100,
    maxSpeed: 2,
    turnRateRadians: 1,
    sensorRange: 5,
    preferredRange: 1,
    weapon: {
      range: 1,
      damage: 1,
      cooldownSeconds: 1,
      hitChance: 1,
    },
  };

  return {
    id: 'movement-test',
    name: 'Movement Test',
    description: 'A deterministic movement fixture.',
    seed: 1,
    teams: testTeams(),
    units: [
      {
        id: 'blue-mover',
        type: 'car',
        teamId: 'blue',
        position: { x: 0, y: 0, z: 0 },
        heading: 0,
        order: {
          kind: 'move',
          destination: { x: 100, y: 0, z: 0 },
          stopRadius: 0,
        },
        profile: slowMover,
      },
      {
        id: 'red-observer',
        type: 'infantry',
        teamId: 'red',
        position: { x: 0, y: 0, z: 1_000 },
        order: { kind: 'hold' },
        profile: slowMover,
      },
    ],
  };
}

function obstacleScenario(type: UnitType = 'car'): BattleScenario {
  const mobileProfile: UnitProfileOverrides = {
    maxHealth: 100,
    maxSpeed: 20,
    turnRateRadians: 2,
    sensorRange: 5,
    preferredRange: 1,
    weapon: {
      range: 1,
      damage: 1,
      cooldownSeconds: 1,
      hitChance: 1,
    },
  };

  return {
    id: 'obstacle-test',
    name: 'Obstacle Test',
    description: 'A deterministic obstacle avoidance fixture.',
    seed: 3,
    teams: testTeams(),
    units: [
      {
        id: 'blue-mover',
        type,
        teamId: 'blue',
        position: { x: 0, y: type === 'jet' ? 50 : 0, z: 0 },
        heading: 0,
        order: {
          kind: 'move',
          destination: { x: 0, y: type === 'jet' ? 50 : 0, z: 100 },
          stopRadius: 0,
        },
        profile: mobileProfile,
      },
      {
        id: 'red-observer',
        type: 'infantry',
        teamId: 'red',
        position: { x: 0, y: 0, z: 1_000 },
        order: { kind: 'hold' },
        profile: mobileProfile,
      },
    ],
  };
}

function decisiveDuelScenario(): BattleScenario {
  const blueWeapon: UnitProfileOverrides = {
    maxHealth: 100,
    maxSpeed: 0,
    turnRateRadians: 1,
    sensorRange: 100,
    preferredRange: 10,
    weapon: {
      range: 100,
      damage: 100,
      cooldownSeconds: 1,
      hitChance: 1,
    },
  };
  const redWeapon: UnitProfileOverrides = {
    ...blueWeapon,
    preferredRange: 1,
    weapon: {
      range: 1,
      damage: 1,
      cooldownSeconds: 1,
      hitChance: 1,
    },
  };

  return {
    id: 'decisive-duel',
    name: 'Decisive Duel',
    description: 'A deterministic one-volley fixture.',
    seed: 2,
    teams: testTeams(),
    units: [
      {
        id: 'blue-shooter',
        name: 'Blue Shooter',
        type: 'tank',
        teamId: 'blue',
        position: { x: 0, y: 0, z: 0 },
        order: { kind: 'hold' },
        profile: blueWeapon,
      },
      {
        id: 'red-target',
        name: 'Red Target',
        type: 'tank',
        teamId: 'red',
        position: { x: 0, y: 0, z: 20 },
        order: { kind: 'hold' },
        profile: redWeapon,
      },
    ],
  };
}

function testTeams(): BattleScenario['teams'] {
  return [
    { id: 'blue', name: 'Blue', color: '#00f' },
    { id: 'red', name: 'Red', color: '#f00' },
  ];
}
