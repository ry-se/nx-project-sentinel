import {
  BufferGeometry,
  Group,
  Line,
  type Object3D,
  PerspectiveCamera,
  Plane,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
} from 'three';

import type { CameraPose } from './createSandbox';
import type { GeoFrame } from './geoFrame';
import { toMgrs } from './mgrs';
import {
  ALL_PHASES,
  buildArcGroup,
  buildAxisGroup,
  buildDistanceGroup,
  buildFocusGroup,
  buildLinearMeasureGroup,
  buildLosGroup,
  buildObjectiveGroup,
  buildRangeFanGroup,
  fmtArea,
  fmtDist,
  isFeatureVisibleForPhase,
  type LinearMeasureType,
  marker,
  MAT_MEASURE,
  pathLength,
  type PlanFeature,
  type PlanFeatureType,
  readRangeFanSystemId,
  rebuildFeature,
  resolveFeaturePhase,
  serializeFeature,
  shoelaceXZ,
  toLocalPoint,
} from './planFeature';
import type { PlanPhase } from './planStore';
import {
  type Affiliation,
  buildUnitSymbolGroup,
  type Echelon,
  ECHELON_ABBR,
  repositionUnitSymbolGroup,
} from './unitSymbol';
import { type SystemId, WEAPON_SYSTEMS } from './weaponSystems';
import type { ViewshedController } from './viewshed';
import { BriefPlaybackStepper } from './briefPlayback';
import {
  buildRouteExposureGroup,
  type ElevationSample,
  estimateMoveTimeMinutes,
  exposureFraction,
  type MoveRate,
  sampleElevationProfile,
  sampleRouteExposure,
} from './elevationProfile';
import { GroundWalkController, type MoveDirection } from './groundWalk';
import { resolveRehearsalStep } from './rehearsal';
import { type PhasePositions, TimelineStepper, unitPositionAt } from './timeline';
import { restoreViewpointPose, type Viewpoint } from './viewpoint';
import {
  type ClassificationLevel,
  DEFAULT_CLASSIFICATION,
  type Provenance,
} from './classification';

export type StratTool =
  | 'select'
  | 'distance'
  | 'focus'
  | 'arc'
  | 'los'
  | 'viewshed'
  | 'counterViewshed'
  | 'boundary'
  | 'phaseline'
  | 'loa'
  | 'axis'
  | 'objective'
  | 'symbol'
  | 'rangeFan'
  | 'groundWalk';

/** Max distance (metres) a `counterViewshed` click may be from a placed unit to pick it
 * as the observer (todo 30) — generous enough for an imprecise click, tight enough that a
 * click nowhere near any unit visibly does nothing rather than silently picking the wrong
 * one. */
const COUNTER_VIEWSHED_PICK_RADIUS_M = 40;

/** Finds the nearest `unit`-type feature to `point` within `maxDistM`, or `null` if none
 * qualifies (todo 30) — pure function of the exported feature list, independently
 * testable without a live controller/raycaster. Any affiliation is selectable (enemy is
 * the doctrinal counter-viewshed use case, but a friendly self-check is also legitimate). */
export function findNearestUnit(
  features: PlanFeature[],
  point: Vector3,
  maxDistM: number
): PlanFeature | null {
  let nearest: PlanFeature | null = null;
  let nearestDist = Infinity;
  for (const pf of features) {
    if (pf.type !== 'unit') continue;
    const p = pf.points.local[0];
    if (!p) continue;
    const dist = point.distanceTo(new Vector3(p.x, p.y, p.z));
    if (dist <= maxDistM && dist < nearestDist) {
      nearest = pf;
      nearestDist = dist;
    }
  }
  return nearest;
}

const LINEAR_MEASURE_TOOLS: LinearMeasureType[] = ['boundary', 'phaseline', 'loa'];
const LINEAR_MEASURE_NAME_PREFIX: Record<LinearMeasureType, string> = {
  boundary: 'BDRY',
  phaseline: 'PL',
  loa: 'LOA',
};

/** Radians of look rotation per pixel of mouse-drag while ground-walking. */
const GROUND_WALK_LOOK_SENSITIVITY = 0.0025;

const GROUND_WALK_KEY_MAP: Record<string, MoveDirection | undefined> = {
  w: 'forward',
  ArrowUp: 'forward',
  s: 'back',
  ArrowDown: 'back',
  a: 'left',
  ArrowLeft: 'left',
  d: 'right',
  ArrowRight: 'right',
};

function isLinearMeasureTool(tool: StratTool): tool is LinearMeasureType {
  return (LINEAR_MEASURE_TOOLS as StratTool[]).includes(tool);
}

export const TOOL_HINTS: Record<StratTool, string> = {
  select: 'SELECT — drag to pan, right-drag to orbit, scroll to zoom',
  distance: 'DISTANCE — click waypoints, right-click to finish',
  focus: 'FOCUS AREA — click 3+ corners, right-click to close',
  arc: 'FIRE ARC — click ① weapon ② max-range point ③ end bearing',
  los: 'LINE OF SIGHT — click observer, then target. Buildings block the ray.',
  viewshed: 'VIEWSHED — click observer, aim with mouse (green = seen, red = hidden), click to lock',
  counterViewshed:
    'COUNTER-VIEWSHED — click a PLACED UNIT to use as the observer, aim with mouse, click to lock',
  boundary: 'BOUNDARY — click waypoints, right-click to finish',
  phaseline: 'PHASE LINE — click waypoints, right-click to finish',
  loa: 'LIMIT OF ADVANCE — click waypoints, right-click to finish',
  axis: 'AXIS OF ADVANCE — click waypoints, right-click to finish (arrow points last→first)',
  objective: 'OBJECTIVE — click to place',
  symbol: 'UNIT SYMBOL — click to place (set affiliation/echelon in the panel first)',
  rangeFan: 'RANGE FAN — click ① gun position ② bearing (set the system in the panel first)',
  groundWalk:
    'GROUND WALK — click to drop to eye height. Drag: look. WASD/arrows: move. Escape: exit.',
};

/** A row in the strategist feature list (todo 12) — the panel's read-only view of a feature. */
export interface FeatureSummary {
  id: string;
  name: string;
  type: PlanFeatureType;
  /** MGRS grid ref of the feature's first point — only for single-point types
   * (objective, unit); undefined for multi-point measures/control measures (todo 15). */
  mgrs?: string;
  /** Author + timestamps captured at draw time (todo 22 invariant 3). */
  provenance?: Provenance;
}

const POINT_FEATURE_TYPES: PlanFeatureType[] = ['objective', 'unit'];

/** Feature types with a genuine multi-point path (todo 29 — the ones M1/M4/M2 can
 * analyze). `focus`/`arc`/`los`/linear-measures are excluded: they're areas, arcs, or a
 * single observer-target pair, not a route a unit would traverse. */
const PATH_FEATURE_TYPES: PlanFeatureType[] = ['distance', 'axis'];

interface Feature {
  id: string;
  planFeature: PlanFeature;
  group: Group;
}

export class StrategistController {
  public enabled = false;
  public tool: StratTool = 'select';
  public onStatus: (text: string) => void = () => {
    /* Custom Hook */
  };
  public onFeaturesChanged: () => void = () => {
    /* Custom Hook */
  };
  /** Fires on every `setTool` — including an internal tool change like ground-walk's
   * Escape-triggered exit — so a host UI's tool-highlight state stays in sync even when
   * the tool changed WITHOUT a direct `setTool` call from that UI. */
  public onToolChanged: (tool: StratTool) => void = () => {
    /* Custom Hook */
  };
  /** Affiliation/echelon applied to the NEXT placed `symbol` — set via the strategist
   * UI's selector, not per-placement (todo 14). */
  public unitAffiliation: Affiliation = 'friendly';
  public unitEchelon: Echelon = 'platoon';
  /** System applied to the NEXT placed `rangeFan` — set via the strategist UI's system
   * selector, not per-placement (todo 32, mirrors `unitAffiliation`/`unitEchelon`). */
  public rangeFanSystemId: SystemId = 'mortar81mm';
  /** Toggles the MGRS cursor readout in the strategist HUD (todo 15). */
  public mgrsHudEnabled = true;
  /** Author name stamped into each feature's provenance at draw time — a simple settable
   * name, not an auth system (todo 22). */
  public operatorName = 'Operator';
  /** The current plan's classification — defaults to EXERCISE (invariant 2), never blank. */
  public currentClassification: ClassificationLevel = DEFAULT_CLASSIFICATION;
  public onViewpointsChanged: () => void = () => {
    /* Custom Hook */
  };

  private camera: PerspectiveCamera;
  private canvas: HTMLCanvasElement;
  private tiles: Object3D;
  private geoFrame: GeoFrame;
  private raycaster = new Raycaster();
  private draft: Vector3[] = [];
  private hover: Vector3 | null = null;
  private cursorGround: Vector3 | null = null;
  private features: Feature[] = [];
  private phases: PlanPhase[] = [];
  private phaseFilter: string = ALL_PHASES;
  private viewpoints: Viewpoint[] = [];
  private briefStepper = new BriefPlaybackStepper(() => this.listViewpoints());
  private timelineStepper = new TimelineStepper(() => this.phases.length);
  private rehearsing = false;
  private pendingPhasePosition: { featureId: string; phaseId: string } | null = null;
  private counterViewshedUnitName: string | null = null;
  private groundWalkController = new GroundWalkController();
  private lastUpdateMs: number | null = null;
  private featureRoot = new Group();
  private previewRoot = new Group();
  private selectionRoot = new Group();
  /** Transient Wave-4 analysis overlays (route exposure) — a SEPARATE lifecycle from
   * `previewRoot` (which the draft/tool-switch flow clears constantly): an exposure
   * overlay should persist while the user inspects it, not vanish on the next tool
   * interaction. Cleared explicitly or by `clearAll()`. */
  private analysisRoot = new Group();
  private selectedId: string | null = null;
  private pivot = new Vector3();

  private dragButton = -1;
  private dragged = false;
  private lastX = 0;
  private lastY = 0;
  private panAnchorY = 0;
  private lastPreviewAt = 0;

  private viewshed: ViewshedController;

  constructor(
    camera: PerspectiveCamera,
    canvas: HTMLCanvasElement,
    tiles: Object3D,
    scene: Scene,
    viewshed: ViewshedController,
    geoFrame: GeoFrame
  ) {
    this.camera = camera;
    this.canvas = canvas;
    this.tiles = tiles;
    this.viewshed = viewshed;
    this.geoFrame = geoFrame;
    scene.add(this.featureRoot);
    scene.add(this.previewRoot);
    scene.add(this.selectionRoot);
    scene.add(this.analysisRoot);
    this.featureRoot.renderOrder = 999;
    (this.raycaster as unknown as { firstHitOnly: boolean }).firstHitOnly = true;

    canvas.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => {
      if (this.enabled) e.preventDefault();
    });
    window.addEventListener('keydown', (e) => {
      if (!this.enabled) return;
      if (e.key === 'Escape') {
        if (this.groundWalkController.isActive) this.exitGroundWalk();
        else this.cancelDraft();
        return;
      }
      const direction = GROUND_WALK_KEY_MAP[e.key];
      if (direction && this.groundWalkController.isActive)
        this.groundWalkController.setMoving(direction, true);
    });
    window.addEventListener('keyup', (e) => {
      if (!this.enabled) return;
      const direction = GROUND_WALK_KEY_MAP[e.key];
      if (direction) this.groundWalkController.setMoving(direction, false);
    });
  }

  public enable(center: Vector3): void {
    this.enabled = true;
    this.pivot.copy(center);
    this.camera.position.set(center.x + 100, center.y + 500, center.z + 380);
    this.camera.lookAt(this.pivot);
    this.setTool('select');
  }

  public disable(): void {
    this.enabled = false;
    this.cancelDraft();
  }

  public setTool(tool: StratTool): void {
    this.cancelDraft();
    this.tool = tool;
    this.onStatus(TOOL_HINTS[tool]);
    this.onToolChanged(tool);
  }

  public clearAll(): void {
    this.cancelDraft();
    for (const f of this.features) this.featureRoot.remove(f.group);
    this.features = [];
    this.phases = [];
    this.phaseFilter = ALL_PHASES;
    this.timelineStepper.cancel();
    this.analysisRoot.clear();
    this.clearSelection();
    this.viewshed.disable();
    this.onStatus('All features cleared');
    this.onFeaturesChanged();
  }

  /** The full `PlanFeature` set (todo 18: persistence saves this, not the live 3D groups). */
  public exportFeatures(): PlanFeature[] {
    return this.features.map((f) => f.planFeature);
  }

  /** Replaces the current scene with the given `PlanFeature`s, rebuilt via the todo-11
   * round-trip seam — zero mock/placeholder data in the load path (invariant 3). */
  public loadPlan(features: PlanFeature[]): void {
    this.clearAll();
    for (const pf of features) {
      const group = rebuildFeature(pf, {
        raycaster: this.raycaster,
        tiles: this.tiles,
        geoFrame: this.geoFrame,
      });
      this.addFeature(pf, group);
    }
  }

  public get featureCount(): number {
    return this.features.length;
  }

  // ---------- feature list (todo 12: list/edit/delete/undo/select) ----------

  public listFeatures(): FeatureSummary[] {
    return this.features.map((f) => {
      const geo = f.planFeature.points.geo[0];
      const mgrs =
        POINT_FEATURE_TYPES.includes(f.planFeature.type) && geo ? toMgrs(geo) : undefined;
      const provenance = f.planFeature.metadata.provenance as Provenance | undefined;
      return { id: f.id, name: f.planFeature.name, type: f.planFeature.type, mgrs, provenance };
    });
  }

  /** The strategist HUD's live MGRS readout for wherever the mouse currently points on
   * the terrain — `null` when disabled or the cursor isn't over any tile geometry. */
  public getCursorMgrs(): string | null {
    if (!this.mgrsHudEnabled || !this.cursorGround) return null;
    return toMgrs(this.geoFrame.localToGeo(this.cursorGround));
  }

  // ---------- viewpoint bookmarks + brief sequence (todo 19) ----------

  /** Saves the given pose (captured by the caller — `createSandbox.ts`'s `getCameraPose()`,
   * the existing lossless serialization, invariant 1) as a new, last-in-sequence viewpoint. */
  public saveViewpoint(name: string, pose: CameraPose): Viewpoint {
    const vp: Viewpoint = { id: crypto.randomUUID(), name, order: this.viewpoints.length, pose };
    this.viewpoints.push(vp);
    this.onViewpointsChanged();
    return vp;
  }

  /** Ordered by `order`, not insertion order (composes with todo 20's playback stepping). */
  public listViewpoints(): Viewpoint[] {
    return [...this.viewpoints].sort((a, b) => a.order - b.order);
  }

  public renameViewpoint(id: string, name: string): void {
    const vp = this.viewpoints.find((v) => v.id === id);
    if (!vp) return;
    vp.name = name;
    this.onViewpointsChanged();
  }

  /** Sets which phase this viewpoint narrates (todo 27) — `phaseId` of `ALL_PHASES` or
   * `undefined` clears it (the rehearsal step then leaves the timeline untouched). */
  public setViewpointPhase(id: string, phaseId: string | undefined): void {
    const vp = this.viewpoints.find((v) => v.id === id);
    if (!vp) return;
    vp.phaseId = phaseId && phaseId !== ALL_PHASES ? phaseId : undefined;
    this.onViewpointsChanged();
  }

  public deleteViewpoint(id: string): void {
    this.viewpoints = this.viewpoints.filter((v) => v.id !== id);
    this.onViewpointsChanged();
  }

  /** Reassigns `order` 0..n-1 to match `orderedIds` — deterministic, stable across
   * save/load (invariant 4). */
  public reorderViewpoints(orderedIds: string[]): void {
    orderedIds.forEach((id, index) => {
      const vp = this.viewpoints.find((v) => v.id === id);
      if (vp) vp.order = index;
    });
    this.onViewpointsChanged();
  }

  /** Jumps the camera to a saved viewpoint — sets position AND orientation (invariant 3). */
  public restoreViewpoint(id: string): void {
    const vp = this.viewpoints.find((v) => v.id === id);
    if (vp) restoreViewpointPose(this.camera, vp.pose);
  }

  /** The full viewpoint set (todo 17/18: persisted inside the `Plan`, invariant 2). */
  public exportViewpoints(): Viewpoint[] {
    return [...this.viewpoints];
  }

  public loadViewpoints(viewpoints: Viewpoint[]): void {
    this.viewpoints = [...viewpoints];
    this.onViewpointsChanged();
  }

  // ---------- brief playback (todo 20) ----------

  private currentLocalPose(): {
    position: [number, number, number];
    quaternion: [number, number, number, number];
  } {
    return {
      position: this.camera.position.toArray() as [number, number, number],
      quaternion: this.camera.quaternion.toArray() as [number, number, number, number],
    };
  }

  public playBriefNext(nowMs: number): void {
    this.briefStepper.next(this.currentLocalPose(), nowMs);
  }

  public playBriefPrevious(nowMs: number): void {
    this.briefStepper.previous(this.currentLocalPose(), nowMs);
  }

  public playBriefGoTo(index: number, nowMs: number): void {
    this.briefStepper.goTo(index, this.currentLocalPose(), nowMs);
  }

  public cancelBriefPlayback(): void {
    this.briefStepper.cancel();
  }

  public get briefPlaybackState(): { currentIndex: number; isPlaying: boolean } {
    return { currentIndex: this.briefStepper.currentIndex, isPlaying: this.briefStepper.isPlaying };
  }

  // ---------- guided rehearsal (todo 27) ----------

  /** Steps to a specific viewpoint, driving the camera (todo 20) and — when that
   * viewpoint declares a phase — the timeline (todo 26) together from the SAME step
   * index (invariant 1: they cannot desync, since `resolveRehearsalStep` derives the
   * phase index FROM the viewpoint index rather than tracking a second counter). A
   * viewpoint with no declared phase leaves the timeline exactly where it was. */
  public rehearseGoTo(index: number, nowMs: number): void {
    const viewpoints = this.listViewpoints();
    if (index < 0 || index >= viewpoints.length) return;
    this.playBriefGoTo(index, nowMs);
    const step = resolveRehearsalStep(viewpoints, this.listPhases(), index);
    if (step?.phaseIndex !== null && step?.phaseIndex !== undefined) {
      this.timelineStepper.goTo(step.phaseIndex, nowMs);
      const phaseId = this.listPhases()[step.phaseIndex]?.id;
      if (phaseId) this.setPhaseFilter(phaseId);
    }
  }

  public rehearseNext(nowMs: number): void {
    this.rehearseGoTo(this.briefPlaybackState.currentIndex + 1, nowMs);
  }

  public rehearsePrevious(nowMs: number): void {
    this.rehearseGoTo(this.briefPlaybackState.currentIndex - 1, nowMs);
  }

  /** Starts a full guided rehearsal from the first viewpoint — `update()` auto-advances
   * to each subsequent step once the current one's transition completes (invariant 2:
   * deterministic + interruptible via `cancelRehearsal`). */
  public startRehearsal(nowMs: number): void {
    if (this.listViewpoints().length === 0) return;
    this.rehearsing = true;
    this.rehearseGoTo(0, nowMs);
  }

  public pauseRehearsal(): void {
    this.rehearsing = false;
  }

  public cancelRehearsal(): void {
    this.rehearsing = false;
    this.cancelBriefPlayback();
    this.cancelTimelinePlayback();
  }

  public get isRehearsing(): boolean {
    return this.rehearsing;
  }

  /** Called every frame from the render loop (`createSandbox.ts`) — applies the current
   * interpolated pose to the camera when a brief transition is in progress. */
  public update(nowMs: number): void {
    const dtSeconds = this.lastUpdateMs === null ? 0 : (nowMs - this.lastUpdateMs) / 1000;
    this.lastUpdateMs = nowMs;

    const pose = this.briefStepper.tick(nowMs);
    if (pose) {
      this.camera.position.fromArray(pose.position);
      this.camera.quaternion.fromArray(pose.quaternion);
      this.camera.updateMatrixWorld();
    }

    if (this.rehearsing && !this.briefStepper.isPlaying) {
      const nextIndex = this.briefPlaybackState.currentIndex + 1;
      if (nextIndex < this.listViewpoints().length) this.rehearseGoTo(nextIndex, nowMs);
      else this.rehearsing = false;
    }

    if (this.groundWalkController.isActive) {
      this.groundWalkController.update(this.camera, this.raycaster, this.tiles, dtSeconds);
    }

    const phaseBlend = this.timelineStepper.tick(nowMs);
    if (phaseBlend) {
      const orderedPhases = this.listPhases();
      const fromId = orderedPhases[phaseBlend.fromIndex]?.id;
      const toId = orderedPhases[phaseBlend.toIndex]?.id;
      if (fromId !== undefined && toId !== undefined) {
        this.applyUnitInterpolation(fromId, toId, phaseBlend.t);
      }
    }
  }

  // ---------- phase tagging (todo 25) ----------

  public listPhases(): PlanPhase[] {
    return [...this.phases].sort((a, b) => a.order - b.order);
  }

  public addPhase(name: string): PlanPhase {
    const phase: PlanPhase = { id: crypto.randomUUID(), name, order: this.phases.length };
    this.phases.push(phase);
    this.onFeaturesChanged();
    return phase;
  }

  public renamePhase(id: string, name: string): void {
    const phase = this.phases.find((p) => p.id === id);
    if (!phase) return;
    phase.name = name;
    this.onFeaturesChanged();
  }

  /** Reassigns `order` 0..n-1 to match `orderedIds` (mirrors `reorderViewpoints`). */
  public reorderPhases(orderedIds: string[]): void {
    orderedIds.forEach((id, index) => {
      const phase = this.phases.find((p) => p.id === id);
      if (phase) phase.order = index;
    });
    this.onFeaturesChanged();
  }

  /** Deleting a phase clears every feature tagged to it back to `ALL_PHASES` (invariant 1
   * — no dangling references) rather than leaving an orphaned id or silently hiding the
   * feature. */
  public deletePhase(id: string): void {
    this.phases = this.phases.filter((p) => p.id !== id);
    for (const f of this.features) {
      if (f.planFeature.metadata.phase === id) {
        f.planFeature = {
          ...f.planFeature,
          metadata: { ...f.planFeature.metadata, phase: ALL_PHASES },
        };
      }
    }
    if (this.phaseFilter === id) this.phaseFilter = ALL_PHASES;
    // A shrunk phase list can leave the timeline stepper's index past the new end —
    // `scrubTo` itself only validates on call, so a stale index left untouched here would
    // silently point past the array forever.
    if (this.timelineStepper.currentIndex >= this.phases.length) {
      this.timelineStepper.cancel();
      if (this.phases.length > 0) this.timelineStepper.scrubTo(this.phases.length - 1);
    }
    this.applyPhaseVisibility();
    this.onFeaturesChanged();
  }

  /** The phase id a feature is tagged to, validated against the CURRENT phase list
   * (invariant 1) — never a dangling reference, even if the feature's raw metadata is
   * stale. */
  public getFeaturePhase(id: string): string {
    const f = this.features.find((f) => f.id === id);
    if (!f) return ALL_PHASES;
    return resolveFeaturePhase(f.planFeature.metadata, new Set(this.phases.map((p) => p.id)));
  }

  public setFeaturePhase(id: string, phaseId: string): void {
    const f = this.features.find((f) => f.id === id);
    if (!f) return;
    f.planFeature = { ...f.planFeature, metadata: { ...f.planFeature.metadata, phase: phaseId } };
    this.applyPhaseVisibility();
    this.onFeaturesChanged();
  }

  public get phaseFilterId(): string {
    return this.phaseFilter;
  }

  /** Shows only the given phase's (+ all-phase) features by toggling `Group.visible`
   * (invariant 2 — show/hide only, features aren't destroyed by phasing). Pass
   * `ALL_PHASES` to show everything. */
  public setPhaseFilter(phaseId: string): void {
    this.phaseFilter = phaseId;
    this.applyPhaseVisibility();
    this.onFeaturesChanged();
  }

  private applyPhaseVisibility(): void {
    const validIds = new Set(this.phases.map((p) => p.id));
    for (const f of this.features) {
      const featurePhase = resolveFeaturePhase(f.planFeature.metadata, validIds);
      f.group.visible = isFeatureVisibleForPhase(featurePhase, this.phaseFilter);
    }
  }

  /** The full phase list (todo 17/23: persisted inside the `Plan`, invariant 4). */
  public exportPhases(): PlanPhase[] {
    return [...this.phases];
  }

  public loadPhases(phases: PlanPhase[]): void {
    this.phases = [...phases];
    this.phaseFilter = ALL_PHASES;
    this.applyPhaseVisibility();
    this.applyUnitPositionsForPhase(this.currentTimelinePhaseId());
    this.onFeaturesChanged();
  }

  // ---------- timeline (todo 26) ----------

  private currentTimelinePhaseId(): string {
    return this.listPhases()[this.timelineStepper.currentIndex]?.id ?? ALL_PHASES;
  }

  private getUnitPhasePositions(f: Feature): PhasePositions {
    return (f.planFeature.metadata.phasePositions as PhasePositions | undefined) ?? {};
  }

  /** Records `point` as the unit's position for `phaseId` (todo 26 invariant 4: persists
   * with the feature's own metadata bag, same round-trip as every other tag). Only
   * meaningful for `unit` features — a no-op on any other type. */
  public setUnitPhasePosition(featureId: string, phaseId: string, point: Vector3): void {
    const f = this.features.find((f) => f.id === featureId);
    if (f?.planFeature.type !== 'unit') return;
    const positions = { ...this.getUnitPhasePositions(f), [phaseId]: toLocalPoint(point) };
    f.planFeature = {
      ...f.planFeature,
      metadata: { ...f.planFeature.metadata, phasePositions: positions },
    };
    if (phaseId === this.currentTimelinePhaseId()) repositionUnitSymbolGroup(f.group, point);
    this.onFeaturesChanged();
  }

  /** Arms a one-shot "click the map to set this unit's position for this phase" capture
   * — the NEXT plain left-click sets it (see `onUp`). Does not change `this.tool`, so it
   * composes with whatever drafting tool is currently selected. */
  public armSetUnitPhasePosition(featureId: string, phaseId: string): void {
    this.pendingPhasePosition = { featureId, phaseId };
    this.onStatus('Click the map to set this unit position for the selected phase');
  }

  public get isArmedForPhasePosition(): boolean {
    return this.pendingPhasePosition !== null;
  }

  public cancelSetUnitPhasePosition(): void {
    this.pendingPhasePosition = null;
  }

  /** Snaps every unit to its recorded position for `phaseId` (instant — used on scrub and
   * on load, never during an animated transition). A unit with no recorded position for
   * this phase is left wherever it currently sits (invariant 2 — never jumps to origin). */
  private applyUnitPositionsForPhase(phaseId: string): void {
    for (const f of this.features) {
      if (f.planFeature.type !== 'unit') continue;
      const point = this.getUnitPhasePositions(f)[phaseId];
      if (!point) continue;
      repositionUnitSymbolGroup(f.group, new Vector3(point.x, point.y, point.z));
    }
  }

  /** Smoothly blends every unit between two phases' positions (invariant 1 — called only
   * from `update()` while the stepper is animating a transition). */
  private applyUnitInterpolation(fromPhaseId: string, toPhaseId: string, t: number): void {
    for (const f of this.features) {
      if (f.planFeature.type !== 'unit') continue;
      const point = unitPositionAt(this.getUnitPhasePositions(f), fromPhaseId, toPhaseId, t);
      if (!point) continue;
      repositionUnitSymbolGroup(f.group, new Vector3(point.x, point.y, point.z));
    }
  }

  /** Instant jump (dragging the scrubber slider) — visibility (todo 25) and unit
   * positions both snap to the target phase together (invariant 3: one phase state
   * drives both). */
  public scrubToPhaseIndex(index: number): void {
    if (!this.timelineStepper.scrubTo(index)) return;
    const phaseId = this.currentTimelinePhaseId();
    this.setPhaseFilter(phaseId);
    this.applyUnitPositionsForPhase(phaseId);
  }

  /** Animated step (stepper buttons) — visibility snaps to the TARGET phase immediately
   * (matches the user-flow's "Phase-1 clutter hides" the moment you advance), while unit
   * positions interpolate smoothly frame-by-frame via `update()`. */
  public stepTimelineNext(nowMs: number): void {
    if (!this.timelineStepper.next(nowMs)) return;
    this.setPhaseFilter(this.currentTimelinePhaseId());
  }

  public stepTimelinePrevious(nowMs: number): void {
    if (!this.timelineStepper.previous(nowMs)) return;
    this.setPhaseFilter(this.currentTimelinePhaseId());
  }

  public cancelTimelinePlayback(): void {
    this.timelineStepper.cancel();
  }

  public get timelineState(): { currentIndex: number; isPlaying: boolean } {
    return {
      currentIndex: this.timelineStepper.currentIndex,
      isPlaying: this.timelineStepper.isPlaying,
    };
  }

  // ---------- terrain-reasoning depth (Wave 4) ----------

  private pathPoints(featureId: string): Vector3[] | null {
    const f = this.features.find((f) => f.id === featureId);
    if (!f || !PATH_FEATURE_TYPES.includes(f.planFeature.type)) return null;
    return f.planFeature.points.local.map((p) => new Vector3(p.x, p.y, p.z));
  }

  public isPathFeature(featureId: string): boolean {
    return this.pathPoints(featureId) !== null;
  }

  /** The system a placed range fan is tagged to (todo 32) — `null` for a non-`rangeFan`
   * feature. Validated against the CURRENT table, same defensive pattern as
   * `getFeaturePhase`. */
  public getRangeFanSystemId(featureId: string): SystemId | null {
    const f = this.features.find((f) => f.id === featureId);
    if (f?.planFeature.type !== 'rangeFan') return null;
    return readRangeFanSystemId(f.planFeature.metadata);
  }

  /** M1 — elevation profile + slope along a selected path (todo 29). `null` when the
   * feature isn't a path type. */
  public computeElevationProfile(featureId: string, spacingM?: number): ElevationSample[] | null {
    const points = this.pathPoints(featureId);
    if (!points) return null;
    return sampleElevationProfile(points, this.raycaster, this.tiles, spacingM);
  }

  /** M4 — measured-move timing along a selected path (todo 29). `null` when the feature
   * isn't a path type. */
  public computeMoveTimeMinutes(featureId: string, rate: MoveRate): number | null {
    const points = this.pathPoints(featureId);
    if (!points) return null;
    return estimateMoveTimeMinutes(pathLength(points), rate);
  }

  /** M2 — route exposure (todo 31): samples `featureId`'s path against `threatFeatureId`'s
   * position (a placed `unit`), renders the colour-coded overlay into `analysisRoot`, and
   * returns the Gate-5 summary (exposed fraction + sample count). `null` when either
   * feature doesn't qualify (path / unit respectively). */
  public runRouteExposure(
    featureId: string,
    threatFeatureId: string
  ): { fraction: number; sampleCount: number } | null {
    const points = this.pathPoints(featureId);
    if (!points) return null;
    const threat = this.features.find((f) => f.id === threatFeatureId);
    if (threat?.planFeature.type !== 'unit') return null;
    const threatPoint = threat.planFeature.points.local[0];
    const threatEye = new Vector3(threatPoint.x, threatPoint.y, threatPoint.z);

    const samples = sampleRouteExposure(points, threatEye, this.raycaster, this.tiles);
    this.analysisRoot.clear();
    const overlay = buildRouteExposureGroup(samples);
    overlay.traverse((o) => o.layers.set(1));
    this.analysisRoot.add(overlay);
    return { fraction: exposureFraction(samples), sampleCount: samples.length };
  }

  public clearRouteExposureOverlay(): void {
    this.analysisRoot.clear();
  }

  public removeFeature(id: string): void {
    const idx = this.features.findIndex((f) => f.id === id);
    if (idx === -1) return;
    const [removed] = this.features.splice(idx, 1);
    this.featureRoot.remove(removed.group);
    if (this.selectedId === id) this.clearSelection();
    this.onFeaturesChanged();
  }

  public renameFeature(id: string, name: string): void {
    const f = this.features.find((f) => f.id === id);
    if (!f) return;
    f.planFeature = { ...f.planFeature, name };
    this.onFeaturesChanged();
  }

  /** Removes the most-recently-added feature (LIFO) — a global undo of the last placement. */
  public undoLast(): void {
    const last = this.features.pop();
    if (!last) return;
    this.featureRoot.remove(last.group);
    if (this.selectedId === last.id) this.clearSelection();
    this.onFeaturesChanged();
  }

  public get selectedFeatureId(): string | null {
    return this.selectedId;
  }

  /** Highlights a feature in-scene (a marker at its first point); pass `null` to clear. */
  public selectFeature(id: string | null): void {
    this.selectedId = id;
    this.selectionRoot.clear();
    if (!id) return;
    const f = this.features.find((f) => f.id === id);
    const firstLocal = f?.planFeature.points.local[0];
    if (!firstLocal) return;
    const ring = marker(new Vector3(firstLocal.x, firstLocal.y, firstLocal.z), 0xffff00, 3.5);
    ring.renderOrder = 1002;
    this.selectionRoot.add(ring);
    this.selectionRoot.traverse((o) => o.layers.set(1));
  }

  private clearSelection(): void {
    this.selectedId = null;
    this.selectionRoot.clear();
  }

  // ---------- picking ----------

  private ndc(e: PointerEvent | WheelEvent): Vector2 {
    const rect = this.canvas.getBoundingClientRect();
    return new Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
  }

  private pick(e: PointerEvent): Vector3 | null {
    this.raycaster.setFromCamera(this.ndc(e), this.camera);
    this.raycaster.far = Infinity;
    const hits = this.raycaster.intersectObject(this.tiles, true);
    return hits.length > 0 ? hits[0].point.clone() : null;
  }

  // ---------- camera controls ----------

  private onDown = (e: PointerEvent): void => {
    if (!this.enabled) return;
    this.cancelBriefPlayback(); // manual input cancels playback cleanly (invariant 3)
    this.dragButton = e.button;
    this.dragged = false;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    const hit = this.pick(e);
    this.panAnchorY = hit ? hit.y : this.pivot.y;
  };

  private onMove = (e: PointerEvent): void => {
    if (!this.enabled) return;

    if (this.groundWalkController.isActive) {
      if (this.dragButton === 0) {
        const dx = e.clientX - this.lastX;
        const dy = e.clientY - this.lastY;
        if (Math.abs(dx) + Math.abs(dy) > 3) this.dragged = true;
        this.groundWalkController.look(
          dx * GROUND_WALK_LOOK_SENSITIVITY,
          dy * GROUND_WALK_LOOK_SENSITIVITY
        );
        this.lastX = e.clientX;
        this.lastY = e.clientY;
      }
      return;
    }

    if (this.dragButton === 0 || this.dragButton === 2) {
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      if (Math.abs(dx) + Math.abs(dy) > 3) this.dragged = true;

      if (this.dragged) {
        if (this.dragButton === 0) this.pan(e);
        else this.orbit(dx, dy);
      }
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      return;
    }

    // throttled — raycasts against the tileset. Always tracks the MGRS cursor readout
    // (todo 15); only feeds the draft preview when a draft is actually in progress.
    if (performance.now() - this.lastPreviewAt > 33) {
      this.lastPreviewAt = performance.now();
      const hit = this.pick(e);
      this.cursorGround = hit;
      if (this.draft.length > 0) {
        this.hover = hit;
        this.updatePreview();
      }
    }
  };

  private onUp = (e: PointerEvent): void => {
    if (!this.enabled) return;
    const wasDragged = this.dragged;
    const button = this.dragButton;
    this.dragButton = -1;
    this.dragged = false;
    if (wasDragged) return;

    // A one-shot phase-position capture (todo 26) takes priority over the current tool —
    // arming it doesn't change `this.tool`, so this click would otherwise fall through to
    // whatever the active tool's own place() does.
    if (button === 0 && this.pendingPhasePosition) {
      const p = this.pick(e);
      if (p) {
        const { featureId, phaseId } = this.pendingPhasePosition;
        this.setUnitPhasePosition(featureId, phaseId, p);
      }
      this.pendingPhasePosition = null;
      this.onStatus(TOOL_HINTS[this.tool]);
      return;
    }

    if (button === 0 && this.tool !== 'select') {
      const p = this.pick(e);
      if (p) this.place(p);
    } else if (button === 2) {
      this.finishPolyline();
    }
  };

  private pan(e: PointerEvent): void {
    const plane = new Plane(new Vector3(0, 1, 0), -this.panAnchorY);
    const prev = new Vector3();
    const curr = new Vector3();
    const rect = this.canvas.getBoundingClientRect();

    const rayAt = (cx: number, cy: number, out: Vector3): boolean => {
      const ndc = new Vector2(
        ((cx - rect.left) / rect.width) * 2 - 1,
        -((cy - rect.top) / rect.height) * 2 + 1
      );
      this.raycaster.setFromCamera(ndc, this.camera);
      return this.raycaster.ray.intersectPlane(plane, out) !== null;
    };

    if (rayAt(this.lastX, this.lastY, prev) && rayAt(e.clientX, e.clientY, curr)) {
      const delta = prev.sub(curr);
      this.camera.position.add(delta);
      this.pivot.add(delta);
    }
  }

  private orbit(dx: number, dy: number): void {
    const offset = this.camera.position.clone().sub(this.pivot);
    const radius = offset.length();
    let theta = Math.atan2(offset.x, offset.z);
    let phi = Math.acos(Math.max(-1, Math.min(1, offset.y / radius)));
    theta -= dx * 0.005;
    phi = Math.max(0.15, Math.min(1.45, phi + dy * 0.005));
    offset.set(
      radius * Math.sin(phi) * Math.sin(theta),
      radius * Math.cos(phi),
      radius * Math.sin(phi) * Math.cos(theta)
    );
    this.camera.position.copy(this.pivot).add(offset);
    this.camera.lookAt(this.pivot);
  }

  private onWheel = (e: WheelEvent): void => {
    if (!this.enabled) return;
    this.cancelBriefPlayback(); // manual input cancels playback cleanly (invariant 3)
    e.preventDefault();
    this.raycaster.setFromCamera(this.ndc(e), this.camera);
    const speed = Math.max(this.camera.position.y - this.pivot.y, 60) * 0.0012;
    this.camera.position.addScaledVector(this.raycaster.ray.direction, -e.deltaY * speed);
    if (this.camera.position.y < this.pivot.y + 25) this.camera.position.y = this.pivot.y + 25;
  };

  // ---------- drafting ----------

  private place(rawPoint: Vector3): void {
    let p = rawPoint;
    if (this.tool === 'counterViewshed' && this.draft.length === 0) {
      const observer = findNearestUnit(
        this.exportFeatures(),
        rawPoint,
        COUNTER_VIEWSHED_PICK_RADIUS_M
      );
      if (!observer) {
        this.onStatus('COUNTER-VIEWSHED — click closer to a placed unit');
        return;
      }
      this.counterViewshedUnitName = observer.name;
      const unitPoint = observer.points.local[0];
      p = new Vector3(unitPoint.x, unitPoint.y, unitPoint.z);
    }
    this.draft.push(p);

    switch (this.tool) {
      case 'distance':
        this.onStatus(
          `${this.draft.length} pts — ${fmtDist(pathLength(this.draft))} — right-click to finish`
        );
        break;
      case 'focus':
        this.onStatus(`${this.draft.length} corners — right-click to close`);
        break;
      case 'arc':
        if (this.draft.length === 3) this.finalizeArc();
        else this.onStatus(`FIRE ARC — point ${this.draft.length + 1} of 3`);
        break;
      case 'los':
        if (this.draft.length === 2) this.finalizeLos();
        else this.onStatus('LOS — now click the target');
        break;
      case 'viewshed':
        if (this.draft.length === 2) {
          this.viewshed.aim(this.draft[0], this.draft[1]);
          this.onStatus('VIEWSHED locked — green = visible, red = hidden. Clear All to remove.');
          this.draft = [];
          this.previewRoot.clear();
        } else {
          this.onStatus('VIEWSHED — sweep the mouse to aim, click to lock');
        }
        break;
      case 'counterViewshed':
        if (this.draft.length === 2) {
          this.viewshed.aim(this.draft[0], this.draft[1]);
          this.onStatus(
            `COUNTER-VIEWSHED from ${this.counterViewshedUnitName} locked — green = seen by them, red = hidden from them. Clear All to remove.`
          );
          this.draft = [];
          this.previewRoot.clear();
        } else {
          this.onStatus(
            `COUNTER-VIEWSHED from ${this.counterViewshedUnitName} — sweep the mouse to aim, click to lock`
          );
        }
        break;
      case 'axis':
        this.onStatus(`${this.draft.length} pts — right-click to finish (arrow at last point)`);
        break;
      case 'objective':
        this.finalizeObjective();
        break;
      case 'symbol':
        this.finalizeSymbol();
        break;
      case 'rangeFan':
        if (this.draft.length === 2) this.finalizeRangeFan();
        else this.onStatus('RANGE FAN — now click the bearing point');
        break;
      case 'groundWalk':
        this.enterGroundWalkAt(this.draft[this.draft.length - 1]);
        break;
      default:
        if (isLinearMeasureTool(this.tool)) {
          this.onStatus(`${this.draft.length} pts — right-click to finish`);
        }
        break;
    }
    this.updatePreview();
  }

  private finishPolyline(): void {
    if (this.tool === 'distance' && this.draft.length >= 2) this.finalizeDistance();
    else if (this.tool === 'focus' && this.draft.length >= 3) this.finalizeFocus();
    else if (isLinearMeasureTool(this.tool) && this.draft.length >= 2) {
      this.finalizeLinearMeasure(this.tool);
    } else if (this.tool === 'axis' && this.draft.length >= 2) this.finalizeAxis();
    else this.cancelDraft();
  }

  private cancelDraft(): void {
    this.draft = [];
    this.hover = null;
    this.previewRoot.clear();
    this.pendingPhasePosition = null;
    this.counterViewshedUnitName = null;
    this.onStatus(TOOL_HINTS[this.tool]);
  }

  private updatePreview(): void {
    this.previewRoot.clear();
    if (this.draft.length === 0) return;

    const pts = this.hover ? [...this.draft, this.hover] : [...this.draft];

    if (this.tool === 'los') {
      // live LOS sweep from the observer to wherever the mouse is
      if (this.draft.length === 1 && this.hover) {
        this.previewRoot.add(
          buildLosGroup(this.draft[0], this.hover, false, this.raycaster, this.tiles, this.geoFrame)
            .group
        );
        this.previewRoot.traverse((o) => o.layers.set(1));
      }
      return;
    }

    if (this.tool === 'viewshed' || this.tool === 'counterViewshed') {
      // live aim — the whole mesh repaints as you sweep (counterViewshed's observer was
      // already snapped to the picked unit's position back in `place()`).
      if (this.draft.length === 1 && this.hover) {
        this.viewshed.aim(this.draft[0], this.hover);
      }
      this.previewRoot.add(marker(this.draft[0], 0xffaa33));
      this.previewRoot.traverse((o) => o.layers.set(1));
      return;
    }

    if (pts.length >= 2) {
      const line = new Line(new BufferGeometry().setFromPoints(pts), MAT_MEASURE);
      line.renderOrder = 999;
      this.previewRoot.add(line);
    }
    for (const p of this.draft) this.previewRoot.add(marker(p, 0x35d4ff));
    this.previewRoot.traverse((o) => o.layers.set(1));
  }

  // ---------- finalizers ----------

  private addFeature(planFeature: PlanFeature, group: Group): void {
    group.renderOrder = 999;
    group.traverse((o) => o.layers.set(1)); // overlays stay out of the viewshed depth pass
    this.featureRoot.add(group);
    this.features.push({ id: planFeature.id, planFeature, group });
    this.draft = [];
    this.hover = null;
    this.previewRoot.clear();
    this.onFeaturesChanged();
  }

  private countOfType(type: PlanFeatureType): number {
    return this.features.filter((f) => f.planFeature.type === type).length;
  }

  /** Stamps provenance at draw time (invariant 3) — captured once, immutable afterward
   * (rename/etc. do not re-stamp `updatedAt`; that's the `Plan`-level concern `planStore.ts`
   * already owns). */
  private provenanceMetadata(): { provenance: Provenance } {
    const now = new Date().toISOString();
    return { provenance: { author: this.operatorName, createdAt: now, updatedAt: now } };
  }

  private finalizeDistance(): void {
    const pts = [...this.draft];
    const total = pathLength(pts);
    const g = buildDistanceGroup(pts, this.geoFrame);
    const name = `Distance ${this.countOfType('distance') + 1}`;
    const pf = serializeFeature('distance', pts, name, this.geoFrame, this.provenanceMetadata());
    this.addFeature(pf, g);
    this.onStatus(`Distance: ${fmtDist(total)}`);
  }

  private finalizeFocus(): void {
    const pts = [...this.draft];
    const name =
      window.prompt('Name this focus area:', `AO-${this.countOfType('focus') + 1}`) ?? 'AO';
    const g = buildFocusGroup(pts, name);
    const areaM2 = shoelaceXZ(pts);
    const pf = serializeFeature('focus', pts, name, this.geoFrame, this.provenanceMetadata());
    this.addFeature(pf, g);
    this.onStatus(`${name}: ${fmtArea(areaM2)}`);
  }

  private finalizeArc(): void {
    const pts = [...this.draft];
    const [center, radiusPt] = pts;
    const r = Math.hypot(radiusPt.x - center.x, radiusPt.z - center.z);
    const g = buildArcGroup(pts);
    const name = `Fire Arc ${this.countOfType('arc') + 1}`;
    const pf = serializeFeature('arc', pts, name, this.geoFrame, this.provenanceMetadata());
    this.addFeature(pf, g);
    this.onStatus(`Fire arc: radius ${fmtDist(r)}`);
  }

  private finalizeLos(): void {
    const [obs, tgt] = this.draft;
    const result = buildLosGroup(obs, tgt, true, this.raycaster, this.tiles, this.geoFrame);
    const name = `LOS ${this.countOfType('los') + 1}`;
    const pf = serializeFeature('los', [obs, tgt], name, this.geoFrame, this.provenanceMetadata());
    this.addFeature(pf, result.group);
    this.onStatus(
      result.blocked
        ? `LOS BLOCKED at ${fmtDist(result.blockedAtM ?? result.distanceM)} of ${fmtDist(result.distanceM)}`
        : `LOS CLEAR — ${fmtDist(result.distanceM)}`
    );
  }

  private finalizeLinearMeasure(type: LinearMeasureType): void {
    const pts = [...this.draft];
    const prefix = LINEAR_MEASURE_NAME_PREFIX[type];
    const name =
      window.prompt(`Name this ${prefix}:`, `${prefix}-${this.countOfType(type) + 1}`) ?? prefix;
    const g = buildLinearMeasureGroup(pts, type, name);
    const pf = serializeFeature(type, pts, name, this.geoFrame, this.provenanceMetadata());
    this.addFeature(pf, g);
    this.onStatus(`${name}: ${pts.length} pts, ${fmtDist(pathLength(pts))}`);
  }

  private finalizeAxis(): void {
    const pts = [...this.draft];
    const name =
      window.prompt('Name this axis of advance:', `AXIS-${this.countOfType('axis') + 1}`) ?? 'AXIS';
    const g = buildAxisGroup(pts, name, this.geoFrame);
    const pf = serializeFeature('axis', pts, name, this.geoFrame, this.provenanceMetadata());
    this.addFeature(pf, g);
    this.onStatus(`AXIS ${name}: ${fmtDist(pathLength(pts))}`);
  }

  private finalizeObjective(): void {
    const pts = [...this.draft];
    const name =
      window.prompt('Name this objective:', `OBJ-${this.countOfType('objective') + 1}`) ?? 'OBJ';
    const g = buildObjectiveGroup(pts, name);
    const pf = serializeFeature('objective', pts, name, this.geoFrame, this.provenanceMetadata());
    this.addFeature(pf, g);
    this.onStatus(`Objective: ${name}`);
  }

  private finalizeSymbol(): void {
    const pts = [...this.draft];
    const affiliation = this.unitAffiliation;
    const echelon = this.unitEchelon;
    const name =
      window.prompt(
        'Unit designator:',
        `${this.countOfType('unit') + 1} ${ECHELON_ABBR[echelon]}`
      ) ?? ECHELON_ABBR[echelon];
    const g = buildUnitSymbolGroup(pts[0], affiliation, echelon, name);
    const pf = serializeFeature('unit', pts, name, this.geoFrame, {
      affiliation,
      echelon,
      ...this.provenanceMetadata(),
    });
    this.addFeature(pf, g);
    this.onStatus(`Unit placed: ${name}`);
  }

  private finalizeRangeFan(): void {
    const pts = [...this.draft];
    const systemId = this.rangeFanSystemId;
    const system = WEAPON_SYSTEMS[systemId];
    const name =
      window.prompt('Name this range fan:', `${system.name} ${this.countOfType('rangeFan') + 1}`) ??
      system.name;
    const g = buildRangeFanGroup(pts, systemId, this.geoFrame);
    const pf = serializeFeature('rangeFan', pts, name, this.geoFrame, {
      systemId,
      ...this.provenanceMetadata(),
    });
    this.addFeature(pf, g);
    this.onStatus(
      `${system.name} placed: ${fmtDist(system.minRangeM)}–${fmtDist(system.maxRangeM)} (geometric range only)`
    );
  }

  // ---------- ground walk (todo 21) ----------

  private enterGroundWalkAt(groundPoint: Vector3): void {
    this.groundWalkController.enter(this.camera, groundPoint, this.raycaster, this.tiles);
    this.draft = [];
    this.hover = null;
    this.previewRoot.clear();
    this.onStatus(TOOL_HINTS.groundWalk);
  }

  /** Restores the pre-walk camera exactly (invariant 2) and returns to `select`. */
  public exitGroundWalk(): void {
    this.groundWalkController.exit(this.camera);
    this.setTool('select');
  }

  public get isGroundWalkActive(): boolean {
    return this.groundWalkController.isActive;
  }
}
