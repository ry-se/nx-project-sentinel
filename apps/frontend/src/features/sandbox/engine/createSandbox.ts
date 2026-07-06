import {
  AmbientLight,
  Clock,
  Color,
  DirectionalLight,
  Fog,
  MathUtils,
  type Object3D,
  PerspectiveCamera,
  Quaternion,
  Raycaster,
  Scene,
  Sphere,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { TilesRenderer } from '3d-tiles-renderer';
import {
  GLTFExtensionsPlugin,
  GoogleCloudAuthPlugin,
  LoadRegionPlugin,
  ReorientationPlugin,
  SphereRegion,
} from '3d-tiles-renderer/plugins';

import type { ElevationSample, MoveRate } from './elevationProfile';
import { type FeatureSummary, StrategistController, type StratTool } from './strategist';
import type { Affiliation, Echelon } from './unitSymbol';
import type { SystemId } from './weaponSystems';
import {
  deletePlan as deletePlanFromStore,
  listPlans as listPlansFromStore,
  loadPlan as loadPlanFromStore,
  type Plan,
  type PlanPhase,
  savePlan as savePlanToStore,
} from './planStore';
import { ViewshedController } from './viewshed';
import type { Viewpoint } from './viewpoint';
import type { ClassificationLevel } from './classification';
import { exportGeoJSON, exportKML } from './exportPlan';
import { LabelManager } from './labels';
import { ProjectileManager } from './projectiles';
import { VehicleManager, type VehicleType } from './vehicles';
import { BombManager } from './bombs';
import { GeoFrame } from './geoFrame';
import { ModelLibrary } from './modelCatalog';
import { type DetectionClass, DetectionLayer, type SentinelDetection } from './detections';

import { SANDBOX_COMMON, SANDBOX_ENGINE } from '@/constants';

export interface SandboxAnchor {
  lat: number;
  lon: number;
}

const DEFAULT_ANCHOR: SandboxAnchor = { lat: 1.2868, lon: 103.8545 };

export type SandboxMode = 'player' | 'strategist';

/** Machine-readable camera pose — copy this when you take a screenshot. */
export interface CameraPose {
  type: 'sentinel-camera-pose';
  version: 1;
  capturedAt: string;
  anchor: { lat: number; lon: number };
  /** Exact pixel size of the captured frame (set by the Capture button). */
  image?: { width: number; height: number };
  camera: {
    fovDeg: number;
    aspect: number;
    /** Lossless sim-frame pose — used for exact reprojection. */
    local: { position: [number, number, number]; quaternion: [number, number, number, number] };
    /** Human-readable / real-world equivalent. */
    geo: { lat: number; lon: number; altM: number; headingDeg: number; pitchDeg: number };
  };
}

/** One annotated (manual or auto-detected) oriented box on the imported image (pixel
 * coords). `confidence`/`headingConfidence` are set by the detector for the auto path;
 * manual boxes leave them undefined and deployFromImage falls back to certain (1.0 /
 * 'high' — human-annotated boxes are exact). */
export interface ImageAnnotation {
  id: string;
  cls: DetectionClass;
  rear: [number, number];
  front: [number, number];
  halfWidthPx: number;
  confidence?: number;
  headingConfidence?: 'high' | 'medium' | 'low';
}

export interface DeployResult {
  detections: SentinelDetection[];
  placed: number;
  failed: number;
}

/** Where a batch of detections being deployed came from — threaded into every resulting
 * `SentinelDetection.method`/`model`/`detected_at` (W4 provenance). Omitted means manual. */
export interface DeployProvenance {
  method: 'manual' | 'auto';
  model?: string;
  detectedAt?: string;
}

export interface SandboxCallbacks {
  onStatus(text: string): void;
  onHud(text: string): void;
  onMode(mode: SandboxMode): void;
  onFeaturesChanged?(): void;
  onToolChanged?(tool: StratTool): void;
  onViewpointsChanged?(): void;
  onVehicle?(type: VehicleType): void;
  onAttributions(text: string): void;
  onTilesLoaded(): void;
  onError(message: string): void;
}

export interface Sandbox {
  setMode(mode: SandboxMode): void;
  setTool(tool: StratTool): void;
  clearAll(): void;
  listFeatures(): FeatureSummary[];
  removeFeature(id: string): void;
  renameFeature(id: string, name: string): void;
  undoLastFeature(): void;
  selectFeature(id: string | null): void;
  setUnitAffiliation(affiliation: Affiliation): void;
  setUnitEchelon(echelon: Echelon): void;
  setRangeFanSystem(systemId: SystemId): void;
  getRangeFanSystemId(featureId: string): SystemId | null;
  setMgrsHudEnabled(enabled: boolean): void;
  savePlan(name: string): Plan;
  loadPlan(id: string): void;
  listPlans(): Plan[];
  deletePlan(id: string): void;
  saveViewpoint(name: string): Viewpoint;
  listViewpoints(): Viewpoint[];
  renameViewpoint(id: string, name: string): void;
  setViewpointPhase(id: string, phaseId: string | undefined): void;
  deleteViewpoint(id: string): void;
  reorderViewpoints(orderedIds: string[]): void;
  restoreViewpoint(id: string): void;
  playBriefNext(): void;
  playBriefPrevious(): void;
  playBriefGoTo(index: number): void;
  cancelBriefPlayback(): void;
  getBriefPlaybackState(): { currentIndex: number; isPlaying: boolean };
  rehearseGoTo(index: number): void;
  rehearseNext(): void;
  rehearsePrevious(): void;
  startRehearsal(): void;
  pauseRehearsal(): void;
  cancelRehearsal(): void;
  isRehearsing(): boolean;
  exitGroundWalk(): void;
  isGroundWalkActive(): boolean;
  listPhases(): PlanPhase[];
  addPhase(name: string): PlanPhase;
  renamePhase(id: string, name: string): void;
  reorderPhases(orderedIds: string[]): void;
  deletePhase(id: string): void;
  getFeaturePhase(featureId: string): string;
  setFeaturePhase(featureId: string, phaseId: string): void;
  getPhaseFilter(): string;
  setPhaseFilter(phaseId: string): void;
  scrubToPhaseIndex(index: number): void;
  stepTimelineNext(): void;
  stepTimelinePrevious(): void;
  cancelTimelinePlayback(): void;
  getTimelineState(): { currentIndex: number; isPlaying: boolean };
  armSetUnitPhasePosition(featureId: string, phaseId: string): void;
  cancelSetUnitPhasePosition(): void;
  isArmedForPhasePosition(): boolean;
  isPathFeature(featureId: string): boolean;
  getElevationProfile(featureId: string): ElevationSample[] | null;
  getMoveTimeMinutes(featureId: string, rate: MoveRate): number | null;
  runRouteExposure(
    featureId: string,
    threatFeatureId: string
  ): { fraction: number; sampleCount: number } | null;
  clearRouteExposureOverlay(): void;
  setClassification(level: ClassificationLevel): void;
  getClassification(): ClassificationLevel;
  setOperatorName(name: string): void;
  /** Serializes the LIVE feature set (not necessarily saved yet) to GeoJSON/KML — reads
   * straight from `strategist.exportFeatures()`, same source `savePlan` reads (todo 23/24
   * invariant 2: brief playback, ground-walk, classification, and export all operate on
   * the one live controller, never a parallel copy). */
  exportPlanGeoJSON(name: string): string;
  exportPlanKML(name: string): string;
  switchVehicle(type: VehicleType): void;
  setLabelsVisible(visible: boolean): void;
  getCameraPose(): CameraPose;
  /** Downloads a clean tiles-only PNG of the current view + its pose sidecar JSON. */
  captureShot(): void;
  deployFromImage(
    pose: CameraPose,
    annotations: ImageAnnotation[],
    image: { width: number; height: number; name: string },
    provenance?: DeployProvenance
  ): DeployResult;
  clearDetections(): void;
  dispose(): void;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), SANDBOX_ENGINE.BLOB_URL_REVOKE_MS);
}

/** Wrap an angle delta into [-π, π] so the camera eases the short way round. */
function wrapAngle(a: number): number {
  a %= Math.PI * 2;
  if (a > Math.PI) a -= Math.PI * 2;
  if (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function isTyping(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

/** Max distance (local-frame units, ~metres) a deployFromImage raycast may travel before
 * being treated as a miss. Matches this codebase's own convention for "relevant" raycast
 * range (vehicleBase.ts uses 1200, labels.ts uses 1500) — every other raycast site in the
 * engine bounds `far`; this was the sole `Infinity` outlier, and an imprecise detector
 * pixel coordinate could send an unbounded ray into unrelated terrain far from the capture
 * point (confirmed root cause of a `lat: 16.83` wild-outlier placement — see
 * workspaces/sentinel/journal/0012). */
export const DEPLOY_RAYCAST_MAX_DISTANCE = SANDBOX_ENGINE.DEPLOY_RAYCAST_MAX_DISTANCE;

/** Casts a single NDC-space ray at `target`, bounded to `DEPLOY_RAYCAST_MAX_DISTANCE`, and
 * returns the first hit point or null. Extracted from deployFromImage so the distance
 * bound is independently testable with real Three.js primitives — no canvas/WebGL needed. */
export function raycastBoundedHit(
  raycaster: Raycaster,
  ndc: Vector2,
  camera: PerspectiveCamera,
  target: Object3D
): Vector3 | null {
  raycaster.setFromCamera(ndc, camera);
  raycaster.far = DEPLOY_RAYCAST_MAX_DISTANCE;
  const hits = raycaster.intersectObject(target, true);
  return hits.length > 0 ? hits[0].point.clone() : null;
}

/** Assumed pixel-localization error (image px) for a detection's box-center point — a
 * documented approximation (no eval harness yet to measure a real error rate; see todo
 * W6), not a measured detector accuracy figure. */
export const ASSUMED_PIXEL_ERROR_PX = SANDBOX_ENGINE.ASSUMED_PIXEL_ERROR_PX;

/** Rough CEP-style ground-placement uncertainty in metres: pixel error converted to
 * ground distance via the ground-sample-distance at `range` (vertical FOV convention,
 * matching this codebase's `PerspectiveCamera(fovDeg, ...)` usage), scaled by an
 * obliquity correction — a grazing ray (rayDirY near 0, near-horizontal) covers far more
 * ground per pixel than a near-nadir one (rayDirY near -1) at the same range, so the
 * same pixel error implies a larger ground uncertainty. `rayDirY` is the normalized
 * camera-to-hit-point ray's Y component; floored at 0.15 so a near-horizontal shot
 * doesn't blow the estimate up unboundedly. */
export function estimateGeoUncertaintyM(
  range: number,
  fovDeg: number,
  imageHeightPx: number,
  rayDirY: number
): number {
  const fovRad = (fovDeg * Math.PI) / SANDBOX_COMMON.DEGREES_HALF_TURN;
  // Floored so a malformed/zero image height can't produce Infinity/NaN in a rendered
  // "±Xm" label — every real caller passes a loaded image's natural height, always > 0,
  // but the estimate stays finite regardless.
  const metersPerPixel = (2 * range * Math.tan(fovRad / 2)) / Math.max(imageHeightPx, 1);
  const obliquity = 1 / Math.max(Math.abs(rayDirY), SANDBOX_ENGINE.UNCERTAINTY_MIN_RAY_DIR_Y);
  return (
    Math.round(
      metersPerPixel * ASSUMED_PIXEL_ERROR_PX * obliquity * SANDBOX_ENGINE.PIXEL_ERROR_ROUNDING_SCALE
    ) / SANDBOX_ENGINE.PIXEL_ERROR_ROUNDING_SCALE
  );
}

/** Everything `deployFromImage` needs from the running sandbox, as explicit dependencies
 * rather than closure variables — extracted (like `raycastBoundedHit` above) so the real
 * monoplotting/deploy logic is independently testable with real Three.js primitives (a
 * plain mesh + a bare `TilesRenderer` + `GeoFrame`), no canvas/WebGL/Google-tiles-network
 * needed. W6's E2E smoke test exercises this function directly, not a stub. */
export interface DeployDeps {
  tilesGroup: Object3D;
  geoFrame: GeoFrame;
  detectionLayer: DetectionLayer;
}

/** Monoplots each annotation: reconstructs the screenshot camera, raycasts pixel
 * coordinates onto `deps.tilesGroup` (bounded — see `raycastBoundedHit`), converts to
 * geo via `deps.geoFrame`, estimates ground uncertainty, spawns the detection into
 * `deps.detectionLayer`, and returns the resulting `SentinelDetection` records. */
export function deployAnnotations(
  deps: DeployDeps,
  pose: CameraPose,
  annotations: ImageAnnotation[],
  image: { width: number; height: number; name: string },
  provenance?: DeployProvenance
): DeployResult {
  const { tilesGroup, geoFrame, detectionLayer } = deps;

  // Reconstruct the camera exactly as it was at screenshot time
  const shotCam = new PerspectiveCamera(
    pose.camera.fovDeg,
    image.width / image.height,
    1,
    SANDBOX_ENGINE.DEFAULT_CAMERA_FAR
  );
  shotCam.position.fromArray(pose.camera.local.position);
  shotCam.quaternion.copy(new Quaternion().fromArray(pose.camera.local.quaternion));
  shotCam.updateMatrixWorld(true);
  shotCam.updateProjectionMatrix();

  const raycaster = new Raycaster();
  (raycaster as unknown as { firstHitOnly: boolean }).firstHitOnly = true;

  const castPixel = (u: number, v: number): Vector3 | null => {
    const ndc = new Vector2(
      (u / image.width) * SANDBOX_ENGINE.NDC_EDGE - 1,
      1 - (v / image.height) * SANDBOX_ENGINE.NDC_EDGE
    );
    return raycastBoundedHit(raycaster, ndc, shotCam, tilesGroup);
  };

  const imageId = crypto.randomUUID();
  const detections: SentinelDetection[] = [];
  let placed = 0;
  let failed = 0;

  for (const ann of annotations) {
    const cx = (ann.rear[0] + ann.front[0]) / 2;
    const cy = (ann.rear[1] + ann.front[1]) / 2;
    const center = castPixel(cx, cy);
    if (!center) {
      failed++;
      continue;
    }
    const frontPt = castPixel(ann.front[0], ann.front[1]);
    const rearPt = castPixel(ann.rear[0], ann.rear[1]);

    let headingVec = new Vector3(0, 0, 1);
    if (frontPt && rearPt) {
      headingVec = frontPt.clone().sub(rearPt);
      headingVec.y = 0;
      if (headingVec.lengthSq() < SANDBOX_ENGINE.HEADING_EPSILON) headingVec.set(0, 0, 1);
      headingVec.normalize();
    }

    const geo = geoFrame.localToGeo(center);
    const axisLen = Math.hypot(ann.front[0] - ann.rear[0], ann.front[1] - ann.rear[1]);
    const confidence = ann.confidence ?? 1.0; // detector's value for auto path; 1.0 for manual
    const range = center.distanceTo(shotCam.position);
    const rayDirY = center.clone().sub(shotCam.position).normalize().y;
    const uncertaintyM = estimateGeoUncertaintyM(range, pose.camera.fovDeg, image.height, rayDirY);

    detectionLayer.spawn(
      center,
      Math.atan2(headingVec.x, headingVec.z),
      ann.cls,
      `${ann.cls === 'armored_fighting_vehicle' ? 'AFV' : ann.cls === 'light_military_vehicle' ? 'LMV' : 'AIR'}-${placed + 1}`,
      { confidence, uncertaintyM }
    );

    detections.push({
      detection_id: crypto.randomUUID(),
      image_id: imageId,
      class: ann.cls,
      confidence,
      bbox_pixel: {
        x: Math.round(cx),
        y: Math.round(cy),
        w: Math.round(axisLen),
        h: Math.round(ann.halfWidthPx * 2),
        theta: Math.atan2(ann.front[1] - ann.rear[1], ann.front[0] - ann.rear[0]),
      },
      lat: geo.lat,
      lon: geo.lon,
      world_heading: geoFrame.compassHeadingDeg(headingVec),
      heading_confidence: ann.headingConfidence ?? 'high', // detector's value for auto path; manual boxes are exact
      timestamp: pose.capturedAt,
      source_image_url: image.name,
      method: provenance?.method ?? 'manual',
      model: provenance?.model,
      detected_at: provenance?.detectedAt,
      uncertainty_m: uncertaintyM,
    });
    placed++;
  }

  return { detections, placed, failed };
}

/** Pings the tileset root so Google's verbatim rejection reason can be shown. */
export async function preflightGoogleKey(apiKey: string): Promise<string | null> {
  try {
    const resp = await fetch(`https://tile.googleapis.com/v1/3dtiles/root.json?key=${apiKey}`);
    if (resp.ok) return null;
    try {
      const body = (await resp.json()) as { error?: { message?: string } };
      return body.error?.message ?? `HTTP ${resp.status}`;
    } catch {
      return `HTTP ${resp.status}`;
    }
  } catch {
    return 'Could not reach tile.googleapis.com (network/adblock?)';
  }
}

export function createSandbox(
  canvas: HTMLCanvasElement,
  apiKey: string,
  anchor: SandboxAnchor = DEFAULT_ANCHOR,
  cb: SandboxCallbacks
): Sandbox {
  const renderer = new WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const scene = new Scene();
  scene.background = new Color(SANDBOX_ENGINE.SCENE_BACKGROUND);
  // Fog far must sit INSIDE camera.far (50000). The old 1500/9000 whited-out
  // everything past ~9 km, masking the real render distance — pushed way out.
  scene.fog = new Fog(
    SANDBOX_ENGINE.SCENE_BACKGROUND,
    SANDBOX_ENGINE.FOG_NEAR,
    SANDBOX_ENGINE.FOG_FAR
  );

  const camera = new PerspectiveCamera(
    SANDBOX_ENGINE.CAMERA_FOV_DEG,
    window.innerWidth / window.innerHeight,
    1,
    SANDBOX_ENGINE.DEFAULT_CAMERA_FAR
  );
  camera.position.set(0, SANDBOX_ENGINE.CAMERA_START_Y, SANDBOX_ENGINE.CAMERA_START_Z);
  camera.layers.enable(1); // overlays

  scene.add(
    new AmbientLight(SANDBOX_ENGINE.AMBIENT_LIGHT_COLOR, SANDBOX_ENGINE.AMBIENT_LIGHT_INTENSITY)
  );
  const sun = new DirectionalLight(SANDBOX_ENGINE.SUN_COLOR, SANDBOX_ENGINE.SUN_INTENSITY);
  sun.position.set(
    SANDBOX_ENGINE.SUN_POSITION_X,
    SANDBOX_ENGINE.SUN_POSITION_Y,
    SANDBOX_ENGINE.SUN_POSITION_Z
  );
  scene.add(sun);

  // --- Google Photorealistic 3D Tiles ---
  const tiles = new TilesRenderer();
  tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: apiKey, autoRefreshToken: true }));
  const draco = new DRACOLoader();
  draco.setDecoderPath('https://www.gstatic.com/draco/v1/decoders/');
  draco.setDecoderConfig({ type: 'wasm' }); // WASM decode (faster than JS fallback)
  draco.setWorkerLimit(
    Math.max(
      SANDBOX_ENGINE.DRACO_WORKER_MIN,
      Math.min(
        (navigator.hardwareConcurrency || SANDBOX_ENGINE.DRACO_WORKER_DEFAULT) - 1,
        SANDBOX_ENGINE.DRACO_WORKER_MAX
      )
    )
  );
  draco.preload(); // fetch+compile the decoder now, so the first tiles don't wait on it
  tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: draco }));
  tiles.registerPlugin(
    new ReorientationPlugin({
      lat: anchor.lat * MathUtils.DEG2RAD,
      lon: anchor.lon * MathUtils.DEG2RAD,
      recenter: true,
    })
  );

  // Load high detail in a sphere AROUND the player, not just where the camera
  // points. Tile loading is hard-gated by the camera frustum (verified in the
  // renderer source: markUsedTiles bails on !inFrustum) — so tiles behind/beside
  // you never download. LoadRegionPlugin ORs a geometric region into the view
  // test, forcing omnidirectional refinement in `playerRegion`'s radius.
  // SphereRegion's center is in tiles.group LOCAL space (bounding volumes are),
  // so we convert vehicles.position (world) each frame in the render loop.
  const loadRegion = new LoadRegionPlugin();
  tiles.registerPlugin(loadRegion);
  const playerRegion = new SphereRegion({
    sphere: new Sphere(new Vector3(), SANDBOX_ENGINE.PLAYER_LOAD_RADIUS_M), // 1.2 km radius around the player
    errorTarget: SANDBOX_ENGINE.PLAYER_REGION_ERROR_TARGET, // detail inside the bubble (lower = sharper)
  });
  loadRegion.addRegion(playerRegion);

  tiles.setCamera(camera);
  tiles.setResolutionFromRenderer(camera, renderer);
  tiles.errorTarget = SANDBOX_ENGINE.TILE_ERROR_TARGET;

  // Cache + concurrency MUST be sized up BEFORE the first update(). The default
  // budget (8000 tiles / 0.4 GB) is the real ceiling on render distance + fidelity:
  // once the cache is full the renderer stops queuing AND discards just-parsed
  // tiles, so far/omnidirectional geometry never accumulates. A big floor keeps
  // the off-screen ring resident (turn back = no reload). DEMAND (errorTarget,
  // region) must never outrun SUPPLY (these) — that combo is what caused the
  // earlier all-low-poly map (errorTarget 5 + downloadQueue 12). Keep jobs ≥ 25.
  tiles.lruCache.minSize = SANDBOX_ENGINE.TILE_CACHE_MIN_SIZE;
  tiles.lruCache.maxSize = SANDBOX_ENGINE.TILE_CACHE_MAX_SIZE;
  tiles.lruCache.minBytesSize =
    SANDBOX_ENGINE.TILE_CACHE_MIN_GB * SANDBOX_ENGINE.TILE_CACHE_BYTES_PER_GB; // ~1.5 GB retained
  tiles.lruCache.maxBytesSize =
    SANDBOX_ENGINE.TILE_CACHE_MAX_GB * SANDBOX_ENGINE.TILE_CACHE_BYTES_PER_GB; // ~2.5 GB ceiling (sized to VRAM)
  tiles.downloadQueue.maxJobs = SANDBOX_ENGINE.TILE_DOWNLOAD_MAX_JOBS; // fill a big area fast (default 25)
  tiles.parseQueue.maxJobs = SANDBOX_ENGINE.TILE_PARSE_MAX_JOBS; // keep decode from bottlenecking (default 5)
  tiles.displayActiveTiles = true; // keep region-loaded tiles drawn off-frustum

  scene.add(tiles.group);

  const labels = new LabelManager(scene, tiles);
  const geoFrame = new GeoFrame(tiles, anchor);
  const modelLibrary = new ModelLibrary();
  const detectionLayer = new DetectionLayer(scene, modelLibrary);

  let tilesLoaded = false;
  tiles.addEventListener('load-tile-set', () => {
    if (!tilesLoaded) {
      tilesLoaded = true;
      cb.onTilesLoaded();
      void labels.load(anchor.lat, anchor.lon);
    }
  });
  tiles.addEventListener('load-error', (e: { error?: Error; url?: string | URL }) => {
    console.error('[sandbox] tile load error at', e?.url, e?.error);
    if (!tilesLoaded) cb.onError(`Tile load error: ${e?.error?.message ?? 'unknown'}`);
  });

  // --- Vehicles + ordnance ---
  const projectiles = new ProjectileManager(scene, tiles.group);
  const vehicles = new VehicleManager(scene, projectiles, modelLibrary);
  const bombs = new BombManager(scene);
  vehicles.position.set(0, SANDBOX_ENGINE.VEHICLE_SPAWN_HEIGHT, 0);

  // --- Modes + strategist tools ---
  let mode: SandboxMode = 'player';
  const viewshed = new ViewshedController(scene, tiles);
  const strategist = new StrategistController(
    camera,
    canvas,
    tiles.group,
    scene,
    viewshed,
    geoFrame
  );
  strategist.onStatus = (text) => {
    if (mode === 'strategist') cb.onStatus(text);
  };
  strategist.onFeaturesChanged = () => cb.onFeaturesChanged?.();
  strategist.onToolChanged = (tool) => cb.onToolChanged?.(tool);
  strategist.onViewpointsChanged = () => cb.onViewpointsChanged?.();

  function setMode(next: SandboxMode): void {
    mode = next;
    if (next === 'strategist') {
      strategist.enable(vehicles.position.clone());
    } else {
      strategist.disable();
    }
    cb.onMode(next);
  }

  // --- Follow camera (player mode) ---
  let orbitYaw = Math.PI;
  let orbitPitch = 0.35;
  let orbitDist = vehicles.cameraDist;
  let dragging = false;
  // Smoothed camera azimuth/pitch — only used for spider (filters out the
  // velocity-derived heading jitter and lets the wall-run cam ease into frame).
  // Other vehicles keep the old direct `heading + orbitYaw` for zero regression.
  let smoothCamYaw = Math.PI;
  let smoothCamPitch = orbitPitch;
  // Rate at which the orbit eases back behind the character while moving, so
  // after you flick the camera with the arrows it auto-recenters (SM2 feel).
  const RECENTER_RATE = SANDBOX_ENGINE.RECENTER_RATE;

  const onPointerDown = (): void => {
    if (mode === 'player') dragging = true;
  };
  const onPointerUp = (): void => {
    dragging = false;
  };
  const onPointerMove = (e: PointerEvent): void => {
    if (mode !== 'player' || !dragging) return;
    orbitYaw -= e.movementX * SANDBOX_ENGINE.POINTER_YAW_SCALE;
    orbitPitch = MathUtils.clamp(
      orbitPitch + e.movementY * SANDBOX_ENGINE.POINTER_PITCH_SCALE,
      SANDBOX_ENGINE.ORBIT_PITCH_MIN,
      SANDBOX_ENGINE.ORBIT_PITCH_MAX
    );
  };
  const onWheel = (e: WheelEvent): void => {
    if (mode !== 'player') return;
    orbitDist = MathUtils.clamp(
      orbitDist + e.deltaY * SANDBOX_ENGINE.WHEEL_ZOOM_SCALE,
      SANDBOX_ENGINE.ORBIT_DIST_MIN,
      SANDBOX_ENGINE.ORBIT_DIST_MAX
    );
  };
  const onKeyDown = (e: KeyboardEvent): void => {
    if (isTyping(e)) return; // don't hijack keys while user types in a form
    if (e.key === 'Tab') {
      e.preventDefault();
      setMode(mode === 'player' ? 'strategist' : 'player');
      return;
    }
    if (mode !== 'player') return;
    const typeByKey: Record<string, VehicleType> = {
      '1': 'tank',
      '2': 'car',
      '3': 'jet',
      '5': 'spider', // secret web-swing mode
    };
    const type = typeByKey[e.key];
    if (type) {
      vehicles.switchTo(type);
      orbitDist = vehicles.cameraDist;
      if (type === 'spider') seedSpiderCamera();
      cb.onVehicle?.(type);
    }
    if (e.key === ' ') e.preventDefault();
  };
  const onResize = (): void => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    tiles.setResolutionFromRenderer(camera, renderer);
  };

  canvas.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('wheel', onWheel);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('resize', onResize);

  const camTarget = new Vector3();
  let cameraShake = 0;

  // Snap the orbit behind the spider on entry so the camera doesn't have to
  // swing across the city to catch up to the drop-in.
  function seedSpiderCamera(): void {
    orbitYaw = Math.PI;
    smoothCamYaw = vehicles.state.heading + Math.PI;
    smoothCamPitch = orbitPitch;
  }

  function updateCamera(dt: number): void {
    const st = vehicles.state;
    const t = vehicles.position;

    const spider = Boolean(st.mode);

    // Spider only (st.mode is set): arrow keys orbit the camera — the jet
    // owns ↑↓ for pitch, so this must not apply globally. (Right stick.)
    let arrowYaw = false;
    if (spider) {
      if (vehicles.held('arrowleft')) {
        orbitYaw += SANDBOX_ENGINE.SPIDER_ARROW_YAW_RATE * dt;
        arrowYaw = true;
      }
      if (vehicles.held('arrowright')) {
        orbitYaw -= SANDBOX_ENGINE.SPIDER_ARROW_YAW_RATE * dt;
        arrowYaw = true;
      }
      if (vehicles.held('arrowup'))
        orbitPitch = MathUtils.clamp(
          orbitPitch + SANDBOX_ENGINE.SPIDER_ARROW_PITCH_RATE * dt,
          SANDBOX_ENGINE.ORBIT_PITCH_MIN,
          SANDBOX_ENGINE.ORBIT_PITCH_MAX
        );
      if (vehicles.held('arrowdown'))
        orbitPitch = MathUtils.clamp(
          orbitPitch - SANDBOX_ENGINE.SPIDER_ARROW_PITCH_RATE * dt,
          SANDBOX_ENGINE.ORBIT_PITCH_MIN,
          SANDBOX_ENGINE.ORBIT_PITCH_MAX
        );
    }

    // Decide where the camera WANTS to be this frame.
    const wallN = st.wallNormal;
    let targetYaw: number;
    let targetPitch = orbitPitch;
    let dist = orbitDist;
    if (spider && wallN) {
      // Wall-run: pin the camera to the outward wall normal and look UP the
      // face (low pitch), pulled back a little so the building fills the frame
      // and the camera rises with the climb. Insomniac's wall cam.
      targetYaw = Math.atan2(wallN[0], wallN[2]);
      targetPitch = SANDBOX_ENGINE.SPIDER_WALL_CAM_PITCH;
      dist = orbitDist + SANDBOX_ENGINE.SPIDER_WALL_CAM_DIST_ADD;
    } else {
      // Ease the orbit back behind the character while you're actually moving
      // (and not hand-orbiting) so pushing a direction settles the camera
      // behind you — no manual re-aligning.
      if (spider && !arrowYaw && st.speed > SANDBOX_ENGINE.SPIDER_RECENTER_SPEED_MIN) {
        orbitYaw += wrapAngle(Math.PI - orbitYaw) * Math.min(1, dt * RECENTER_RATE);
      }
      targetYaw = st.heading + orbitYaw;
    }

    let yaw: number;
    let pitch: number;
    if (spider) {
      // Filter the target (kills heading jitter; lets the wall cam swing in).
      smoothCamYaw +=
        wrapAngle(targetYaw - smoothCamYaw) *
        Math.min(
          1,
          dt * (wallN ? SANDBOX_ENGINE.SPIDER_SMOOTH_WALL_RATE : SANDBOX_ENGINE.SPIDER_SMOOTH_RATE)
        );
      smoothCamPitch +=
        (targetPitch - smoothCamPitch) * Math.min(1, dt * SANDBOX_ENGINE.SPIDER_PITCH_SMOOTH_RATE);
      yaw = smoothCamYaw;
      pitch = smoothCamPitch;
    } else {
      // Other vehicles: unchanged direct chase cam.
      yaw = targetYaw;
      pitch = orbitPitch;
      smoothCamYaw = targetYaw;
      smoothCamPitch = orbitPitch;
    }

    const horiz = dist * Math.cos(pitch);
    const desired = new Vector3(
      t.x + Math.sin(yaw) * horiz,
      t.y + dist * Math.sin(pitch),
      t.z + Math.cos(yaw) * horiz
    );

    // Spider-Man: widen FOV + tighten follow + lead the camera at speed
    const boost = st.fovBoost ?? 0;
    const targetFov = SANDBOX_ENGINE.CAMERA_FOV_DEG + SANDBOX_ENGINE.FOV_BOOST_DEG * boost;
    if (Math.abs(camera.fov - targetFov) > SANDBOX_ENGINE.FOV_UPDATE_EPSILON) {
      camera.fov += (targetFov - camera.fov) * Math.min(1, dt * SANDBOX_ENGINE.FOV_SMOOTH_RATE);
      camera.updateProjectionMatrix();
    }
    const follow = boost > 0 ? SANDBOX_ENGINE.FOLLOW_BOOST_RATE : SANDBOX_ENGINE.FOLLOW_BASE_RATE;
    camera.position.lerp(desired, Math.min(1, dt * follow));

    // look slightly ahead of motion when fast (40% lead at top speed)
    const lead = boost * SANDBOX_ENGINE.CAMERA_LEAD_SCALE;
    const ahead = new Vector3(
      t.x + Math.sin(st.heading) * st.speed * lead,
      t.y + SANDBOX_ENGINE.CAMERA_TARGET_HEIGHT,
      t.z + Math.cos(st.heading) * st.speed * lead
    );
    camTarget.lerp(ahead, Math.min(1, dt * SANDBOX_ENGINE.CAMERA_TARGET_LERP_RATE));
    camera.lookAt(camTarget);

    // screen shake — decays exponentially
    if (cameraShake > SANDBOX_ENGINE.SHAKE_MIN) {
      const s = cameraShake * SANDBOX_ENGINE.SHAKE_SCALE;
      camera.position.x += (Math.random() - SANDBOX_ENGINE.SHAKE_HALF_SCALE) * s;
      camera.position.y +=
        (Math.random() - SANDBOX_ENGINE.SHAKE_HALF_SCALE) * s * SANDBOX_ENGINE.SHAKE_HALF_SCALE;
      camera.position.z += (Math.random() - SANDBOX_ENGINE.SHAKE_HALF_SCALE) * s;
    }
    cameraShake *= Math.pow(SANDBOX_ENGINE.SHAKE_DECAY, dt); // fast decay
  }

  // --- Attributions (Google ToS requires display) ---
  const attribTimer = window.setInterval(() => {
    try {
      const list = tiles
        .getAttributions()
        .map((a) => a.value)
        .filter(Boolean);
      cb.onAttributions(list.length ? list.join(' • ') : '© Google');
    } catch {
      cb.onAttributions('© Google');
    }
  }, SANDBOX_ENGINE.ATTRIBUTION_POLL_MS);

  // --- Loop ---
  const clock = new Clock();
  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), SANDBOX_ENGINE.MAX_FRAME_DELTA_S);

    if (mode === 'player') {
      // Spider locomotion is camera-relative — hand it last frame's smoothed
      // camera azimuth before it moves (one-frame lag is imperceptible).
      vehicles.setCameraYaw(smoothCamYaw);
      vehicles.update(dt, tiles.group);
      for (const drop of vehicles.drainBombs()) bombs.drop(drop);
      cameraShake += bombs.update(dt, tiles.group);
      updateCamera(dt);
    }
    projectiles.update(dt);

    if (mode === 'strategist') strategist.update(performance.now());
    camera.updateMatrixWorld();
    // Center the player load-region on the active vehicle (world → tiles-group
    // local), so high detail streams in all around the player every frame.
    tiles.group.updateMatrixWorld();
    playerRegion.sphere.center.copy(vehicles.position);
    tiles.group.worldToLocal(playerRegion.sphere.center);
    tiles.update();
    viewshed.update(renderer);
    labels.update(camera);
    renderer.render(scene, camera);

    if (mode === 'player') {
      cb.onHud(vehicles.hudText());
    } else {
      const mgrs = strategist.getCursorMgrs();
      cb.onHud(`Features: ${strategist.featureCount}` + (mgrs ? `\nMGRS ${mgrs}` : ''));
    }
  });

  cb.onMode('player');

  function getCameraPose(): CameraPose {
    camera.updateMatrixWorld();
    const forward = new Vector3();
    camera.getWorldDirection(forward);
    const geo = geoFrame.localToGeo(camera.position);
    return {
      type: 'sentinel-camera-pose',
      version: 1,
      capturedAt: new Date().toISOString(),
      anchor: { ...anchor },
      camera: {
        fovDeg: camera.fov,
        aspect: camera.aspect,
        local: {
          position: camera.position.toArray() as [number, number, number],
          quaternion: camera.quaternion.toArray() as [number, number, number, number],
        },
        geo: {
          lat: geo.lat,
          lon: geo.lon,
          altM: geo.altM,
          headingDeg: geoFrame.compassHeadingDeg(forward),
          pitchDeg:
            (Math.asin(MathUtils.clamp(forward.y, -1, 1)) *
              SANDBOX_COMMON.DEGREES_HALF_TURN) /
            Math.PI,
        },
      },
    };
  }

  function captureShot(): void {
    const stamp = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .slice(0, SANDBOX_ENGINE.CAPTURE_STAMP_LENGTH);
    const pose = getCameraPose();
    pose.image = { width: canvas.width, height: canvas.height };

    // Render tiles only (layer 0) — no labels, markers, vehicles, or HUD sprites
    const prevMask = camera.layers.mask;
    camera.layers.set(0);
    renderer.render(scene, camera);
    canvas.toBlob((blob) => {
      camera.layers.mask = prevMask;
      if (!blob) return;
      downloadBlob(blob, `sentinel-shot-${stamp}.png`);
      downloadBlob(
        new Blob([JSON.stringify(pose, null, 2)], { type: 'application/json' }),
        `sentinel-shot-${stamp}.pose.json`
      );
    }, 'image/png');
  }

  function deployFromImage(
    pose: CameraPose,
    annotations: ImageAnnotation[],
    image: { width: number; height: number; name: string },
    provenance?: DeployProvenance
  ): DeployResult {
    return deployAnnotations(
      { tilesGroup: tiles.group, geoFrame, detectionLayer },
      pose,
      annotations,
      image,
      provenance
    );
  }

  return {
    setMode,
    setTool: (tool) => strategist.setTool(tool),
    clearAll: () => strategist.clearAll(),
    listFeatures: () => strategist.listFeatures(),
    removeFeature: (id) => strategist.removeFeature(id),
    renameFeature: (id, name) => strategist.renameFeature(id, name),
    undoLastFeature: () => strategist.undoLast(),
    selectFeature: (id) => strategist.selectFeature(id),
    setUnitAffiliation: (affiliation) => {
      strategist.unitAffiliation = affiliation;
    },
    setUnitEchelon: (echelon) => {
      strategist.unitEchelon = echelon;
    },
    setRangeFanSystem: (systemId) => {
      strategist.rangeFanSystemId = systemId;
    },
    getRangeFanSystemId: (featureId) => strategist.getRangeFanSystemId(featureId),
    setMgrsHudEnabled: (enabled) => {
      strategist.mgrsHudEnabled = enabled;
    },
    savePlan: (name) =>
      savePlanToStore(
        name,
        strategist.exportFeatures(),
        anchor,
        new Date().toISOString(),
        strategist.exportViewpoints(),
        strategist.currentClassification,
        strategist.exportPhases()
      ),
    loadPlan: (id) => {
      const plan = loadPlanFromStore(id);
      strategist.loadPlan(plan.features);
      strategist.loadViewpoints(plan.viewpoints);
      strategist.loadPhases(plan.phases);
      strategist.currentClassification = plan.classification;
    },
    setClassification: (level) => {
      strategist.currentClassification = level;
    },
    getClassification: () => strategist.currentClassification,
    setOperatorName: (name) => {
      strategist.operatorName = name;
    },
    exportPlanGeoJSON: (name) =>
      exportGeoJSON({
        name,
        features: strategist.exportFeatures(),
        classification: strategist.currentClassification,
      }),
    exportPlanKML: (name) =>
      exportKML({
        name,
        features: strategist.exportFeatures(),
        classification: strategist.currentClassification,
      }),
    listPlans: () => listPlansFromStore(),
    deletePlan: (id) => deletePlanFromStore(id),
    saveViewpoint: (name) => strategist.saveViewpoint(name, getCameraPose()),
    listViewpoints: () => strategist.listViewpoints(),
    renameViewpoint: (id, name) => strategist.renameViewpoint(id, name),
    setViewpointPhase: (id, phaseId) => strategist.setViewpointPhase(id, phaseId),
    deleteViewpoint: (id) => strategist.deleteViewpoint(id),
    reorderViewpoints: (orderedIds) => strategist.reorderViewpoints(orderedIds),
    restoreViewpoint: (id) => strategist.restoreViewpoint(id),
    playBriefNext: () => strategist.playBriefNext(performance.now()),
    playBriefPrevious: () => strategist.playBriefPrevious(performance.now()),
    playBriefGoTo: (index) => strategist.playBriefGoTo(index, performance.now()),
    cancelBriefPlayback: () => strategist.cancelBriefPlayback(),
    getBriefPlaybackState: () => strategist.briefPlaybackState,
    rehearseGoTo: (index) => strategist.rehearseGoTo(index, performance.now()),
    rehearseNext: () => strategist.rehearseNext(performance.now()),
    rehearsePrevious: () => strategist.rehearsePrevious(performance.now()),
    startRehearsal: () => strategist.startRehearsal(performance.now()),
    pauseRehearsal: () => strategist.pauseRehearsal(),
    cancelRehearsal: () => strategist.cancelRehearsal(),
    isRehearsing: () => strategist.isRehearsing,
    exitGroundWalk: () => strategist.exitGroundWalk(),
    isGroundWalkActive: () => strategist.isGroundWalkActive,
    listPhases: () => strategist.listPhases(),
    addPhase: (name) => strategist.addPhase(name),
    renamePhase: (id, name) => strategist.renamePhase(id, name),
    reorderPhases: (orderedIds) => strategist.reorderPhases(orderedIds),
    deletePhase: (id) => strategist.deletePhase(id),
    getFeaturePhase: (featureId) => strategist.getFeaturePhase(featureId),
    setFeaturePhase: (featureId, phaseId) => strategist.setFeaturePhase(featureId, phaseId),
    getPhaseFilter: () => strategist.phaseFilterId,
    setPhaseFilter: (phaseId) => strategist.setPhaseFilter(phaseId),
    scrubToPhaseIndex: (index) => strategist.scrubToPhaseIndex(index),
    stepTimelineNext: () => strategist.stepTimelineNext(performance.now()),
    stepTimelinePrevious: () => strategist.stepTimelinePrevious(performance.now()),
    cancelTimelinePlayback: () => strategist.cancelTimelinePlayback(),
    getTimelineState: () => strategist.timelineState,
    armSetUnitPhasePosition: (featureId, phaseId) =>
      strategist.armSetUnitPhasePosition(featureId, phaseId),
    cancelSetUnitPhasePosition: () => strategist.cancelSetUnitPhasePosition(),
    isArmedForPhasePosition: () => strategist.isArmedForPhasePosition,
    isPathFeature: (featureId) => strategist.isPathFeature(featureId),
    getElevationProfile: (featureId) => strategist.computeElevationProfile(featureId),
    getMoveTimeMinutes: (featureId, rate) => strategist.computeMoveTimeMinutes(featureId, rate),
    runRouteExposure: (featureId, threatFeatureId) =>
      strategist.runRouteExposure(featureId, threatFeatureId),
    clearRouteExposureOverlay: () => strategist.clearRouteExposureOverlay(),
    switchVehicle: (type) => {
      vehicles.switchTo(type);
      orbitDist = vehicles.cameraDist;
      if (type === 'spider') seedSpiderCamera();
      cb.onVehicle?.(type);
    },
    setLabelsVisible: (v) => labels.setVisible(v),
    getCameraPose,
    captureShot,
    deployFromImage,
    clearDetections: () => detectionLayer.clear(),
    dispose: () => {
      renderer.setAnimationLoop(null);
      window.clearInterval(attribTimer);
      canvas.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onResize);
      tiles.dispose();
      renderer.dispose();
    },
  };
}
