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
  buildArcGroup,
  buildAxisGroup,
  buildDistanceGroup,
  buildFocusGroup,
  buildLinearMeasureGroup,
  buildLosGroup,
  buildObjectiveGroup,
  fmtArea,
  fmtDist,
  type LinearMeasureType,
  marker,
  MAT_MEASURE,
  pathLength,
  type PlanFeature,
  type PlanFeatureType,
  rebuildFeature,
  serializeFeature,
  shoelaceXZ,
} from './planFeature';
import { type Affiliation, buildUnitSymbolGroup, type Echelon, ECHELON_ABBR } from './unitSymbol';
import type { ViewshedController } from './viewshed';
import { restoreViewpointPose, type Viewpoint } from './viewpoint';

export type StratTool =
  | 'select'
  | 'distance'
  | 'focus'
  | 'arc'
  | 'los'
  | 'viewshed'
  | 'boundary'
  | 'phaseline'
  | 'loa'
  | 'axis'
  | 'objective'
  | 'symbol';

const LINEAR_MEASURE_TOOLS: LinearMeasureType[] = ['boundary', 'phaseline', 'loa'];
const LINEAR_MEASURE_NAME_PREFIX: Record<LinearMeasureType, string> = {
  boundary: 'BDRY',
  phaseline: 'PL',
  loa: 'LOA',
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
  boundary: 'BOUNDARY — click waypoints, right-click to finish',
  phaseline: 'PHASE LINE — click waypoints, right-click to finish',
  loa: 'LIMIT OF ADVANCE — click waypoints, right-click to finish',
  axis: 'AXIS OF ADVANCE — click waypoints, right-click to finish (arrow points last→first)',
  objective: 'OBJECTIVE — click to place',
  symbol: 'UNIT SYMBOL — click to place (set affiliation/echelon in the panel first)',
};

/** A row in the strategist feature list (todo 12) — the panel's read-only view of a feature. */
export interface FeatureSummary {
  id: string;
  name: string;
  type: PlanFeatureType;
  /** MGRS grid ref of the feature's first point — only for single-point types
   * (objective, unit); undefined for multi-point measures/control measures (todo 15). */
  mgrs?: string;
}

const POINT_FEATURE_TYPES: PlanFeatureType[] = ['objective', 'unit'];

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
  /** Affiliation/echelon applied to the NEXT placed `symbol` — set via the strategist
   * UI's selector, not per-placement (todo 14). */
  public unitAffiliation: Affiliation = 'friendly';
  public unitEchelon: Echelon = 'platoon';
  /** Toggles the MGRS cursor readout in the strategist HUD (todo 15). */
  public mgrsHudEnabled = true;
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
  private viewpoints: Viewpoint[] = [];
  private featureRoot = new Group();
  private previewRoot = new Group();
  private selectionRoot = new Group();
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
      if (this.enabled && e.key === 'Escape') this.cancelDraft();
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
  }

  public clearAll(): void {
    this.cancelDraft();
    for (const f of this.features) this.featureRoot.remove(f.group);
    this.features = [];
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
      return { id: f.id, name: f.planFeature.name, type: f.planFeature.type, mgrs };
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
    this.dragButton = e.button;
    this.dragged = false;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    const hit = this.pick(e);
    this.panAnchorY = hit ? hit.y : this.pivot.y;
  };

  private onMove = (e: PointerEvent): void => {
    if (!this.enabled) return;

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
    e.preventDefault();
    this.raycaster.setFromCamera(this.ndc(e), this.camera);
    const speed = Math.max(this.camera.position.y - this.pivot.y, 60) * 0.0012;
    this.camera.position.addScaledVector(this.raycaster.ray.direction, -e.deltaY * speed);
    if (this.camera.position.y < this.pivot.y + 25) this.camera.position.y = this.pivot.y + 25;
  };

  // ---------- drafting ----------

  private place(p: Vector3): void {
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
      case 'axis':
        this.onStatus(`${this.draft.length} pts — right-click to finish (arrow at last point)`);
        break;
      case 'objective':
        this.finalizeObjective();
        break;
      case 'symbol':
        this.finalizeSymbol();
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

    if (this.tool === 'viewshed') {
      // live aim — the whole mesh repaints as you sweep
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

  private finalizeDistance(): void {
    const pts = [...this.draft];
    const total = pathLength(pts);
    const g = buildDistanceGroup(pts, this.geoFrame);
    const name = `Distance ${this.countOfType('distance') + 1}`;
    const pf = serializeFeature('distance', pts, name, this.geoFrame);
    this.addFeature(pf, g);
    this.onStatus(`Distance: ${fmtDist(total)}`);
  }

  private finalizeFocus(): void {
    const pts = [...this.draft];
    const name =
      window.prompt('Name this focus area:', `AO-${this.countOfType('focus') + 1}`) ?? 'AO';
    const g = buildFocusGroup(pts, name);
    const areaM2 = shoelaceXZ(pts);
    const pf = serializeFeature('focus', pts, name, this.geoFrame);
    this.addFeature(pf, g);
    this.onStatus(`${name}: ${fmtArea(areaM2)}`);
  }

  private finalizeArc(): void {
    const pts = [...this.draft];
    const [center, radiusPt] = pts;
    const r = Math.hypot(radiusPt.x - center.x, radiusPt.z - center.z);
    const g = buildArcGroup(pts);
    const name = `Fire Arc ${this.countOfType('arc') + 1}`;
    const pf = serializeFeature('arc', pts, name, this.geoFrame);
    this.addFeature(pf, g);
    this.onStatus(`Fire arc: radius ${fmtDist(r)}`);
  }

  private finalizeLos(): void {
    const [obs, tgt] = this.draft;
    const result = buildLosGroup(obs, tgt, true, this.raycaster, this.tiles, this.geoFrame);
    const name = `LOS ${this.countOfType('los') + 1}`;
    const pf = serializeFeature('los', [obs, tgt], name, this.geoFrame);
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
    const pf = serializeFeature(type, pts, name, this.geoFrame);
    this.addFeature(pf, g);
    this.onStatus(`${name}: ${pts.length} pts, ${fmtDist(pathLength(pts))}`);
  }

  private finalizeAxis(): void {
    const pts = [...this.draft];
    const name =
      window.prompt('Name this axis of advance:', `AXIS-${this.countOfType('axis') + 1}`) ?? 'AXIS';
    const g = buildAxisGroup(pts, name, this.geoFrame);
    const pf = serializeFeature('axis', pts, name, this.geoFrame);
    this.addFeature(pf, g);
    this.onStatus(`AXIS ${name}: ${fmtDist(pathLength(pts))}`);
  }

  private finalizeObjective(): void {
    const pts = [...this.draft];
    const name =
      window.prompt('Name this objective:', `OBJ-${this.countOfType('objective') + 1}`) ?? 'OBJ';
    const g = buildObjectiveGroup(pts, name);
    const pf = serializeFeature('objective', pts, name, this.geoFrame);
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
    const pf = serializeFeature('unit', pts, name, this.geoFrame, { affiliation, echelon });
    this.addFeature(pf, g);
    this.onStatus(`Unit placed: ${name}`);
  }
}
