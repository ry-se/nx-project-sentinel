import {
  type BattleScenario,
  BattleSimulation,
  type BattleSnapshot,
  createArmoredSkirmishScenario,
  createCombinedArmsScenario,
  type PassabilityCallback,
  type UnitOrder,
  type UnitSpawn,
  type UnitSnapshot,
  UNIT_PROFILES,
  UNIT_TYPES,
  type UnitType,
  type Vec3,
} from '@org/simulation-core';
import {
  BoxGeometry,
  BufferGeometry,
  Color,
  CylinderGeometry,
  Group,
  Line,
  LineBasicMaterial,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type Object3D,
  type PerspectiveCamera,
  Raycaster,
  RingGeometry,
  type Scene,
  SphereGeometry,
  Vector2,
  Vector3,
} from 'three';

import { disposeObject3D, disposeObjectChildren } from './disposeThree';
import {
  DETECTION_CLASS_TO_BATTLE_UNIT,
  type ProjectedIntelContact,
  type SentinelDetection,
} from './detections';
import type { ModelLibrary } from './modelCatalog';
import type { TerrainSemanticsSummary, TerrainSurfaceClass } from './terrainSemantics';
import { buildCarPrimitive, buildJetPrimitive, buildTankPrimitive } from './vehicles';

export const BATTLE_SCENARIO_IDS = ['none', 'armored-skirmish', 'combined-arms'] as const;
export type BattleScenarioId = (typeof BATTLE_SCENARIO_IDS)[number];
export const BATTLE_TEAM_IDS = ['blue', 'red'] as const;
export type BattleTeamId = (typeof BATTLE_TEAM_IDS)[number];

export type BattlePlacementFailureReason =
  | 'invalid-request'
  | 'battle-running'
  | 'no-terrain-hit'
  | 'terrain-not-ready'
  | 'building'
  | 'water'
  | 'outside-coverage'
  | 'unsafe-scenario';

export type BattleTerrainConfidence = 'mapped' | 'limited';

export interface BattlePlacementResult {
  readonly accepted: boolean;
  readonly reason?: BattlePlacementFailureReason;
  readonly message: string;
  readonly scenarioId: BattleScenarioId;
  readonly teamId: BattleTeamId;
  readonly unitType: UnitType;
  readonly unitId?: string;
  readonly worldPosition?: Vec3;
  readonly manualUnitCount: number;
  readonly terrainConfidence?: BattleTerrainConfidence;
  readonly snapshot: BattleSnapshot | null;
}

export type BattleIntelOrder = 'hold' | 'pursue';

export interface BattleIntelAssignment {
  readonly teamId: BattleTeamId;
  readonly order: BattleIntelOrder;
}

export interface BattleIntelHeldContact {
  readonly detectionId: string;
  readonly reason: string;
}

export interface BattleIntelImportResult {
  readonly acceptedIds: readonly string[];
  readonly duplicateIds: readonly string[];
  readonly held: readonly BattleIntelHeldContact[];
  readonly deploymentCount: number;
  readonly snapshot: BattleSnapshot | null;
  readonly message: string;
}

interface TerrainSemanticProvider {
  classifyWorld(position: Pick<Vector3, 'x' | 'z'>, clearanceM: number): TerrainSurfaceClass;
  readonly summary: TerrainSemanticsSummary;
}

const ALWAYS_CLEAR_TERRAIN: TerrainSemanticProvider = Object.freeze({
  classifyWorld: () => 'clear',
  summary: Object.freeze({
    status: 'ready',
    buildingCount: 0,
    waterCount: 0,
    message: 'Renderer test terrain accepts all positions',
  }),
});

export class BattleScenarioStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BattleScenarioStartError';
  }
}

export interface BattleScenarioOption {
  readonly id: BattleScenarioId;
  readonly label: string;
  readonly description: string;
}

export const BATTLE_SCENARIO_OPTIONS: readonly BattleScenarioOption[] = Object.freeze([
  {
    id: 'none',
    label: 'No example scenario',
    description:
      'Start with an empty battlefield. Deploy or import at least one unit for each force before running.',
  },
  {
    id: 'armored-skirmish',
    label: 'Armored skirmish',
    description: 'Two balanced armored teams meet and autonomously fight for fire superiority.',
  },
  {
    id: 'combined-arms',
    label: 'Combined arms',
    description:
      'Infantry, cars, tanks, and jets coordinate through one deterministic battle model.',
  },
]);

type ScenarioFactory = () => BattleScenario;

const SCENARIO_FACTORIES: Readonly<Record<BattleScenarioId, ScenarioFactory>> = Object.freeze({
  none: createNoExampleScenario,
  'armored-skirmish': createArmoredSkirmishScenario,
  'combined-arms': createCombinedArmsScenario,
});

function createNoExampleScenario(): BattleScenario {
  return Object.freeze({
    id: 'none',
    name: 'Custom Battle',
    description: 'An empty battle setup containing only operator-deployed forces.',
    maxDurationSeconds: 180,
    teams: Object.freeze([
      Object.freeze({ id: 'blue', name: 'Blue Force', color: '#38bdf8' }),
      Object.freeze({ id: 'red', name: 'Red Force', color: '#fb7185' }),
    ]),
    units: Object.freeze([]),
  });
}

const DOWN = new Vector3(0, -1, 0);
const OVERLAY_LAYER = 1;
const GROUND_SAMPLE_HEIGHT_M = 700;
const GROUND_RAY_LENGTH_M = 1_500;
const GROUND_SAMPLE_INTERVAL_S = 0.15;
const GROUND_EASE_RATE = 8;
const RING_INNER_RADIUS_M = 3.3;
const RING_OUTER_RADIUS_M = 3.75;
const RING_SEGMENTS = 40;
const RING_Y_M = 0.08;
const HEALTH_BAR_WIDTH_M = 4.8;
const HEALTH_BAR_DEPTH_M = 0.42;
const HEALTH_BAR_HEIGHT_M = 0.1;
const HEALTH_BAR_Y_BY_TYPE: Readonly<Record<UnitSnapshot['type'], number>> = Object.freeze({
  infantry: 2.5,
  car: 2.2,
  tank: 3.2,
  jet: 3.1,
});
const GROUND_CLEARANCE_BY_TYPE: Readonly<Record<UnitSnapshot['type'], number>> = Object.freeze({
  infantry: 0.05,
  car: 0.18,
  tank: 0.2,
  jet: 0,
});
const DEFAULT_TEAM_COLOR = 0xd8dee9;
const DEAD_RING_COLOR = 0x6b7280;
const HEALTH_BACKGROUND_COLOR = 0x171c25;
const HEALTH_GOOD_COLOR = 0x42d392;
const HEALTH_DANGER_COLOR = 0xf05252;
const HEALTH_DANGER_THRESHOLD = 0.35;
const INFANTRY_BODY_COLOR = 0x65704d;
const INFANTRY_EQUIPMENT_COLOR = 0x252a24;
const TRACER_COLOR = 0xffd166;
const TRACER_LIFETIME_S = 0.2;
const TRACER_START_HEIGHT_M = 1.6;
const TRACER_END_HEIGHT_M = 1.1;
const MAX_FRAME_DELTA_S = 0.25;
const DEPLOYMENT_RAY_MAX_DISTANCE_M = 3_000;
const MANUAL_JET_ALTITUDE_M = 90;
const BLUE_MANUAL_HEADING = 0;
const RED_MANUAL_HEADING = Math.PI;
const SAFE_SPAWN_SEARCH_STEP_M = 12;
const SAFE_SPAWN_SEARCH_RADIUS_M = 1_200;
const SAFE_SPAWN_ANGLES = 24;
const FULL_CIRCLE_RADIANS = Math.PI * 2;
const STABLE_HASH_MULTIPLIER = 31;
const UNIT_OBSTACLE_CLEARANCE_M: Readonly<Record<UnitType, number>> = Object.freeze({
  infantry: 0.8,
  car: 2.4,
  tank: 4,
  jet: 0,
});

interface RenderUnit {
  readonly group: Group;
  readonly model: Group;
  readonly ringMaterial: MeshBasicMaterial;
  readonly healthFill: Mesh;
  readonly healthMaterial: MeshBasicMaterial;
  groundY: number;
  displayedY: number;
}

interface TracerEffect {
  readonly object: Line;
  readonly material: LineBasicMaterial;
  remainingSeconds: number;
}

interface BattleDeployment {
  readonly id: string;
  readonly scenarioId: BattleScenarioId;
  readonly teamId: BattleTeamId;
  readonly unitType: UnitType;
  readonly worldPosition: Vec3;
  readonly heading: number;
  readonly name: string;
  readonly order: UnitOrder;
  readonly source:
    Readonly<{ kind: 'manual' }> | Readonly<{ kind: 'intel'; detection: SentinelDetection }>;
}

interface GroundSpawnReservation {
  readonly x: number;
  readonly z: number;
  readonly clearanceM: number;
}

/**
 * Presentation adapter for the deterministic simulation package. Three.js owns visuals only:
 * targeting, movement, damage, and victory are all decided in `@org/simulation-core`.
 */
export class BattleSimulationController {
  private readonly root = new Group();
  private readonly terrain: Object3D;
  private readonly modelLibrary: ModelLibrary;
  private readonly terrainSemantics: TerrainSemanticProvider;
  private readonly raycaster = new Raycaster();
  private readonly units = new Map<string, RenderUnit>();
  private readonly tracers: TracerEffect[] = [];
  private readonly deployments = new Map<BattleScenarioId, BattleDeployment[]>();
  private simulation: BattleSimulation | null = null;
  private preparedSnapshot: BattleSnapshot | null = null;
  private activeScenarioId: BattleScenarioId | null = null;
  private activeOrigin = new Vector3();
  private lastEventSequence = 0;
  private groundSampleElapsed = GROUND_SAMPLE_INTERVAL_S;
  private originGroundY = 0;
  private disposed = false;
  private timeScale = 1;

  constructor(
    scene: Scene,
    terrain: Object3D,
    modelLibrary: ModelLibrary,
    terrainSemantics: TerrainSemanticProvider = ALWAYS_CLEAR_TERRAIN
  ) {
    this.terrain = terrain;
    this.modelLibrary = modelLibrary;
    this.terrainSemantics = terrainSemantics;
    this.root.name = 'battle-simulation';
    this.root.layers.set(OVERLAY_LAYER);
    (this.raycaster as unknown as { firstHitOnly: boolean }).firstHitOnly = true;
    scene.add(this.root);
  }

  public startScenario(id: BattleScenarioId, origin: Vector3): BattleSnapshot {
    this.assertActive();
    if (id === 'none' && !this.hasDeploymentForEachTeam(id)) {
      throw new BattleScenarioStartError(
        'Deploy or import at least one Blue Force unit and one Red Force unit before running without an example scenario.'
      );
    }
    this.rememberSetup(id, origin);
    const scenario = this.buildSafeScenario(id, origin);
    this.clearVisuals();
    this.root.position.copy(horizontalOrigin(origin));
    this.simulation = this.createSimulation(scenario);
    this.preparedSnapshot = null;
    this.simulation.start();
    this.lastEventSequence = 0;
    this.groundSampleElapsed = GROUND_SAMPLE_INTERVAL_S;
    this.originGroundY = 0;
    const snapshot = this.simulation.getSnapshot();
    this.syncSnapshot(snapshot, 0);
    return snapshot;
  }

  public placeUnit(
    scenarioId: BattleScenarioId,
    teamId: BattleTeamId,
    unitType: UnitType,
    clientX: number,
    clientY: number,
    camera: PerspectiveCamera,
    canvas: HTMLCanvasElement,
    origin: Vector3
  ): BattlePlacementResult {
    this.assertActive();
    const existingDeployments = this.deployments.get(scenarioId) ?? [];
    const currentSnapshot = this.getSnapshot();
    const baseResult = {
      scenarioId,
      teamId,
      unitType,
      manualUnitCount: existingDeployments.length,
      snapshot: currentSnapshot,
    } as const;

    if (
      !BATTLE_SCENARIO_IDS.includes(scenarioId) ||
      !BATTLE_TEAM_IDS.includes(teamId) ||
      !UNIT_TYPES.includes(unitType) ||
      !Number.isFinite(clientX) ||
      !Number.isFinite(clientY)
    ) {
      return {
        ...baseResult,
        accepted: false,
        reason: 'invalid-request',
        message: 'Choose a valid scenario template, team, unit, and map position.',
      };
    }

    if (currentSnapshot?.status.phase === 'running' || currentSnapshot?.status.phase === 'paused') {
      return {
        ...baseResult,
        accepted: false,
        reason: 'battle-running',
        message: 'Stop the battle before changing its deployed forces.',
      };
    }

    const hit = this.pickTerrain(clientX, clientY, camera, canvas);
    if (!hit) {
      return {
        ...baseResult,
        accepted: false,
        reason: 'no-terrain-hit',
        message: 'No loaded terrain was found beneath that drop point.',
      };
    }

    let terrainConfidence: BattleTerrainConfidence = 'mapped';
    if (unitType !== 'jet') {
      const surface = this.terrainSemantics.classifyWorld(hit, UNIT_OBSTACLE_CLEARANCE_M[unitType]);
      if (!terrainAllowsGround(surface)) {
        return {
          ...baseResult,
          accepted: false,
          reason: placementReasonForSurface(surface),
          message: placementMessageForSurface(surface),
        };
      }
      terrainConfidence = surface === 'unknown' ? 'limited' : 'mapped';

      const clearanceM = UNIT_OBSTACLE_CLEARANCE_M[unitType];
      const overlapsManualUnit = existingDeployments.some((deployment) => {
        if (deployment.unitType === 'jet') return false;
        const minimumSeparation = clearanceM + UNIT_OBSTACLE_CLEARANCE_M[deployment.unitType];
        return (
          Math.hypot(hit.x - deployment.worldPosition.x, hit.z - deployment.worldPosition.z) <
          minimumSeparation
        );
      });
      if (overlapsManualUnit) {
        return {
          ...baseResult,
          accepted: false,
          reason: 'unsafe-scenario',
          message: 'Move this unit farther from the previously deployed ground unit.',
        };
      }
    }

    const ordinal =
      existingDeployments.filter(
        (deployment) => deployment.teamId === teamId && deployment.unitType === unitType
      ).length + 1;
    const unitId = `manual-${scenarioId}-${teamId}-${unitType}-${ordinal}`;
    const deployment: BattleDeployment = Object.freeze({
      id: unitId,
      scenarioId,
      teamId,
      unitType,
      worldPosition: Object.freeze({ x: hit.x, y: hit.y, z: hit.z }),
      heading: teamId === 'blue' ? BLUE_MANUAL_HEADING : RED_MANUAL_HEADING,
      name: `${teamName(teamId)} Manual ${unitTypeName(unitType)} ${ordinal}`,
      order: Object.freeze({ kind: 'pursue' as const }),
      source: Object.freeze({ kind: 'manual' as const }),
    });
    const nextDeployments = [...existingDeployments, deployment];
    this.deployments.set(scenarioId, nextDeployments);
    const snapshot = this.prepareScenarioOrDraft(scenarioId, origin);

    return {
      accepted: true,
      message:
        terrainConfidence === 'limited'
          ? `${teamName(teamId)} ${unitType} deployed with limited terrain coverage; mapped obstacles will still block it.`
          : `${teamName(teamId)} ${unitType} deployed.`,
      scenarioId,
      teamId,
      unitType,
      unitId,
      worldPosition: deployment.worldPosition,
      manualUnitCount: nextDeployments.length,
      terrainConfidence,
      snapshot,
    };
  }

  public importIntelContacts(
    scenarioId: BattleScenarioId,
    assignment: BattleIntelAssignment,
    contacts: readonly ProjectedIntelContact[],
    origin: Vector3
  ): BattleIntelImportResult {
    this.assertActive();
    const currentSnapshot = this.getSnapshot();
    const existing = this.deployments.get(scenarioId) ?? [];
    const acceptedIds: string[] = [];
    const duplicateIds: string[] = [];
    const held: BattleIntelHeldContact[] = [];
    let limitedCount = 0;

    if (
      !BATTLE_TEAM_IDS.includes(assignment.teamId) ||
      (assignment.order !== 'hold' && assignment.order !== 'pursue')
    ) {
      return Object.freeze({
        acceptedIds: Object.freeze([]),
        duplicateIds: Object.freeze([]),
        held: Object.freeze(
          contacts.map((contact) =>
            Object.freeze({
              detectionId: contact.detection.detection_id,
              reason: 'Choose a valid battle team and initial behavior.',
            })
          )
        ),
        deploymentCount: existing.length,
        snapshot: currentSnapshot,
        message: 'Imported intel assignment was invalid.',
      });
    }

    if (currentSnapshot?.status.phase === 'running' || currentSnapshot?.status.phase === 'paused') {
      return Object.freeze({
        acceptedIds: Object.freeze([]),
        duplicateIds: Object.freeze([]),
        held: Object.freeze(
          contacts.map((contact) =>
            Object.freeze({
              detectionId: contact.detection.detection_id,
              reason: 'Stop the active battle before linking imported intel.',
            })
          )
        ),
        deploymentCount: existing.length,
        snapshot: currentSnapshot,
        message: 'Imported intel was held because a battle is active.',
      });
    }

    const next = [...existing];
    for (const contact of contacts) {
      const detectionId = contact.detection.detection_id;
      if (
        next.some(
          (deployment) =>
            deployment.source.kind === 'intel' &&
            deployment.source.detection.detection_id === detectionId
        )
      ) {
        duplicateIds.push(detectionId);
        continue;
      }

      const unitType = DETECTION_CLASS_TO_BATTLE_UNIT[contact.detection.class];
      if (!isFiniteVec3(contact.worldPosition)) {
        held.push({ detectionId, reason: 'Projected world position was invalid.' });
        continue;
      }

      if (unitType !== 'jet') {
        const surface = this.terrainSemantics.classifyWorld(
          contact.worldPosition,
          UNIT_OBSTACLE_CLEARANCE_M[unitType]
        );
        if (!terrainAllowsGround(surface)) {
          held.push({ detectionId, reason: placementMessageForSurface(surface) });
          continue;
        }
        if (overlapsGroundDeployment(next, contact.worldPosition, unitType)) {
          held.push({ detectionId, reason: 'Too close to another deployed ground unit.' });
          continue;
        }
        if (surface === 'unknown') limitedCount += 1;
      }

      const baseId = `intel-${safeUnitIdentifier(detectionId)}`;
      let id = baseId;
      let collisionOrdinal = 2;
      while (next.some((deployment) => deployment.id === id)) {
        id = `${baseId}-${collisionOrdinal}`;
        collisionOrdinal += 1;
      }
      const order: UnitOrder = Object.freeze({ kind: assignment.order });
      next.push(
        Object.freeze({
          id,
          scenarioId,
          teamId: assignment.teamId,
          unitType,
          worldPosition: Object.freeze({ ...contact.worldPosition }),
          heading: Number.isFinite(contact.localHeadingRad)
            ? (contact.localHeadingRad as number)
            : assignment.teamId === 'blue'
              ? BLUE_MANUAL_HEADING
              : RED_MANUAL_HEADING,
          name: `${teamName(assignment.teamId)} Intel ${unitTypeName(unitType)} ${shortDetectionId(detectionId)}`,
          order,
          source: Object.freeze({ kind: 'intel' as const, detection: contact.detection }),
        })
      );
      acceptedIds.push(detectionId);
    }

    this.deployments.set(scenarioId, next);
    const snapshot =
      acceptedIds.length > 0 ? this.prepareScenarioOrDraft(scenarioId, origin) : currentSnapshot;
    const message = intelImportMessage(
      acceptedIds.length,
      held.length,
      duplicateIds.length,
      limitedCount
    );
    return Object.freeze({
      acceptedIds: Object.freeze(acceptedIds),
      duplicateIds: Object.freeze(duplicateIds),
      held: Object.freeze(held.map((entry) => Object.freeze(entry))),
      deploymentCount: next.length,
      snapshot,
      message,
    });
  }

  public update(frameDeltaSeconds: number): BattleSnapshot | null {
    if (!this.simulation || this.disposed) return this.preparedSnapshot;
    const deltaSeconds = MathUtils.clamp(frameDeltaSeconds, 0, MAX_FRAME_DELTA_S);
    const result = this.simulation.advance(deltaSeconds * this.timeScale);
    this.groundSampleElapsed += deltaSeconds;
    this.syncSnapshot(result.snapshot, deltaSeconds);
    this.updateTracers(deltaSeconds);
    return result.snapshot;
  }

  public setPaused(paused: boolean): BattleSnapshot | null {
    if (!this.simulation) return null;
    this.simulation.setPaused(paused);
    const snapshot = this.simulation.getSnapshot();
    this.syncSnapshot(snapshot, 0);
    return snapshot;
  }

  public setTimeScale(scale: number): void {
    this.timeScale = MathUtils.clamp(scale, 0.25, 4);
  }

  public getTimeScale(): number {
    return this.timeScale;
  }

  public restart(): BattleSnapshot | null {
    if (!this.simulation) return null;
    this.clearVisuals();
    this.preparedSnapshot = null;
    this.simulation.restart();
    this.simulation.start();
    this.lastEventSequence = 0;
    this.groundSampleElapsed = GROUND_SAMPLE_INTERVAL_S;
    const snapshot = this.simulation.getSnapshot();
    this.syncSnapshot(snapshot, 0);
    return snapshot;
  }

  public stop(): void {
    this.simulation = null;
    this.preparedSnapshot = null;
    this.lastEventSequence = 0;
    this.clearVisuals();
    if (
      this.activeScenarioId !== null &&
      (this.deployments.get(this.activeScenarioId)?.length ?? 0) > 0
    ) {
      this.prepareScenarioOrDraft(this.activeScenarioId, this.activeOrigin);
    }
  }

  public getSnapshot(): BattleSnapshot | null {
    return this.simulation?.getSnapshot() ?? this.preparedSnapshot;
  }

  private createSimulation(scenario: BattleScenario): BattleSimulation {
    return new BattleSimulation(scenario, {
      isPositionPassable: this.isPositionPassable,
    });
  }

  private readonly isPositionPassable: PassabilityCallback = ({ unitType, candidate }) => {
    if (unitType === 'jet') return true;
    const surface = this.terrainSemantics.classifyWorld(
      {
        x: this.root.position.x + candidate.x,
        z: this.root.position.z + candidate.z,
      },
      UNIT_OBSTACLE_CLEARANCE_M[unitType]
    );
    return terrainAllowsGround(surface);
  };

  private buildSafeScenario(id: BattleScenarioId, origin: Vector3): BattleScenario {
    const baseScenario = SCENARIO_FACTORIES[id]();
    const deployedUnits = this.deploymentSpawns(id, origin);
    const units = [...baseScenario.units, ...deployedUnits];

    const reservations: GroundSpawnReservation[] = [];
    const safeById = new Map<string, UnitSpawn>();

    // Accepted operator/intel deployments get first reservation priority. A deployment is
    // relocated only if newly available mapped data later proves its original point unsafe;
    // template units are processed second and never displace accepted deployments.
    for (const unit of deployedUnits) {
      if (unit.type === 'jet') {
        safeById.set(unit.id, unit);
        continue;
      }
      const clearanceM = UNIT_OBSTACLE_CLEARANCE_M[unit.type];
      const safePosition = this.findSafeGroundSpawn(unit, origin, reservations);
      if (!safePosition) {
        throw new BattleScenarioStartError(
          `No safe position was found for ${unit.name ?? unit.id}.`
        );
      }
      reservations.push({
        x: safePosition.x,
        z: safePosition.z,
        clearanceM,
      });
      safeById.set(unit.id, Object.freeze({ ...unit, position: Object.freeze(safePosition) }));
    }

    for (const unit of baseScenario.units) {
      if (unit.type === 'jet') {
        safeById.set(unit.id, unit);
        continue;
      }
      const safePosition = this.findSafeGroundSpawn(unit, origin, reservations);
      if (!safePosition) {
        throw new BattleScenarioStartError(
          `No mapped clear position was found for ${unit.name ?? unit.id}.`
        );
      }
      reservations.push({
        x: safePosition.x,
        z: safePosition.z,
        clearanceM: UNIT_OBSTACLE_CLEARANCE_M[unit.type],
      });
      safeById.set(
        unit.id,
        Object.freeze({
          ...unit,
          position: Object.freeze(safePosition),
        })
      );
    }

    const safeUnits = units.map((unit) => safeById.get(unit.id) ?? unit);

    return Object.freeze({
      ...baseScenario,
      units: Object.freeze(safeUnits),
    });
  }

  private prepareScenarioOrDraft(id: BattleScenarioId, origin: Vector3): BattleSnapshot {
    this.rememberSetup(id, origin);
    this.clearVisuals();
    this.root.position.copy(horizontalOrigin(origin));
    this.lastEventSequence = 0;
    this.groundSampleElapsed = GROUND_SAMPLE_INTERVAL_S;
    this.originGroundY = 0;

    if (id === 'none' && !this.hasDeploymentForEachTeam(id)) {
      this.simulation = null;
      return this.renderDeploymentDrafts(id, origin);
    }

    try {
      this.simulation = this.createSimulation(this.buildSafeScenario(id, origin));
      this.preparedSnapshot = null;
      const snapshot = this.simulation.getSnapshot();
      this.syncSnapshot(snapshot, 0);
      return snapshot;
    } catch (error) {
      console.warn('[battle] scenario preparation fell back to deployed-unit preview:', error);
      this.simulation = null;
      return this.renderDeploymentDrafts(id, origin);
    }
  }

  private renderDeploymentDrafts(id: BattleScenarioId, origin: Vector3): BattleSnapshot {
    const scenario = SCENARIO_FACTORIES[id]();
    const units = this.deploymentSpawns(id, origin).map(draftUnitSnapshot);
    const snapshot: BattleSnapshot = Object.freeze({
      scenarioId: scenario.id,
      scenarioName: `${scenario.name} deployment`,
      tick: 0,
      timeSeconds: 0,
      interpolationAlpha: 0,
      status: Object.freeze({
        phase: 'ready' as const,
        reason:
          id === 'none'
            ? 'Add at least one unit to each force before running.'
            : 'Showing accepted deployments while the selected formation is prepared.',
      }),
      teams: Object.freeze(
        scenario.teams.map((team) => {
          const totalUnits = units.filter((unit) => unit.teamId === team.id).length;
          return Object.freeze({ ...team, totalUnits, aliveUnits: totalUnits });
        })
      ),
      units: Object.freeze(units),
      events: Object.freeze([]),
    });
    this.preparedSnapshot = snapshot;
    this.syncSnapshot(snapshot, 0);
    return snapshot;
  }

  private hasDeploymentForEachTeam(id: BattleScenarioId): boolean {
    const deployments = this.deployments.get(id) ?? [];
    return BATTLE_TEAM_IDS.every((teamId) =>
      deployments.some((deployment) => deployment.teamId === teamId)
    );
  }

  private rememberSetup(id: BattleScenarioId, origin: Vector3): void {
    this.activeScenarioId = id;
    this.activeOrigin.copy(horizontalOrigin(origin));
  }

  private deploymentSpawns(id: BattleScenarioId, origin: Vector3): readonly UnitSpawn[] {
    return Object.freeze(
      (this.deployments.get(id) ?? []).map((deployment) => {
        return Object.freeze({
          id: deployment.id,
          name: deployment.name,
          type: deployment.unitType,
          teamId: deployment.teamId,
          position: Object.freeze({
            x: deployment.worldPosition.x - origin.x,
            y: deployment.unitType === 'jet' ? MANUAL_JET_ALTITUDE_M : 0,
            z: deployment.worldPosition.z - origin.z,
          }),
          heading: deployment.heading,
          order: deployment.order,
        });
      })
    );
  }

  private findSafeGroundSpawn(
    unit: UnitSpawn,
    origin: Vector3,
    reservations: readonly GroundSpawnReservation[]
  ): Vec3 | null {
    const clearanceM = UNIT_OBSTACLE_CLEARANCE_M[unit.type];
    if (this.isSafeGroundSpawn(unit.position, origin, clearanceM, reservations)) {
      return { ...unit.position };
    }

    const angleOffset = stableAngleOffset(unit.id);
    for (
      let radiusM = SAFE_SPAWN_SEARCH_STEP_M;
      radiusM <= SAFE_SPAWN_SEARCH_RADIUS_M;
      radiusM += SAFE_SPAWN_SEARCH_STEP_M
    ) {
      for (let angleIndex = 0; angleIndex < SAFE_SPAWN_ANGLES; angleIndex += 1) {
        const angle = angleOffset + (angleIndex / SAFE_SPAWN_ANGLES) * FULL_CIRCLE_RADIANS;
        const candidate = {
          x: unit.position.x + Math.sin(angle) * radiusM,
          y: unit.position.y,
          z: unit.position.z + Math.cos(angle) * radiusM,
        };
        if (this.isSafeGroundSpawn(candidate, origin, clearanceM, reservations)) {
          return candidate;
        }
      }
    }
    return null;
  }

  private isSafeGroundSpawn(
    position: Vec3,
    origin: Vector3,
    clearanceM: number,
    reservations: readonly GroundSpawnReservation[]
  ): boolean {
    const surface = this.terrainSemantics.classifyWorld(
      { x: origin.x + position.x, z: origin.z + position.z },
      clearanceM
    );
    if (!terrainAllowsGround(surface)) return false;
    return reservations.every(
      (reserved) =>
        Math.hypot(position.x - reserved.x, position.z - reserved.z) >=
        clearanceM + reserved.clearanceM
    );
  }

  private pickTerrain(
    clientX: number,
    clientY: number,
    camera: PerspectiveCamera,
    canvas: HTMLCanvasElement
  ): Vector3 | null {
    const rect = canvas.getBoundingClientRect();
    if (
      rect.width <= 0 ||
      rect.height <= 0 ||
      clientX < rect.left ||
      clientX > rect.right ||
      clientY < rect.top ||
      clientY > rect.bottom
    ) {
      return null;
    }
    const ndc = new Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    camera.updateMatrixWorld();
    this.terrain.updateMatrixWorld();
    this.raycaster.setFromCamera(ndc, camera);
    this.raycaster.far = DEPLOYMENT_RAY_MAX_DISTANCE_M;
    const hit = this.raycaster.intersectObject(this.terrain, true)[0];
    return hit?.point.clone() ?? null;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.deployments.clear();
    this.simulation = null;
    this.preparedSnapshot = null;
    this.clearVisuals();
    this.root.removeFromParent();
    disposeObject3D(this.root);
    this.disposed = true;
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('BattleSimulationController has been disposed.');
  }

  private syncSnapshot(snapshot: BattleSnapshot, deltaSeconds: number): void {
    const shouldSampleGround = this.groundSampleElapsed >= GROUND_SAMPLE_INTERVAL_S;
    if (shouldSampleGround) {
      this.groundSampleElapsed = 0;
      this.terrain.updateMatrixWorld();
      const sampledOriginY = this.sampleGround(0, 0);
      if (sampledOriginY !== null) this.originGroundY = sampledOriginY;
    }

    const unitIds = new Set(snapshot.units.map((unit) => unit.id));
    for (const [id, visual] of this.units) {
      if (unitIds.has(id)) continue;
      visual.group.removeFromParent();
      disposeObject3D(visual.group);
      this.units.delete(id);
    }

    for (const unit of snapshot.units) {
      const teamColor = this.getTeamColor(snapshot, unit.teamId);
      const visual = this.units.get(unit.id) ?? this.createUnit(unit, teamColor);
      if (!this.units.has(unit.id)) this.units.set(unit.id, visual);

      const alpha = snapshot.interpolationAlpha;
      const localX = MathUtils.lerp(unit.previousPosition.x, unit.position.x, alpha);
      const localZ = MathUtils.lerp(unit.previousPosition.z, unit.position.z, alpha);
      const localY = MathUtils.lerp(unit.previousPosition.y, unit.position.y, alpha);
      const heading = interpolateAngle(unit.previousHeading, unit.heading, alpha);

      if (unit.type !== 'jet' && shouldSampleGround) {
        const sampledY = this.sampleGround(localX, localZ);
        if (sampledY !== null) {
          visual.groundY = sampledY + GROUND_CLEARANCE_BY_TYPE[unit.type];
        }
      }

      const deployment = this.deploymentForUnit(unit.id);
      const targetY =
        unit.type === 'jet'
          ? deployment
            ? deployment.worldPosition.y - this.root.position.y + MANUAL_JET_ALTITUDE_M
            : this.originGroundY + localY
          : visual.groundY;
      const ease = deltaSeconds === 0 ? 1 : Math.min(1, deltaSeconds * GROUND_EASE_RATE);
      visual.displayedY = MathUtils.lerp(visual.displayedY, targetY, ease);
      visual.group.position.set(localX, visual.displayedY, localZ);
      visual.group.rotation.y = heading;
      this.updateUnitStatus(visual, unit, teamColor);
    }

    this.processEvents(snapshot);
  }

  private createUnit(unit: UnitSnapshot, teamColor: number): RenderUnit {
    const group = new Group();
    group.name = `battle-unit-${unit.id}`;
    const model = this.createModel(unit, teamColor);
    group.add(model);

    const ringMaterial = new MeshBasicMaterial({
      color: teamColor,
      transparent: true,
      opacity: 0.82,
      depthWrite: false,
    });
    const ring = new Mesh(
      new RingGeometry(RING_INNER_RADIUS_M, RING_OUTER_RADIUS_M, RING_SEGMENTS),
      ringMaterial
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = RING_Y_M;
    group.add(ring);

    const healthBackground = new Mesh(
      new BoxGeometry(HEALTH_BAR_WIDTH_M, HEALTH_BAR_HEIGHT_M, HEALTH_BAR_DEPTH_M),
      new MeshBasicMaterial({ color: HEALTH_BACKGROUND_COLOR, depthTest: false })
    );
    healthBackground.position.y = HEALTH_BAR_Y_BY_TYPE[unit.type];
    healthBackground.renderOrder = 970;
    group.add(healthBackground);

    const healthMaterial = new MeshBasicMaterial({ color: HEALTH_GOOD_COLOR, depthTest: false });
    const healthFill = new Mesh(
      new BoxGeometry(HEALTH_BAR_WIDTH_M, HEALTH_BAR_HEIGHT_M * 1.3, HEALTH_BAR_DEPTH_M * 1.08),
      healthMaterial
    );
    healthFill.position.y = HEALTH_BAR_Y_BY_TYPE[unit.type] + HEALTH_BAR_HEIGHT_M;
    healthFill.renderOrder = 971;
    group.add(healthFill);

    group.traverse((object) => object.layers.set(OVERLAY_LAYER));
    this.root.add(group);
    const deployment = this.deploymentForUnit(unit.id);
    const initialY =
      deployment === undefined
        ? unit.position.y
        : deployment.unitType === 'jet'
          ? deployment.worldPosition.y - this.root.position.y + MANUAL_JET_ALTITUDE_M
          : deployment.worldPosition.y - this.root.position.y;
    return {
      group,
      model,
      ringMaterial,
      healthFill,
      healthMaterial,
      groundY: initialY,
      displayedY: initialY,
    };
  }

  private deploymentForUnit(unitId: string): BattleDeployment | undefined {
    for (const deployments of this.deployments.values()) {
      const deployment = deployments.find((candidate) => candidate.id === unitId);
      if (deployment) return deployment;
    }
    return undefined;
  }

  private createModel(unit: UnitSnapshot, teamColor: number): Group {
    if (unit.type === 'tank') {
      return this.modelLibrary.instance('tank', buildTankPrimitive, teamColor);
    }
    if (unit.type === 'car') {
      return this.modelLibrary.instance('car', buildCarPrimitive, teamColor);
    }
    if (unit.type === 'jet') {
      return this.modelLibrary.instance('jet', buildJetPrimitive, teamColor);
    }
    return buildInfantryPrimitive();
  }

  private updateUnitStatus(visual: RenderUnit, unit: UnitSnapshot, teamColor: number): void {
    const healthFraction = MathUtils.clamp(unit.health / unit.maxHealth, 0, 1);
    visual.healthFill.scale.x = Math.max(healthFraction, Number.EPSILON);
    visual.healthFill.position.x = ((healthFraction - 1) * HEALTH_BAR_WIDTH_M) / 2;
    visual.healthMaterial.color.setHex(
      healthFraction <= HEALTH_DANGER_THRESHOLD ? HEALTH_DANGER_COLOR : HEALTH_GOOD_COLOR
    );
    visual.ringMaterial.color.setHex(unit.alive ? teamColor : DEAD_RING_COLOR);
    visual.ringMaterial.opacity = unit.alive ? 0.82 : 0.34;
    visual.model.visible = unit.alive;
  }

  private getTeamColor(snapshot: BattleSnapshot, teamId: string): number {
    const cssColor = snapshot.teams.find((team) => team.id === teamId)?.color;
    if (!cssColor) return DEFAULT_TEAM_COLOR;
    try {
      return new Color(cssColor).getHex();
    } catch {
      return DEFAULT_TEAM_COLOR;
    }
  }

  private sampleGround(localX: number, localZ: number): number | null {
    const worldX = this.root.position.x + localX;
    const worldZ = this.root.position.z + localZ;
    const rayOrigin = new Vector3(worldX, this.root.position.y + GROUND_SAMPLE_HEIGHT_M, worldZ);
    this.raycaster.set(rayOrigin, DOWN);
    this.raycaster.far = GROUND_RAY_LENGTH_M;
    const hit = this.raycaster.intersectObject(this.terrain, true)[0];
    return hit ? hit.point.y - this.root.position.y : null;
  }

  private processEvents(snapshot: BattleSnapshot): void {
    const freshEvents = snapshot.events.filter((event) => event.sequence > this.lastEventSequence);
    for (const event of freshEvents) {
      this.lastEventSequence = Math.max(this.lastEventSequence, event.sequence);
      if (event.type !== 'weapon-fired' || !event.actorId || !event.targetId) continue;
      const actor = this.units.get(event.actorId);
      const target = this.units.get(event.targetId);
      if (!actor || !target) continue;

      const start = actor.group.position.clone();
      const end = target.group.position.clone();
      start.y += TRACER_START_HEIGHT_M;
      end.y += TRACER_END_HEIGHT_M;
      const material = new LineBasicMaterial({
        color: TRACER_COLOR,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
      });
      const tracer = new Line(new BufferGeometry().setFromPoints([start, end]), material);
      tracer.layers.set(OVERLAY_LAYER);
      tracer.renderOrder = 965;
      this.root.add(tracer);
      this.tracers.push({ object: tracer, material, remainingSeconds: TRACER_LIFETIME_S });
    }
  }

  private updateTracers(deltaSeconds: number): void {
    for (let index = this.tracers.length - 1; index >= 0; index -= 1) {
      const tracer = this.tracers[index];
      tracer.remainingSeconds -= deltaSeconds;
      tracer.material.opacity = Math.max(0, tracer.remainingSeconds / TRACER_LIFETIME_S);
      if (tracer.remainingSeconds > 0) continue;
      tracer.object.removeFromParent();
      disposeObject3D(tracer.object);
      this.tracers.splice(index, 1);
    }
  }

  private clearVisuals(): void {
    this.units.clear();
    this.tracers.length = 0;
    disposeObjectChildren(this.root);
  }
}

function buildInfantryPrimitive(): Group {
  const group = new Group();
  const uniform = new MeshStandardMaterial({ color: INFANTRY_BODY_COLOR, roughness: 0.9 });
  const equipment = new MeshStandardMaterial({
    color: INFANTRY_EQUIPMENT_COLOR,
    roughness: 0.95,
  });
  const torso = new Mesh(new CylinderGeometry(0.34, 0.42, 1.15, 8), uniform);
  torso.position.y = 1.05;
  const head = new Mesh(new SphereGeometry(0.28, 10, 8), uniform);
  head.position.y = 1.85;
  const pack = new Mesh(new BoxGeometry(0.58, 0.7, 0.24), equipment);
  pack.position.set(0, 1.2, -0.32);
  const weapon = new Mesh(new BoxGeometry(0.12, 0.12, 1.05), equipment);
  weapon.position.set(0.42, 1.25, 0.32);
  weapon.rotation.x = -0.18;
  group.add(torso, head, pack, weapon);
  return group;
}

function interpolateAngle(from: number, to: number, alpha: number): number {
  const delta = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  return from + delta * alpha;
}

function placementReasonForSurface(surface: TerrainSurfaceClass): BattlePlacementFailureReason {
  if (surface === 'building') return 'building';
  if (surface === 'water') return 'water';
  return 'outside-coverage';
}

function terrainAllowsGround(surface: TerrainSurfaceClass): boolean {
  return surface !== 'building' && surface !== 'water';
}

function horizontalOrigin(origin: Vector3): Vector3 {
  return new Vector3(origin.x, 0, origin.z);
}

function draftUnitSnapshot(spawn: UnitSpawn): UnitSnapshot {
  const profile = UNIT_PROFILES[spawn.type];
  const position = Object.freeze({ ...spawn.position });
  const heading = spawn.heading ?? 0;
  return Object.freeze({
    id: spawn.id,
    name: spawn.name ?? spawn.id,
    type: spawn.type,
    teamId: spawn.teamId,
    position,
    previousPosition: position,
    heading,
    previousHeading: heading,
    velocity: Object.freeze({ x: 0, y: 0, z: 0 }),
    speed: 0,
    health: profile.maxHealth,
    maxHealth: profile.maxHealth,
    alive: true,
    order: spawn.order ?? Object.freeze({ kind: 'hold' as const }),
    cooldownRemaining: 0,
  });
}

function isFiniteVec3(position: Vec3): boolean {
  return Number.isFinite(position.x) && Number.isFinite(position.y) && Number.isFinite(position.z);
}

function overlapsGroundDeployment(
  deployments: readonly BattleDeployment[],
  worldPosition: Vec3,
  unitType: UnitType
): boolean {
  const clearanceM = UNIT_OBSTACLE_CLEARANCE_M[unitType];
  return deployments.some((deployment) => {
    if (deployment.unitType === 'jet') return false;
    return (
      Math.hypot(
        worldPosition.x - deployment.worldPosition.x,
        worldPosition.z - deployment.worldPosition.z
      ) <
      clearanceM + UNIT_OBSTACLE_CLEARANCE_M[deployment.unitType]
    );
  });
}

function safeUnitIdentifier(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-');
  return normalized.slice(0, 80) || 'contact';
}

function shortDetectionId(value: string): string {
  return safeUnitIdentifier(value).slice(0, 8).toUpperCase();
}

function intelImportMessage(
  accepted: number,
  held: number,
  duplicates: number,
  limited: number
): string {
  const parts = [`${accepted} intel contact${accepted === 1 ? '' : 's'} linked to battle`];
  if (held > 0) parts.push(`${held} held`);
  if (duplicates > 0) parts.push(`${duplicates} already linked`);
  if (limited > 0) parts.push(`${limited} using limited terrain coverage`);
  return `${parts.join(' · ')}.`;
}

function placementMessageForSurface(surface: TerrainSurfaceClass): string {
  if (surface === 'building') {
    return 'Ground units cannot deploy on or too close to a mapped building.';
  }
  if (surface === 'water') {
    return 'Ground units cannot deploy in or too close to mapped water.';
  }
  return 'That point is outside the loaded semantic coverage; ground deployment is held.';
}

function teamName(teamId: BattleTeamId): string {
  return teamId === 'blue' ? 'Blue' : 'Red';
}

function unitTypeName(unitType: UnitType): string {
  return unitType.charAt(0).toUpperCase() + unitType.slice(1);
}

function stableAngleOffset(id: string): number {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * STABLE_HASH_MULTIPLIER + id.charCodeAt(index)) >>> 0;
  }
  return ((hash % SAFE_SPAWN_ANGLES) / SAFE_SPAWN_ANGLES) * FULL_CIRCLE_RADIANS;
}
