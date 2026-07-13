import { UNIT_PROFILES } from './profiles';
import { SeededRandom } from './rng';
import {
  FIXED_STEP_SECONDS,
  type AdvanceResult,
  type BattleEvent,
  type BattleEventType,
  type BattleScenario,
  type BattleSimulationOptions,
  type BattleSnapshot,
  type BattleStatus,
  type PassabilityCallback,
  type TeamId,
  type TeamSnapshot,
  type UnitId,
  type UnitOrder,
  type UnitProfile,
  type UnitSnapshot,
  type UnitSpawn,
  type Vec3,
} from './types';

const DEFAULT_SEED = 1;
const DEFAULT_EVENT_LOG_LIMIT = 160;
const DEFAULT_MAX_FRAME_SECONDS = 0.25;
const DEFAULT_MAX_SUB_STEPS = 5;
const TARGET_RETENTION_MULTIPLIER = 1.15;
const DEFAULT_STOP_RADIUS = 1.5;
const MIN_ALIGNMENT_SPEED_FACTOR = 0.35;
const TWO_PI = Math.PI * 2;
const STEP_EPSILON = 1e-10;
const PASSABILITY_PROBE_SPACING_METERS = 0.25;
const AVOIDANCE_TURN_FRACTIONS: readonly number[] = Object.freeze([1, -1, 0.5, -0.5]);

interface MutableVec3 {
  x: number;
  y: number;
  z: number;
}

interface MutableUnit {
  readonly id: UnitId;
  readonly name: string;
  readonly type: UnitSpawn['type'];
  readonly teamId: TeamId;
  readonly profile: UnitProfile;
  position: MutableVec3;
  previousPosition: MutableVec3;
  heading: number;
  previousHeading: number;
  velocity: MutableVec3;
  health: number;
  alive: boolean;
  targetId: UnitId | undefined;
  order: UnitOrder;
  cooldownRemaining: number;
}

interface ShotIntent {
  readonly actor: MutableUnit;
  readonly target: MutableUnit;
  readonly hit: boolean;
  readonly damage: number;
}

interface Outcome {
  readonly phase: 'victory' | 'draw';
  readonly winnerTeamId?: TeamId;
  readonly reason: string;
}

export class BattleSimulation {
  private scenario: BattleScenario;
  private readonly seedOverride: number | undefined;
  private readonly eventLogLimit: number;
  private readonly maxFrameSeconds: number;
  private readonly maxSubSteps: number;
  private readonly isPositionPassable: PassabilityCallback | undefined;
  private random: SeededRandom;
  private units = new Map<UnitId, MutableUnit>();
  private orderedUnitIds: readonly UnitId[] = Object.freeze([]);
  private events: BattleEvent[] = [];
  private tick = 0;
  private accumulator = 0;
  private eventSequence = 0;
  private begun = false;
  private paused = true;
  private outcome: Outcome | undefined;

  constructor(scenario: BattleScenario, options: BattleSimulationOptions = {}) {
    this.seedOverride = optionalFiniteNumber(options.seed, 'seed');
    this.eventLogLimit = positiveInteger(
      options.eventLogLimit ?? DEFAULT_EVENT_LOG_LIMIT,
      'eventLogLimit'
    );
    this.maxFrameSeconds = positiveNumber(
      options.maxFrameSeconds ?? DEFAULT_MAX_FRAME_SECONDS,
      'maxFrameSeconds'
    );
    this.maxSubSteps = positiveInteger(options.maxSubSteps ?? DEFAULT_MAX_SUB_STEPS, 'maxSubSteps');
    this.isPositionPassable = options.isPositionPassable;
    this.scenario = cloneAndValidateScenario(scenario);
    this.random = new SeededRandom(this.scenario.seed ?? DEFAULT_SEED);
    this.resetState();
  }

  public loadScenario(scenario: BattleScenario): BattleSnapshot {
    this.scenario = cloneAndValidateScenario(scenario);
    this.resetState();
    return this.getSnapshot();
  }

  public start(): BattleSnapshot {
    if (this.outcome === undefined) {
      this.ensureBegun();
      this.paused = false;
    }

    return this.getSnapshot();
  }

  public pause(): BattleSnapshot {
    return this.setPaused(true);
  }

  public setPaused(paused: boolean): BattleSnapshot {
    if (this.outcome !== undefined) {
      return this.getSnapshot();
    }

    if (!paused) {
      this.ensureBegun();
    }
    this.paused = paused;
    return this.getSnapshot();
  }

  public restart(startImmediately = true): BattleSnapshot {
    this.resetState();
    if (startImmediately) {
      return this.start();
    }

    return this.getSnapshot();
  }

  public issueOrder(unitId: UnitId, order: UnitOrder): boolean {
    const unit = this.units.get(unitId);
    if (!unit?.alive) {
      return false;
    }

    unit.order = cloneAndValidateOrder(order);
    if (unit.order.kind === 'pursue' && unit.order.targetId !== undefined) {
      const target = this.units.get(unit.order.targetId);
      unit.targetId = isEnemyAlive(unit, target) ? target.id : undefined;
    }
    return true;
  }

  public advance(elapsedSeconds: number): AdvanceResult {
    finiteNonNegativeNumber(elapsedSeconds, 'elapsedSeconds');

    let steps = 0;
    if (this.canAdvance()) {
      this.accumulator += Math.min(elapsedSeconds, this.maxFrameSeconds);

      while (
        this.accumulator + STEP_EPSILON >= FIXED_STEP_SECONDS &&
        steps < this.maxSubSteps &&
        this.canAdvance()
      ) {
        this.simulateTick();
        this.accumulator = Math.max(0, this.accumulator - FIXED_STEP_SECONDS);
        steps += 1;
      }

      if (steps === this.maxSubSteps && this.accumulator >= FIXED_STEP_SECONDS) {
        this.accumulator %= FIXED_STEP_SECONDS;
      }
    }

    const alpha = this.interpolationAlpha();
    return Object.freeze({
      steps,
      alpha,
      snapshot: this.getSnapshot(),
    });
  }

  public step(ticks = 1): BattleSnapshot {
    nonNegativeInteger(ticks, 'ticks');
    if (ticks > 0 && this.outcome === undefined) {
      this.ensureBegun();
    }

    for (let index = 0; index < ticks && this.outcome === undefined; index += 1) {
      this.simulateTick();
    }

    return this.getSnapshot();
  }

  public getSnapshot(): BattleSnapshot {
    const teams = this.createTeamSnapshots();
    const units = this.orderedUnits().map((unit) => createUnitSnapshot(unit));
    const status = this.createStatus();
    const events = Object.freeze([...this.events]);

    return Object.freeze({
      scenarioId: this.scenario.id,
      scenarioName: this.scenario.name,
      tick: this.tick,
      timeSeconds: this.tick * FIXED_STEP_SECONDS,
      interpolationAlpha: this.interpolationAlpha(),
      status,
      teams: Object.freeze(teams),
      units: Object.freeze(units),
      events,
    });
  }

  private resetState(): void {
    const seed = this.seedOverride ?? this.scenario.seed ?? DEFAULT_SEED;
    this.random = new SeededRandom(seed);
    this.units = new Map(this.scenario.units.map((spawn) => [spawn.id, createMutableUnit(spawn)]));
    this.orderedUnitIds = Object.freeze([...this.units.keys()].sort(compareIds));
    this.events = [];
    this.tick = 0;
    this.accumulator = 0;
    this.eventSequence = 0;
    this.begun = false;
    this.paused = true;
    this.outcome = undefined;
  }

  private canAdvance(): boolean {
    return this.begun && !this.paused && this.outcome === undefined;
  }

  private ensureBegun(): void {
    if (this.begun || this.outcome !== undefined) {
      return;
    }

    this.begun = true;
    this.appendEvent('battle-started', {
      message: `${this.scenario.name} started`,
    });
  }

  private simulateTick(): void {
    this.tick += 1;

    for (const unit of this.orderedUnits()) {
      unit.previousPosition = copyMutableVec3(unit.position);
      unit.previousHeading = unit.heading;
      unit.velocity = mutableVec3(0, 0, 0);
      unit.cooldownRemaining = Math.max(0, unit.cooldownRemaining - FIXED_STEP_SECONDS);
    }

    for (const unit of this.orderedUnits()) {
      if (!unit.alive) {
        continue;
      }
      this.acquireTarget(unit);
    }

    for (const unit of this.orderedUnits()) {
      if (unit.alive) {
        this.moveUnit(unit);
      }
    }

    this.resolveCombat();
    this.evaluateOutcome();
  }

  private acquireTarget(unit: MutableUnit): void {
    const previousTargetId = unit.targetId;
    const orderedTarget =
      unit.order.kind === 'pursue' && unit.order.targetId !== undefined
        ? this.units.get(unit.order.targetId)
        : undefined;

    if (isEnemyAlive(unit, orderedTarget)) {
      unit.targetId = orderedTarget.id;
    } else {
      const currentTarget = unit.targetId === undefined ? undefined : this.units.get(unit.targetId);
      const retentionRange = unit.profile.sensorRange * TARGET_RETENTION_MULTIPLIER;

      if (
        isEnemyAlive(unit, currentTarget) &&
        distance(unit.position, currentTarget.position) <= retentionRange
      ) {
        unit.targetId = currentTarget.id;
      } else {
        unit.targetId = this.findNearestEnemy(unit)?.id;
      }
    }

    if (unit.targetId !== undefined && unit.targetId !== previousTargetId) {
      const target = this.units.get(unit.targetId);
      if (target !== undefined) {
        this.appendEvent('target-acquired', {
          actorId: unit.id,
          targetId: target.id,
          teamId: unit.teamId,
          message: `${unit.name} acquired ${target.name}`,
        });
      }
    }
  }

  private findNearestEnemy(unit: MutableUnit): MutableUnit | undefined {
    let nearest: MutableUnit | undefined;
    let nearestDistance = Number.POSITIVE_INFINITY;

    for (const candidate of this.orderedUnits()) {
      if (!isEnemyAlive(unit, candidate)) {
        continue;
      }

      const candidateDistance = distance(unit.position, candidate.position);
      if (candidateDistance <= unit.profile.sensorRange && candidateDistance < nearestDistance) {
        nearest = candidate;
        nearestDistance = candidateDistance;
      }
    }

    return nearest;
  }

  private moveUnit(unit: MutableUnit): void {
    const movementTarget = this.movementTarget(unit);
    if (movementTarget === undefined) {
      return;
    }

    const deltaX = movementTarget.x - unit.position.x;
    const deltaZ = movementTarget.z - unit.position.z;
    const planarDistance = Math.hypot(deltaX, deltaZ);
    const stopRadius = this.stopRadius(unit);

    if (planarDistance <= stopRadius) {
      if (unit.order.kind === 'move') {
        unit.order = Object.freeze({ kind: 'hold' });
      }
      return;
    }

    const currentHeading = unit.heading;
    const desiredHeading = Math.atan2(deltaX, deltaZ);
    const headingDelta = shortestAngle(currentHeading, desiredHeading);
    const maximumTurn = unit.profile.turnRateRadians * FIXED_STEP_SECONDS;
    const directHeading = normalizeAngle(
      currentHeading + clamp(headingDelta, -maximumTurn, maximumTurn)
    );

    const alignment = Math.max(0, Math.cos(headingDelta));
    const speedFactor =
      unit.type === 'jet' ? Math.max(MIN_ALIGNMENT_SPEED_FACTOR, alignment) : alignment;
    const requestedSpeed = unit.profile.maxSpeed * speedFactor;
    const movementDistance = Math.min(
      requestedSpeed * FIXED_STEP_SECONDS,
      planarDistance - stopRadius
    );

    if (movementDistance <= 0) {
      unit.heading = directHeading;
      return;
    }

    if (this.tryMovement(unit, directHeading, movementDistance)) {
      return;
    }

    const alternativeHeadings = avoidanceHeadings(currentHeading, directHeading, maximumTurn);
    for (const alternativeHeading of alternativeHeadings) {
      const alternativeAlignment = Math.max(
        0,
        Math.cos(shortestAngle(alternativeHeading, desiredHeading))
      );
      const alternativeDistance = Math.min(
        unit.profile.maxSpeed * alternativeAlignment * FIXED_STEP_SECONDS,
        planarDistance - stopRadius
      );
      if (
        alternativeDistance > 0 &&
        this.tryMovement(unit, alternativeHeading, alternativeDistance)
      ) {
        return;
      }
    }

    unit.heading = alternativeHeadings[0] ?? directHeading;
  }

  private tryMovement(unit: MutableUnit, heading: number, movementDistance: number): boolean {
    const movementX = Math.sin(heading) * movementDistance;
    const movementZ = Math.cos(heading) * movementDistance;
    const candidate = mutableVec3(
      unit.position.x + movementX,
      unit.position.y,
      unit.position.z + movementZ
    );

    if (!this.canTraverse(unit, candidate)) {
      return false;
    }

    unit.heading = heading;
    unit.position = candidate;
    unit.velocity = mutableVec3(movementX / FIXED_STEP_SECONDS, 0, movementZ / FIXED_STEP_SECONDS);
    return true;
  }

  private canTraverse(unit: MutableUnit, destination: MutableVec3): boolean {
    if (this.isPositionPassable === undefined || unit.type === 'jet') {
      return true;
    }

    const origin = unit.position;
    const travelDistance = distance(origin, destination);
    const probeCount = Math.max(1, Math.ceil(travelDistance / PASSABILITY_PROBE_SPACING_METERS));
    let segmentStart = copyMutableVec3(origin);

    for (let probeIndex = 1; probeIndex <= probeCount; probeIndex += 1) {
      const progress = probeIndex / probeCount;
      const segmentEnd = mutableVec3(
        origin.x + (destination.x - origin.x) * progress,
        origin.y + (destination.y - origin.y) * progress,
        origin.z + (destination.z - origin.z) * progress
      );
      const passable = this.isPositionPassable(
        Object.freeze({
          unitId: unit.id,
          unitType: unit.type,
          teamId: unit.teamId,
          from: freezeVec3(segmentStart),
          candidate: freezeVec3(segmentEnd),
        })
      );
      if (!passable) {
        return false;
      }
      segmentStart = segmentEnd;
    }

    return true;
  }

  private movementTarget(unit: MutableUnit): Vec3 | undefined {
    if (unit.order.kind === 'hold') {
      return undefined;
    }

    if (unit.order.kind === 'move') {
      return unit.order.destination;
    }

    const target = unit.targetId === undefined ? undefined : this.units.get(unit.targetId);
    return isEnemyAlive(unit, target) ? target.position : undefined;
  }

  private stopRadius(unit: MutableUnit): number {
    if (unit.order.kind === 'move') {
      return unit.order.stopRadius ?? DEFAULT_STOP_RADIUS;
    }

    if (unit.type === 'jet') {
      return 0;
    }

    return unit.profile.preferredRange;
  }

  private resolveCombat(): void {
    const shots: ShotIntent[] = [];

    for (const actor of this.orderedUnits()) {
      if (!actor.alive || actor.cooldownRemaining > STEP_EPSILON) {
        continue;
      }

      const target = actor.targetId === undefined ? undefined : this.units.get(actor.targetId);
      if (
        !isEnemyAlive(actor, target) ||
        distance(actor.position, target.position) > actor.profile.weapon.range
      ) {
        continue;
      }

      actor.cooldownRemaining = actor.profile.weapon.cooldownSeconds;
      const hit = this.random.next() < actor.profile.weapon.hitChance;
      shots.push({
        actor,
        target,
        hit,
        damage: actor.profile.weapon.damage,
      });
      this.appendEvent('weapon-fired', {
        actorId: actor.id,
        targetId: target.id,
        teamId: actor.teamId,
        message: `${actor.name} fired on ${target.name}`,
      });
    }

    for (const shot of shots) {
      if (!shot.hit) {
        this.appendEvent('miss', {
          actorId: shot.actor.id,
          targetId: shot.target.id,
          teamId: shot.actor.teamId,
          message: `${shot.actor.name} missed ${shot.target.name}`,
        });
        continue;
      }

      shot.target.health = Math.max(0, shot.target.health - shot.damage);
      this.appendEvent('hit', {
        actorId: shot.actor.id,
        targetId: shot.target.id,
        teamId: shot.actor.teamId,
        amount: shot.damage,
        message: `${shot.actor.name} hit ${shot.target.name} for ${formatNumber(shot.damage)}`,
      });
    }

    for (const unit of this.orderedUnits()) {
      if (unit.alive && unit.health <= 0) {
        unit.alive = false;
        unit.targetId = undefined;
        unit.velocity = mutableVec3(0, 0, 0);
        this.appendEvent('unit-destroyed', {
          targetId: unit.id,
          teamId: unit.teamId,
          message: `${unit.name} was destroyed`,
        });
      }
    }
  }

  private evaluateOutcome(): void {
    const livingTeams = this.scenario.teams.filter((team) =>
      this.orderedUnits().some((unit) => unit.alive && unit.teamId === team.id)
    );

    if (livingTeams.length === 1) {
      const winner = livingTeams[0];
      this.outcome = Object.freeze({
        phase: 'victory',
        winnerTeamId: winner.id,
        reason: `${winner.name} eliminated all opposing forces`,
      });
      this.paused = true;
      this.accumulator = 0;
      this.appendEvent('victory', {
        teamId: winner.id,
        message: `${winner.name} won the battle`,
      });
      return;
    }

    if (livingTeams.length === 0) {
      this.finishAsDraw('All forces were eliminated');
      return;
    }

    const durationLimit = this.scenario.maxDurationSeconds;
    if (durationLimit !== undefined && this.tick * FIXED_STEP_SECONDS >= durationLimit) {
      this.finishAsDraw('The scenario time limit expired');
    }
  }

  private finishAsDraw(reason: string): void {
    this.outcome = Object.freeze({ phase: 'draw', reason });
    this.paused = true;
    this.accumulator = 0;
    this.appendEvent('draw', {
      message: reason,
    });
  }

  private appendEvent(
    type: BattleEventType,
    details: Omit<BattleEvent, 'id' | 'sequence' | 'tick' | 'timeSeconds' | 'type'>
  ): void {
    this.eventSequence += 1;
    const event = Object.freeze({
      id: `event-${this.eventSequence}`,
      sequence: this.eventSequence,
      tick: this.tick,
      timeSeconds: this.tick * FIXED_STEP_SECONDS,
      type,
      ...details,
    });
    this.events.push(event);

    if (this.events.length > this.eventLogLimit) {
      this.events.splice(0, this.events.length - this.eventLogLimit);
    }
  }

  private createStatus(): BattleStatus {
    if (this.outcome !== undefined) {
      return Object.freeze({
        phase: this.outcome.phase,
        ...(this.outcome.winnerTeamId === undefined
          ? {}
          : { winnerTeamId: this.outcome.winnerTeamId }),
        reason: this.outcome.reason,
      });
    }

    if (!this.begun) {
      return Object.freeze({ phase: 'ready' });
    }

    return Object.freeze({ phase: this.paused ? 'paused' : 'running' });
  }

  private createTeamSnapshots(): TeamSnapshot[] {
    return this.scenario.teams.map((team) => {
      const teamUnits = this.orderedUnits().filter((unit) => unit.teamId === team.id);
      return Object.freeze({
        id: team.id,
        name: team.name,
        color: team.color,
        aliveUnits: teamUnits.filter((unit) => unit.alive).length,
        totalUnits: teamUnits.length,
      });
    });
  }

  private orderedUnits(): MutableUnit[] {
    return this.orderedUnitIds.flatMap((id) => {
      const unit = this.units.get(id);
      return unit === undefined ? [] : [unit];
    });
  }

  private interpolationAlpha(): number {
    return clamp(this.accumulator / FIXED_STEP_SECONDS, 0, 1);
  }
}

function createMutableUnit(spawn: UnitSpawn): MutableUnit {
  const profile = mergeProfile(spawn.type, spawn.profile);
  const position = copyMutableVec3(spawn.position);
  return {
    id: spawn.id,
    name: spawn.name ?? spawn.id,
    type: spawn.type,
    teamId: spawn.teamId,
    profile,
    position,
    previousPosition: copyMutableVec3(position),
    heading: normalizeAngle(spawn.heading ?? 0),
    previousHeading: normalizeAngle(spawn.heading ?? 0),
    velocity: mutableVec3(0, 0, 0),
    health: profile.maxHealth,
    alive: true,
    targetId: undefined,
    order: cloneAndValidateOrder(spawn.order ?? { kind: 'pursue' }),
    cooldownRemaining: 0,
  };
}

function mergeProfile(type: UnitSpawn['type'], overrides: UnitSpawn['profile']): UnitProfile {
  const base = UNIT_PROFILES[type];
  const profile = {
    maxHealth: overrides?.maxHealth ?? base.maxHealth,
    maxSpeed: overrides?.maxSpeed ?? base.maxSpeed,
    turnRateRadians: overrides?.turnRateRadians ?? base.turnRateRadians,
    sensorRange: overrides?.sensorRange ?? base.sensorRange,
    preferredRange: overrides?.preferredRange ?? base.preferredRange,
    weapon: {
      range: overrides?.weapon?.range ?? base.weapon.range,
      damage: overrides?.weapon?.damage ?? base.weapon.damage,
      cooldownSeconds: overrides?.weapon?.cooldownSeconds ?? base.weapon.cooldownSeconds,
      hitChance: overrides?.weapon?.hitChance ?? base.weapon.hitChance,
    },
  };

  positiveNumber(profile.maxHealth, 'profile.maxHealth');
  finiteNonNegativeNumber(profile.maxSpeed, 'profile.maxSpeed');
  positiveNumber(profile.turnRateRadians, 'profile.turnRateRadians');
  positiveNumber(profile.sensorRange, 'profile.sensorRange');
  finiteNonNegativeNumber(profile.preferredRange, 'profile.preferredRange');
  positiveNumber(profile.weapon.range, 'profile.weapon.range');
  positiveNumber(profile.weapon.damage, 'profile.weapon.damage');
  positiveNumber(profile.weapon.cooldownSeconds, 'profile.weapon.cooldownSeconds');
  probability(profile.weapon.hitChance, 'profile.weapon.hitChance');

  if (profile.preferredRange > profile.weapon.range) {
    throw new Error('profile.preferredRange cannot exceed weapon range.');
  }

  return Object.freeze({
    ...profile,
    weapon: Object.freeze(profile.weapon),
  });
}

function createUnitSnapshot(unit: MutableUnit): UnitSnapshot {
  const velocity = freezeVec3(unit.velocity);
  return Object.freeze({
    id: unit.id,
    name: unit.name,
    type: unit.type,
    teamId: unit.teamId,
    position: freezeVec3(unit.position),
    previousPosition: freezeVec3(unit.previousPosition),
    heading: unit.heading,
    previousHeading: unit.previousHeading,
    velocity,
    speed: Math.hypot(velocity.x, velocity.y, velocity.z),
    health: unit.health,
    maxHealth: unit.profile.maxHealth,
    alive: unit.alive,
    ...(unit.targetId === undefined ? {} : { targetId: unit.targetId }),
    order: cloneAndValidateOrder(unit.order),
    cooldownRemaining: unit.cooldownRemaining,
  });
}

function cloneAndValidateScenario(scenario: BattleScenario): BattleScenario {
  if (scenario.id.trim().length === 0) {
    throw new Error('Scenario id cannot be empty.');
  }
  if (scenario.name.trim().length === 0) {
    throw new Error('Scenario name cannot be empty.');
  }
  if (scenario.teams.length < 2) {
    throw new Error('A battle scenario requires at least two teams.');
  }
  if (scenario.units.length < 2) {
    throw new Error('A battle scenario requires at least two units.');
  }

  const teamIds = new Set<TeamId>();
  const teams = scenario.teams.map((team) => {
    if (team.id.trim().length === 0 || teamIds.has(team.id)) {
      throw new Error(`Team id must be non-empty and unique: ${team.id}`);
    }
    teamIds.add(team.id);
    return Object.freeze({ ...team });
  });

  const unitIds = new Set<UnitId>();
  const units = scenario.units.map((unit) => {
    if (unit.id.trim().length === 0 || unitIds.has(unit.id)) {
      throw new Error(`Unit id must be non-empty and unique: ${unit.id}`);
    }
    if (!teamIds.has(unit.teamId)) {
      throw new Error(`Unit ${unit.id} references unknown team ${unit.teamId}.`);
    }
    validateVec3(unit.position, `unit ${unit.id} position`);
    mergeProfile(unit.type, unit.profile);
    unitIds.add(unit.id);

    return Object.freeze({
      ...unit,
      position: freezeVec3(unit.position),
      ...(unit.order === undefined ? {} : { order: cloneAndValidateOrder(unit.order) }),
      ...(unit.profile === undefined
        ? {}
        : {
            profile: Object.freeze({
              ...unit.profile,
              ...(unit.profile.weapon === undefined
                ? {}
                : { weapon: Object.freeze({ ...unit.profile.weapon }) }),
            }),
          }),
    });
  });

  for (const teamId of teamIds) {
    if (!units.some((unit) => unit.teamId === teamId)) {
      throw new Error(`Team ${teamId} must have at least one unit.`);
    }
  }

  optionalFiniteNumber(scenario.seed, 'scenario.seed');
  if (scenario.maxDurationSeconds !== undefined) {
    positiveNumber(scenario.maxDurationSeconds, 'scenario.maxDurationSeconds');
  }

  return Object.freeze({
    ...scenario,
    teams: Object.freeze(teams),
    units: Object.freeze(units),
  });
}

function cloneAndValidateOrder(order: UnitOrder): UnitOrder {
  if (order.kind === 'hold') {
    return Object.freeze({ kind: 'hold' });
  }

  if (order.kind === 'pursue') {
    return Object.freeze({
      kind: 'pursue',
      ...(order.targetId === undefined ? {} : { targetId: order.targetId }),
    });
  }

  validateVec3(order.destination, 'order.destination');
  if (order.stopRadius !== undefined) {
    finiteNonNegativeNumber(order.stopRadius, 'order.stopRadius');
  }
  return Object.freeze({
    kind: 'move',
    destination: freezeVec3(order.destination),
    ...(order.stopRadius === undefined ? {} : { stopRadius: order.stopRadius }),
  });
}

function isEnemyAlive(
  unit: MutableUnit,
  candidate: MutableUnit | undefined
): candidate is MutableUnit {
  return candidate !== undefined && candidate.alive && candidate.teamId !== unit.teamId;
}

function distance(left: Vec3, right: Vec3): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function shortestAngle(from: number, to: number): number {
  let difference = normalizeAngle(to) - normalizeAngle(from);
  if (difference > Math.PI) {
    difference -= TWO_PI;
  } else if (difference < -Math.PI) {
    difference += TWO_PI;
  }
  return difference;
}

function normalizeAngle(angle: number): number {
  const normalized = angle % TWO_PI;
  return normalized < 0 ? normalized + TWO_PI : normalized;
}

function avoidanceHeadings(
  currentHeading: number,
  directHeading: number,
  maximumTurn: number
): readonly number[] {
  const headings: number[] = [];

  for (const fraction of AVOIDANCE_TURN_FRACTIONS) {
    const candidate = normalizeAngle(currentHeading + maximumTurn * fraction);
    const duplicatesDirect = Math.abs(shortestAngle(candidate, directHeading)) <= STEP_EPSILON;
    const alreadyIncluded = headings.some(
      (heading) => Math.abs(shortestAngle(candidate, heading)) <= STEP_EPSILON
    );
    if (!duplicatesDirect && !alreadyIncluded) {
      headings.push(candidate);
    }
  }

  return headings;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function mutableVec3(x: number, y: number, z: number): MutableVec3 {
  return { x, y, z };
}

function copyMutableVec3(vector: Vec3): MutableVec3 {
  return mutableVec3(vector.x, vector.y, vector.z);
}

function freezeVec3(vector: Vec3): Vec3 {
  return Object.freeze({ x: vector.x, y: vector.y, z: vector.z });
}

function validateVec3(vector: Vec3, name: string): void {
  finiteNumber(vector.x, `${name}.x`);
  finiteNumber(vector.y, `${name}.y`);
  finiteNumber(vector.z, `${name}.z`);
}

function finiteNumber(value: number, name: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be finite.`);
  }
  return value;
}

function optionalFiniteNumber(value: number | undefined, name: string): number | undefined {
  return value === undefined ? undefined : finiteNumber(value, name);
}

function finiteNonNegativeNumber(value: number, name: string): number {
  finiteNumber(value, name);
  if (value < 0) {
    throw new Error(`${name} must be non-negative.`);
  }
  return value;
}

function positiveNumber(value: number, name: string): number {
  finiteNumber(value, name);
  if (value <= 0) {
    throw new Error(`${name} must be greater than zero.`);
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function probability(value: number, name: string): number {
  finiteNumber(value, name);
  if (value < 0 || value > 1) {
    throw new Error(`${name} must be between zero and one.`);
  }
  return value;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? `${value}` : value.toFixed(1);
}

function compareIds(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}
