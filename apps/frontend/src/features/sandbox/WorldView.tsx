import { type BattleSnapshot, UNIT_TYPES, type UnitType } from '@org/simulation-core';
import {
  ArrowRight,
  Ban,
  Camera,
  Car,
  Check,
  ChevronDown,
  ChevronUp,
  Clipboard,
  Compass,
  Crosshair,
  Eye,
  EyeOff,
  Flag,
  Footprints,
  Import,
  type LucideIcon,
  MapPin,
  Mountain,
  MousePointer2,
  Pause,
  Pencil,
  Plane,
  Play,
  Plus,
  Radar,
  RotateCcw,
  Ruler,
  Satellite,
  Save,
  SkipBack,
  SkipForward,
  Square,
  SquareDashed,
  Swords,
  Tag,
  Target,
  Trash2,
  Undo2,
  Waves,
} from 'lucide-react';
import {
  type DragEvent,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  type CameraPose,
  createSandbox,
  downloadBlob,
  preflightGoogleKey,
  type Sandbox,
  type SandboxMode,
} from './engine/createSandbox';
import {
  CLASSIFICATION_COLOR,
  CLASSIFICATION_LEVELS,
  type ClassificationLevel,
  DEFAULT_CLASSIFICATION,
} from './engine/classification';
import {
  ELEVATION_SAMPLE_SPACING_M,
  type ElevationSample,
  isNoGo,
  MOVE_RATES_KMH,
  type MoveRate,
  SLOPE_NOGO_THRESHOLD_PERCENT,
} from './engine/elevationProfile';
import { ALL_PHASES } from './engine/planFeature';
import type { Plan, PlanPhase } from './engine/planStore';
import type { Viewpoint } from './engine/viewpoint';
import { getStoredSpawnKey, SPAWN_LOCATIONS } from './spawnLocations';
import { type FeatureSummary, type StratTool, TOOL_HINTS } from './engine/strategist';
import type { Affiliation, Echelon } from './engine/unitSymbol';
import { type SystemId, WEAPON_SYSTEMS } from './engine/weaponSystems';
import type { VehicleType } from './engine/vehicles';
import {
  BATTLE_SCENARIO_OPTIONS,
  BATTLE_TEAM_IDS,
  type BattlePlacementResult,
  type BattleScenarioId,
  type BattleTeamId,
} from './engine/battleSimulation';
import type { TerrainSemanticsSummary } from './engine/terrainSemantics';
import { getLocalStorageItem, removeLocalStorageItem, setLocalStorageItem } from './safeStorage';
import { PanelRail } from './ui/PanelRail';
import { PanelSection } from './ui/PanelSection';

import { SANDBOX_COMMON, SANDBOX_WORLD_VIEW } from '@/constants/sandbox';

const KEY_STORAGE = 'google_tiles_key';
const BATTLE_STATE_POLL_MS = 200;
const FAST_BATTLE_TIME_SCALE = 4;
const BATTLE_TIME_SCALES = [1, 2, FAST_BATTLE_TIME_SCALE] as const;
const BATTLE_EVENT_FEED_LIMIT = 4;
const BATTLE_DRAG_MIME = 'application/x-sentinel-battle-unit';

interface BattleUnitOption {
  readonly type: UnitType;
  readonly label: string;
  readonly role: string;
  readonly Icon: LucideIcon;
}

interface BattleDragPayload {
  readonly unitType: UnitType;
  readonly teamId: BattleTeamId;
}

interface BattlePlacementFeedback {
  readonly tone: 'info' | 'success' | 'error';
  readonly message: string;
}

type BattleManualUnitCounts = Record<BattleScenarioId, number>;

function emptyBattleManualUnitCounts(): BattleManualUnitCounts {
  return { none: 0, 'armored-skirmish': 0, 'combined-arms': 0 };
}

const BATTLE_UNIT_OPTIONS: readonly BattleUnitOption[] = Object.freeze([
  { type: 'infantry', label: 'Infantry', role: 'Dismounted element', Icon: Footprints },
  { type: 'car', label: 'Car', role: 'Light mobility', Icon: Car },
  { type: 'tank', label: 'Tank', role: 'Armored element', Icon: Square },
  { type: 'jet', label: 'Jet', role: 'Air support', Icon: Plane },
]);

const BATTLE_TEAM_STYLE: Readonly<
  Record<BattleTeamId, { readonly label: string; readonly color: string }>
> = Object.freeze({
  blue: Object.freeze({ label: 'Blue force', color: '#38bdf8' }),
  red: Object.freeze({ label: 'Red force', color: '#fb7185' }),
});

function isBattleDragPayload(value: unknown): value is BattleDragPayload {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.unitType === 'string' &&
    UNIT_TYPES.includes(candidate.unitType as UnitType) &&
    typeof candidate.teamId === 'string' &&
    BATTLE_TEAM_IDS.includes(candidate.teamId as BattleTeamId)
  );
}

function readBattleDragPayload(event: DragEvent<HTMLCanvasElement>): BattleDragPayload | null {
  const raw = event.dataTransfer.getData(BATTLE_DRAG_MIME);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isBattleDragPayload(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function feedbackFromPlacement(result: BattlePlacementResult): BattlePlacementFeedback {
  return { tone: result.accepted ? 'success' : 'error', message: result.message };
}

function battleStatusLabel(snapshot: BattleSnapshot): string {
  if (snapshot.status.phase === 'victory') {
    const winner = snapshot.teams.find((team) => team.id === snapshot.status.winnerTeamId);
    return `${winner?.name ?? 'Unknown team'} wins`;
  }
  if (snapshot.status.phase === 'draw') return 'Draw';
  if (snapshot.status.phase === 'paused') return 'Paused';
  if (snapshot.status.phase === 'running') return 'Running';
  return 'Ready';
}

const modalComponents = {
  IntelImport: lazy(() =>
    import('./IntelImport').then((module) => ({ default: module.IntelImport }))
  ),
};

function IntelImportFallback() {
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/35"
      role="status"
      aria-live="polite"
    >
      <div className="rounded-box flex items-center gap-3 bg-base-100 px-5 py-4 shadow-xl">
        <span className="loading loading-spinner text-primary" />
        <span className="text-sm">Loading importer...</span>
      </div>
    </div>
  );
}

// SPAWN_LOCATIONS imported from shared module

const TOOLS: Array<{ id: StratTool; label: string; Icon: LucideIcon }> = [
  { id: 'select', label: 'Select', Icon: MousePointer2 },
  { id: 'distance', label: 'Distance', Icon: Ruler },
  { id: 'focus', label: 'Focus Area', Icon: Target },
  { id: 'arc', label: 'Fire Arc', Icon: Compass },
  { id: 'los', label: 'Line of Sight', Icon: Eye },
  { id: 'viewshed', label: 'Viewshed', Icon: Radar },
  { id: 'counterViewshed', label: 'Counter-Viewshed', Icon: EyeOff },
  { id: 'boundary', label: 'Boundary', Icon: SquareDashed },
  { id: 'phaseline', label: 'Phase Line', Icon: Waves },
  { id: 'loa', label: 'Limit of Adv.', Icon: Ban },
  { id: 'axis', label: 'Axis of Adv.', Icon: ArrowRight },
  { id: 'objective', label: 'Objective', Icon: Flag },
  { id: 'symbol', label: 'Unit Symbol', Icon: Square },
  { id: 'rangeFan', label: 'Range Fan', Icon: Crosshair },
  { id: 'groundWalk', label: 'Ground Walk', Icon: Footprints },
];

const AFFILIATIONS: Affiliation[] = ['friendly', 'enemy', 'neutral'];
const ECHELONS: Echelon[] = [
  'team',
  'squad',
  'section',
  'platoon',
  'company',
  'battalion',
  'brigade',
];

/** Tank keeps its emoji — lucide has no literal-tank equivalent, and the nearest
 * stand-in (Shield) is less clear than the current helmet glyph; not worth a semantic
 * downgrade for one low-priority Player-mode icon. */
const VEHICLES: Array<{ id: VehicleType; label: string; key: string; Icon?: LucideIcon }> = [
  { id: 'tank', label: '🪖 Tank', key: '1' },
  { id: 'car', label: 'GT Car', key: '2', Icon: Car },
  { id: 'jet', label: 'Jet', key: '3', Icon: Plane },
];

function getStoredKey(): string | null {
  const env = (import.meta.env.VITE_GOOGLE_TILES_KEY as string | undefined) ?? null;
  return env ?? getLocalStorageItem(KEY_STORAGE);
}

interface WorldViewProps {
  onModeBadgeChange?: (state: { mode: SandboxMode; visible: boolean }) => void;
  onPlanExportChange?: (state: {
    visible: boolean;
    disabled: boolean;
    onExportGeoJSON: () => void;
    onExportKML: () => void;
  }) => void;
}

export function WorldView({ onModeBadgeChange, onPlanExportChange }: WorldViewProps = {}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sandboxRef = useRef<Sandbox | null>(null);

  const [apiKey, setApiKey] = useState<string | null>(getStoredKey);
  const [keyDraft, setKeyDraft] = useState('');
  const [fatal, setFatal] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [spawnLocationKey, setSpawnLocationKey] = useState<string>(getStoredSpawnKey());

  const [mode, setMode] = useState<SandboxMode>('player');
  const [activeVehicle, setActiveVehicle] = useState<VehicleType>('tank');
  const [tool, setTool] = useState<StratTool>('select');
  const [status, setStatus] = useState('');
  const [hudLines, setHudLines] = useState<string[]>([]);
  const [attributions, setAttributions] = useState('© Google');
  const [labelsOn, setLabelsOn] = useState(true);
  const [pose, setPose] = useState<CameraPose | null>(null);
  const [poseCopied, setPoseCopied] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [featureVersion, setFeatureVersion] = useState(0);
  const [selectedFeatureId, setSelectedFeatureId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [unitAffiliation, setUnitAffiliationState] = useState<Affiliation>('friendly');
  const [unitEchelon, setUnitEchelonState] = useState<Echelon>('platoon');
  const [rangeFanSystemId, setRangeFanSystemIdState] = useState<SystemId>('mortar81mm');
  const [planVersion, setPlanVersion] = useState(0);
  const [planNameDraft, setPlanNameDraft] = useState('');
  const [classification, setClassificationState] =
    useState<ClassificationLevel>(DEFAULT_CLASSIFICATION);
  const [viewpointVersion, setViewpointVersion] = useState(0);
  const [viewpointNameDraft, setViewpointNameDraft] = useState('');
  const [phaseNameDraft, setPhaseNameDraft] = useState('');
  const [phaseFilter, setPhaseFilterState] = useState<string>(ALL_PHASES);
  const [renamingPhaseId, setRenamingPhaseId] = useState<string | null>(null);
  const [renamePhaseDraft, setRenamePhaseDraft] = useState('');
  const [battleScenarioId, setBattleScenarioId] = useState<BattleScenarioId>('none');
  const [battleSnapshot, setBattleSnapshot] = useState<BattleSnapshot | null>(null);
  const [battleTimeScale, setBattleTimeScaleState] = useState(1);
  const [battleTeamId, setBattleTeamId] = useState<BattleTeamId>('blue');
  const [battleTerrainSummary, setBattleTerrainSummary] = useState<TerrainSemanticsSummary | null>(
    null
  );
  const [battleTerrainRetrying, setBattleTerrainRetrying] = useState(false);
  const [battlePlacementFeedback, setBattlePlacementFeedback] =
    useState<BattlePlacementFeedback | null>(null);
  const [battleManualUnitCounts, setBattleManualUnitCounts] = useState<BattleManualUnitCounts>(
    emptyBattleManualUnitCounts
  );
  const [draggingBattleUnit, setDraggingBattleUnit] = useState<BattleDragPayload | null>(null);
  const [battleDropAllowed, setBattleDropAllowed] = useState<boolean | null>(null);

  const battlePhase = battleSnapshot?.status.phase;
  const battleHasActiveRun = battlePhase === 'running' || battlePhase === 'paused';
  const battleTerrainReady = battleTerrainSummary?.status === 'ready';
  const canRunBattle = !loading && !battleHasActiveRun;

  const features = useMemo<FeatureSummary[]>(
    () => sandboxRef.current?.listFeatures() ?? [],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- featureVersion is the refresh signal; the list itself lives on sandboxRef, not React state
    [featureVersion]
  );

  const plans = useMemo<Plan[]>(
    () => sandboxRef.current?.listPlans() ?? [],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- planVersion is the refresh signal
    [planVersion]
  );

  const viewpoints = useMemo<Viewpoint[]>(
    () => sandboxRef.current?.listViewpoints() ?? [],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- viewpointVersion is the refresh signal
    [viewpointVersion]
  );

  const phases = useMemo<PlanPhase[]>(
    () => sandboxRef.current?.listPhases() ?? [],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- featureVersion is the refresh signal (every phase mutation also calls onFeaturesChanged)
    [featureVersion]
  );

  useEffect(() => {
    onModeBadgeChange?.({ mode, visible: Boolean(apiKey && !fatal) });
  }, [apiKey, fatal, mode, onModeBadgeChange]);

  useEffect(() => {
    return () => onModeBadgeChange?.({ mode: 'player', visible: false });
  }, [onModeBadgeChange]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!apiKey || !canvas) return;

    let cancelled = false;
    let sandbox: Sandbox | null = null;
    setLoading(true);
    setFatal(null);
    setBattleSnapshot(null);
    setBattleTerrainSummary(null);
    setBattlePlacementFeedback(null);
    setBattleManualUnitCounts(emptyBattleManualUnitCounts());
    setDraggingBattleUnit(null);
    setBattleDropAllowed(null);

    void preflightGoogleKey(apiKey).then((error) => {
      if (cancelled) return;
      if (error) {
        setFatal(`Google rejected the key: ${error}`);
        setLoading(false);
        return;
      }
      const selectedLocation =
        SPAWN_LOCATIONS.find((item) => item.key === spawnLocationKey) ?? SPAWN_LOCATIONS[0];
      sandbox = createSandbox(
        canvas,
        apiKey,
        { lat: selectedLocation.lat, lon: selectedLocation.lon },
        {
          onStatus: setStatus,
          onHud: (text) => setHudLines(text.split('\n')),
          onMode: (next) => {
            setMode(next);
            // The feature list is only otherwise refreshed by onFeaturesChanged deltas —
            // re-sync from the live sandbox on every mode entry so a strategist session that
            // already has features (a future loaded plan) isn't shown stale/empty.
            if (next === 'strategist') setFeatureVersion((v) => v + 1);
          },
          onFeaturesChanged: () => setFeatureVersion((v) => v + 1),
          onToolChanged: setTool,
          onViewpointsChanged: () => setViewpointVersion((v) => v + 1),
          onVehicle: setActiveVehicle,
          onAttributions: setAttributions,
          onTilesLoaded: () => setLoading(false),
          onError: (message) => {
            setFatal(message);
            setLoading(false);
          },
        }
      );
      sandboxRef.current = sandbox;
    });

    return () => {
      cancelled = true;
      sandbox?.dispose();
      sandboxRef.current = null;
    };
  }, [apiKey, spawnLocationKey]);

  // Listen for navbar-driven spawn changes
  useEffect(() => {
    const handler = (e: Event) => {
      const key = (e as CustomEvent<string>).detail as string;
      if (key) setSpawnLocationKey(key);
    };
    window.addEventListener('spawnLocationChanged', handler as EventListener);
    return () => window.removeEventListener('spawnLocationChanged', handler as EventListener);
  }, []);

  const selectTool = useCallback((next: StratTool) => {
    setTool(next);
    sandboxRef.current?.setTool(next);
  }, []);

  const selectUnitAffiliation = useCallback((next: Affiliation) => {
    setUnitAffiliationState(next);
    sandboxRef.current?.setUnitAffiliation(next);
  }, []);

  const selectUnitEchelon = useCallback((next: Echelon) => {
    setUnitEchelonState(next);
    sandboxRef.current?.setUnitEchelon(next);
  }, []);

  const selectRangeFanSystem = useCallback((next: SystemId) => {
    setRangeFanSystemIdState(next);
    sandboxRef.current?.setRangeFanSystem(next);
  }, []);

  const selectFeatureRow = useCallback((id: string) => {
    setSelectedFeatureId((prev) => {
      const next = prev === id ? null : id;
      sandboxRef.current?.selectFeature(next);
      return next;
    });
  }, []);

  const startRename = useCallback((f: FeatureSummary) => {
    setRenamingId(f.id);
    setRenameDraft(f.name);
  }, []);

  const commitRename = useCallback(
    (id: string) => {
      const trimmed = renameDraft.trim();
      if (trimmed) sandboxRef.current?.renameFeature(id, trimmed);
      setRenamingId(null);
    },
    [renameDraft]
  );

  const deleteFeature = useCallback(
    (id: string) => {
      sandboxRef.current?.removeFeature(id);
      if (selectedFeatureId === id) setSelectedFeatureId(null);
    },
    [selectedFeatureId]
  );

  const undoLastFeature = useCallback(() => {
    sandboxRef.current?.undoLastFeature();
    setSelectedFeatureId(null);
  }, []);

  const savePlan = useCallback(() => {
    const trimmed = planNameDraft.trim();
    if (!trimmed || !sandboxRef.current) return;
    sandboxRef.current.savePlan(trimmed);
    setPlanVersion((v) => v + 1);
  }, [planNameDraft]);

  const loadPlan = useCallback((id: string) => {
    sandboxRef.current?.loadPlan(id);
    setSelectedFeatureId(null);
    setFeatureVersion((v) => v + 1);
    const sb = sandboxRef.current;
    if (sb) {
      setClassificationState(sb.getClassification());
      setPhaseFilterState(sb.getPhaseFilter());
    }
  }, []);

  const selectClassification = useCallback((level: ClassificationLevel) => {
    setClassificationState(level);
    sandboxRef.current?.setClassification(level);
  }, []);

  const deletePlan = useCallback((id: string) => {
    sandboxRef.current?.deletePlan(id);
    setPlanVersion((v) => v + 1);
  }, []);

  const exportPlanFile = useCallback(
    (format: 'geojson' | 'kml') => {
      const sb = sandboxRef.current;
      if (!sb) return;
      const name = planNameDraft.trim() || 'Untitled Plan';
      const content = format === 'geojson' ? sb.exportPlanGeoJSON(name) : sb.exportPlanKML(name);
      const mime =
        format === 'geojson' ? 'application/geo+json' : 'application/vnd.google-earth.kml+xml';
      downloadBlob(new Blob([content], { type: mime }), `${name}.${format}`);
    },
    [planNameDraft]
  );

  useEffect(() => {
    onPlanExportChange?.({
      visible: Boolean(apiKey && !fatal),
      disabled: features.length === 0,
      onExportGeoJSON: () => exportPlanFile('geojson'),
      onExportKML: () => exportPlanFile('kml'),
    });
  }, [apiKey, exportPlanFile, fatal, features.length, onPlanExportChange]);

  useEffect(() => {
    return () =>
      onPlanExportChange?.({
        visible: false,
        disabled: true,
        onExportGeoJSON: () => undefined,
        onExportKML: () => undefined,
      });
  }, [onPlanExportChange]);

  const saveViewpoint = useCallback(() => {
    const trimmed = viewpointNameDraft.trim();
    if (!trimmed || !sandboxRef.current) return;
    sandboxRef.current.saveViewpoint(trimmed);
    setViewpointNameDraft('');
  }, [viewpointNameDraft]);

  const moveViewpoint = useCallback(
    (id: string, direction: -1 | 1) => {
      const ids = viewpoints.map((v) => v.id);
      const idx = ids.indexOf(id);
      const swapWith = idx + direction;
      if (idx === -1 || swapWith < 0 || swapWith >= ids.length) return;
      [ids[idx], ids[swapWith]] = [ids[swapWith], ids[idx]];
      sandboxRef.current?.reorderViewpoints(ids);
    },
    [viewpoints]
  );

  const selectViewpointPhase = useCallback((viewpointId: string, phaseId: string) => {
    sandboxRef.current?.setViewpointPhase(
      viewpointId,
      phaseId === ALL_PHASES ? undefined : phaseId
    );
    setViewpointVersion((v) => v + 1);
  }, []);

  // ---------- phase tagging (todo 25) ----------

  const addPhase = useCallback(() => {
    const trimmed = phaseNameDraft.trim();
    if (!trimmed || !sandboxRef.current) return;
    sandboxRef.current.addPhase(trimmed);
    setPhaseNameDraft('');
    setFeatureVersion((v) => v + 1);
  }, [phaseNameDraft]);

  const startRenamePhase = useCallback((phase: PlanPhase) => {
    setRenamingPhaseId(phase.id);
    setRenamePhaseDraft(phase.name);
  }, []);

  const commitRenamePhase = useCallback(
    (id: string) => {
      const trimmed = renamePhaseDraft.trim();
      if (trimmed) sandboxRef.current?.renamePhase(id, trimmed);
      setRenamingPhaseId(null);
      setFeatureVersion((v) => v + 1);
    },
    [renamePhaseDraft]
  );

  const movePhase = useCallback(
    (id: string, direction: -1 | 1) => {
      const ids = phases.map((p) => p.id);
      const idx = ids.indexOf(id);
      const swapWith = idx + direction;
      if (idx === -1 || swapWith < 0 || swapWith >= ids.length) return;
      [ids[idx], ids[swapWith]] = [ids[swapWith], ids[idx]];
      sandboxRef.current?.reorderPhases(ids);
      setFeatureVersion((v) => v + 1);
    },
    [phases]
  );

  const deletePhase = useCallback(
    (id: string) => {
      sandboxRef.current?.deletePhase(id);
      if (phaseFilter === id) setPhaseFilterState(ALL_PHASES);
      setFeatureVersion((v) => v + 1);
    },
    [phaseFilter]
  );

  const selectPhaseFilter = useCallback((phaseId: string) => {
    setPhaseFilterState(phaseId);
    sandboxRef.current?.setPhaseFilter(phaseId);
  }, []);

  const selectFeaturePhase = useCallback((featureId: string, phaseId: string) => {
    sandboxRef.current?.setFeaturePhase(featureId, phaseId);
    setFeatureVersion((v) => v + 1);
  }, []);

  const clearAllFeatures = useCallback(() => {
    sandboxRef.current?.clearAll();
    setPhaseFilterState(ALL_PHASES);
  }, []);

  // ---------- timeline (todo 26) ----------

  const scrubTimeline = useCallback((index: number) => {
    sandboxRef.current?.scrubToPhaseIndex(index);
    setPhaseFilterState(sandboxRef.current?.getPhaseFilter() ?? ALL_PHASES);
  }, []);

  const stepTimeline = useCallback((direction: -1 | 1) => {
    if (direction === 1) sandboxRef.current?.stepTimelineNext();
    else sandboxRef.current?.stepTimelinePrevious();
    setPhaseFilterState(sandboxRef.current?.getPhaseFilter() ?? ALL_PHASES);
  }, []);

  const [armedFeatureId, setArmedFeatureId] = useState<string | null>(null);

  const armSetUnitPosition = useCallback((featureId: string, phaseId: string) => {
    sandboxRef.current?.armSetUnitPhasePosition(featureId, phaseId);
    setArmedFeatureId(featureId);
  }, []);

  // Poll whether the armed capture has resolved (a map click consumed it) so the "click
  // the map" affordance clears itself — same render-loop-driven pattern as briefState/
  // timelineState above.
  useEffect(() => {
    if (!armedFeatureId) return;
    const timer = window.setInterval(() => {
      if (!sandboxRef.current?.isArmedForPhasePosition()) {
        setArmedFeatureId(null);
        setFeatureVersion((v) => v + 1);
      }
    }, SANDBOX_WORLD_VIEW.STATE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [armedFeatureId]);

  // Brief-playback step indicator (todo 20) — the interpolation is driven by the render
  // loop, not a React callback, so poll it (same pattern as the camera-pose readout below).
  const [briefState, setBriefState] = useState<{ currentIndex: number; isPlaying: boolean }>({
    currentIndex: 0,
    isPlaying: false,
  });
  useEffect(() => {
    if (!apiKey || loading || fatal || mode !== 'strategist') return;
    const timer = window.setInterval(() => {
      const sb = sandboxRef.current;
      if (sb) setBriefState(sb.getBriefPlaybackState());
    }, SANDBOX_WORLD_VIEW.STATE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [apiKey, loading, fatal, mode]);

  // Timeline step indicator (todo 26) — same poll pattern as brief playback above; the
  // phase-to-phase interpolation is also render-loop-driven, not a React callback.
  const [timelineState, setTimelineState] = useState<{ currentIndex: number; isPlaying: boolean }>({
    currentIndex: 0,
    isPlaying: false,
  });
  useEffect(() => {
    if (!apiKey || loading || fatal || mode !== 'strategist') return;
    const timer = window.setInterval(() => {
      const sb = sandboxRef.current;
      if (sb) setTimelineState(sb.getTimelineState());
    }, SANDBOX_WORLD_VIEW.STATE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [apiKey, loading, fatal, mode]);

  // Rehearsal indicator (todo 27) — the brief-sequence index doubles as the ONE combined
  // step index (invariant 1); this poll only tracks whether a guided rehearsal (vs. plain
  // manual brief-stepping) is currently driving it.
  const [rehearsing, setRehearsing] = useState(false);
  useEffect(() => {
    if (!apiKey || loading || fatal || mode !== 'strategist') return;
    const timer = window.setInterval(() => {
      const sb = sandboxRef.current;
      if (sb) setRehearsing(sb.isRehearsing());
    }, SANDBOX_WORLD_VIEW.STATE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [apiKey, loading, fatal, mode]);

  // ---------- terrain-reasoning depth (Wave 4, todo 29 — M1 elevation + M4 move timing) ----------

  const [analyzedFeatureId, setAnalyzedFeatureId] = useState<string | null>(null);
  const [moveRate, setMoveRate] = useState<MoveRate>('dismounted');
  const elevationChartRef = useRef<HTMLCanvasElement>(null);

  const elevationProfile = useMemo<ElevationSample[]>(
    () =>
      analyzedFeatureId ? (sandboxRef.current?.getElevationProfile(analyzedFeatureId) ?? []) : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- featureVersion covers edits to the analyzed path
    [analyzedFeatureId, featureVersion]
  );

  const moveTimeMinutes = useMemo<number | null>(
    () =>
      analyzedFeatureId
        ? (sandboxRef.current?.getMoveTimeMinutes(analyzedFeatureId, moveRate) ?? null)
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- featureVersion covers edits to the analyzed path
    [analyzedFeatureId, moveRate, featureVersion]
  );

  useEffect(() => {
    const canvas = elevationChartRef.current;
    if (!canvas || elevationProfile.length === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);

    const elevations = elevationProfile.map((s) => s.elevationM);
    const minE = Math.min(...elevations);
    const maxE = Math.max(...elevations);
    const range = Math.max(maxE - minE, SANDBOX_WORLD_VIEW.ELEVATION_EPSILON);
    const maxDist = elevationProfile[elevationProfile.length - 1].distanceAlongM;

    const toXY = (s: ElevationSample): [number, number] => [
      (s.distanceAlongM / Math.max(maxDist, SANDBOX_WORLD_VIEW.ELEVATION_EPSILON)) * width,
      height - ((s.elevationM - minE) / range) * height,
    ];

    for (let i = 1; i < elevationProfile.length; i++) {
      const [x0, y0] = toXY(elevationProfile[i - 1]);
      const [x1, y1] = toXY(elevationProfile[i]);
      ctx.strokeStyle = isNoGo(elevationProfile[i].slopePercent) ? '#ef5350' : '#35d4ff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
  }, [elevationProfile]);

  // ---------- route exposure (Wave 4, todo 31 — M2) ----------

  const [exposureThreatId, setExposureThreatId] = useState<string>('');
  const [exposureResult, setExposureResult] = useState<{
    fraction: number;
    sampleCount: number;
  } | null>(null);

  const runExposure = useCallback(() => {
    if (!analyzedFeatureId || !exposureThreatId) return;
    const result = sandboxRef.current?.runRouteExposure(analyzedFeatureId, exposureThreatId);
    setExposureResult(result ?? null);
  }, [analyzedFeatureId, exposureThreatId]);

  const clearExposure = useCallback(() => {
    sandboxRef.current?.clearRouteExposureOverlay();
    setExposureResult(null);
  }, []);

  // Re-running the exposure check when the analyzed feature changes would show a stale
  // overlay for the WRONG path — clear it instead of leaving a mismatched result visible.
  useEffect(() => {
    setExposureResult(null);
    sandboxRef.current?.clearRouteExposureOverlay();
  }, [analyzedFeatureId]);

  // Live camera-pose readout (lon/lat/alt/heading) — this is the metadata a
  // real drone would embed; copy it whenever you take a screenshot.
  useEffect(() => {
    if (!apiKey || loading || fatal) return;
    const timer = window.setInterval(() => {
      const sb = sandboxRef.current;
      if (sb) setPose(sb.getCameraPose());
    }, SANDBOX_WORLD_VIEW.CAMERA_POSE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [apiKey, loading, fatal]);

  useEffect(() => {
    if (!apiKey || loading || fatal || mode !== 'strategist') return;
    const syncBattleState = (): void => {
      const sandbox = sandboxRef.current;
      setBattleSnapshot(sandbox?.getBattleSnapshot?.() ?? null);
      setBattleTerrainSummary(sandbox?.getBattleTerrainSummary?.() ?? null);
    };
    syncBattleState();
    const timer = window.setInterval(syncBattleState, BATTLE_STATE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [apiKey, fatal, loading, mode]);

  const startBattle = useCallback(() => {
    const sandbox = sandboxRef.current;
    if (!sandbox) return;
    try {
      sandbox.setBattleTimeScale?.(battleTimeScale);
      const nextSnapshot = sandbox.startBattleScenario?.(battleScenarioId) ?? null;
      setBattleSnapshot(nextSnapshot);
      if (nextSnapshot) {
        setBattlePlacementFeedback({
          tone: 'success',
          message: `${nextSnapshot.scenarioName} started. Force laydown is now locked.`,
        });
      }
    } catch (error) {
      setBattlePlacementFeedback({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Unable to start this battle scenario.',
      });
    }
  }, [battleScenarioId, battleTimeScale]);

  const toggleBattlePause = useCallback(() => {
    const shouldPause = battleSnapshot?.status.phase === 'running';
    setBattleSnapshot(sandboxRef.current?.setBattlePaused?.(shouldPause) ?? battleSnapshot);
  }, [battleSnapshot]);

  const restartBattle = useCallback(() => {
    setBattleSnapshot(sandboxRef.current?.restartBattle?.() ?? null);
  }, []);

  const stopBattle = useCallback(() => {
    sandboxRef.current?.stopBattle?.();
    setBattleSnapshot(null);
  }, []);

  const setBattleTimeScale = useCallback((scale: number) => {
    setBattleTimeScaleState(scale);
    sandboxRef.current?.setBattleTimeScale?.(scale);
  }, []);

  const retryBattleTerrain = useCallback(async (): Promise<void> => {
    const sandbox = sandboxRef.current;
    if (!sandbox?.retryBattleTerrain) return;
    setBattleTerrainRetrying(true);
    try {
      const summary = await sandbox.retryBattleTerrain();
      setBattleTerrainSummary(summary);
      setBattlePlacementFeedback({
        tone: summary.status === 'ready' ? 'success' : 'info',
        message: summary.message,
      });
    } finally {
      setBattleTerrainRetrying(false);
    }
  }, []);

  const canDeployBattleUnit = useCallback(
    (_unitType: UnitType): boolean => {
      if (loading || battleHasActiveRun) return false;
      return true;
    },
    [battleHasActiveRun, loading]
  );

  const deploymentBlockedMessage = useCallback(
    (_unitType: UnitType): string => {
      if (loading) return 'Deployment held while the 3D operating area is loading.';
      if (battleHasActiveRun) {
        return 'Deployment is locked during a run. Stop the battle before revising the force laydown.';
      }
      return 'Deployment is not available at this location.';
    },
    [battleHasActiveRun, loading]
  );

  const beginBattleUnitDrag = useCallback(
    (event: DragEvent<HTMLButtonElement>, unitType: UnitType): void => {
      if (!canDeployBattleUnit(unitType)) {
        event.preventDefault();
        setBattlePlacementFeedback({
          tone: 'error',
          message: deploymentBlockedMessage(unitType),
        });
        return;
      }
      const payload: BattleDragPayload = { unitType, teamId: battleTeamId };
      event.dataTransfer.effectAllowed = 'copy';
      event.dataTransfer.setData(BATTLE_DRAG_MIME, JSON.stringify(payload));
      event.dataTransfer.setData(
        'text/plain',
        `${BATTLE_TEAM_STYLE[battleTeamId].label} ${unitType}`
      );
      setDraggingBattleUnit(payload);
      setBattleDropAllowed(null);
      setBattlePlacementFeedback({
        tone: 'info',
        message: `Place ${BATTLE_TEAM_STYLE[battleTeamId].label.toLowerCase()} ${unitType} on the 3D terrain.`,
      });
    },
    [battleTeamId, canDeployBattleUnit, deploymentBlockedMessage]
  );

  const finishBattleUnitDrag = useCallback((): void => {
    setDraggingBattleUnit(null);
    setBattleDropAllowed(null);
  }, []);

  const handleCanvasDragOver = useCallback(
    (event: DragEvent<HTMLCanvasElement>): void => {
      const payload = draggingBattleUnit ?? readBattleDragPayload(event);
      if (!payload) return;
      event.preventDefault();
      const allowed = canDeployBattleUnit(payload.unitType);
      event.dataTransfer.dropEffect = allowed ? 'copy' : 'none';
      setBattleDropAllowed(allowed);
    },
    [canDeployBattleUnit, draggingBattleUnit]
  );

  const handleCanvasDragLeave = useCallback((): void => {
    setBattleDropAllowed(null);
  }, []);

  const handleCanvasDrop = useCallback(
    (event: DragEvent<HTMLCanvasElement>): void => {
      const payload = draggingBattleUnit ?? readBattleDragPayload(event);
      if (!payload) return;
      event.preventDefault();
      setDraggingBattleUnit(null);
      setBattleDropAllowed(null);

      if (!canDeployBattleUnit(payload.unitType)) {
        setBattlePlacementFeedback({
          tone: 'error',
          message: deploymentBlockedMessage(payload.unitType),
        });
        return;
      }

      try {
        const result = sandboxRef.current?.placeBattleUnit?.(
          battleScenarioId,
          payload.teamId,
          payload.unitType,
          event.clientX,
          event.clientY
        );
        if (!result) {
          setBattlePlacementFeedback({
            tone: 'error',
            message: 'The battle deployment interface is unavailable in this session.',
          });
          return;
        }
        setBattleSnapshot(result.snapshot);
        setBattleManualUnitCounts((current) => ({
          ...current,
          [result.scenarioId]: result.manualUnitCount,
        }));
        setBattlePlacementFeedback(feedbackFromPlacement(result));
      } catch (error) {
        setBattlePlacementFeedback({
          tone: 'error',
          message: error instanceof Error ? error.message : 'Unable to place this unit.',
        });
      }
    },
    [battleScenarioId, canDeployBattleUnit, deploymentBlockedMessage, draggingBattleUnit]
  );

  const copyPose = (): void => {
    const sb = sandboxRef.current;
    if (!sb) return;
    void navigator.clipboard.writeText(JSON.stringify(sb.getCameraPose(), null, 2));
    setPoseCopied(true);
    window.setTimeout(() => setPoseCopied(false), SANDBOX_WORLD_VIEW.POSE_COPY_RESET_MS);
  };

  const submitKey = (): void => {
    const trimmed = keyDraft.trim();
    if (!trimmed) return;
    setLocalStorageItem(KEY_STORAGE, trimmed);
    setApiKey(trimmed);
  };

  const resetKey = (): void => {
    removeLocalStorageItem(KEY_STORAGE);
    setApiKey(null);
    setFatal(null);
  };

  return (
    <div className="fixed inset-0">
      <canvas
        ref={canvasRef}
        className="block h-full w-full touch-none"
        onDragOver={handleCanvasDragOver}
        onDragLeave={handleCanvasDragLeave}
        onDrop={handleCanvasDrop}
      />

      {draggingBattleUnit && (
        <div
          className={`pointer-events-none fixed inset-3 z-30 flex items-center justify-center rounded-box border-2 border-dashed bg-base-300/15 transition-colors ${
            battleDropAllowed === false
              ? 'border-error/80'
              : battleDropAllowed === true
                ? 'border-primary/90'
                : 'border-white/35'
          }`}
          aria-hidden="true"
        >
          <div className="rounded-box bg-base-100/90 px-5 py-3 text-center shadow-2xl backdrop-blur-md">
            <div className="text-xs font-semibold uppercase tracking-widest">
              {battleDropAllowed === false ? 'Deployment blocked' : 'Place unit on terrain'}
            </div>
            <div className="mt-1 text-sm text-base-content/65">
              {BATTLE_TEAM_STYLE[draggingBattleUnit.teamId].label} ·{' '}
              {BATTLE_UNIT_OPTIONS.find((option) => option.type === draggingBattleUnit.unitType)
                ?.label ?? draggingBattleUnit.unitType}
            </div>
          </div>
        </div>
      )}

      {/* Classification banner (todo 22 invariant 1) — persistent bottom marking, standard
          military marking placement, always visible in strategist mode so a plan is never
          silently unclassified (invariant 2 — default EXERCISE). */}
      {apiKey && !fatal && mode === 'strategist' && (
        <div
          className="fixed inset-x-0 bottom-0 z-50 py-0.5 text-center text-xs font-bold tracking-widest text-white"
          style={{ backgroundColor: CLASSIFICATION_COLOR[classification] }}
        >
          {classification}
        </div>
      )}

      {/* Ground-walk exit affordance (todo 21) — Escape also works; this is for discoverability */}
      {apiKey && !fatal && mode === 'strategist' && tool === 'groundWalk' && (
        <div className="fixed left-1/2 top-20 z-40 -translate-x-1/2">
          <button
            className="btn btn-primary btn-sm shadow-md"
            onClick={() => sandboxRef.current?.exitGroundWalk()}
          >
            <Footprints className="h-4 w-4" /> Exit Ground Walk (Esc)
          </button>
        </div>
      )}

      {/* Strategist left rail — Tools, Features, Plans, in that order:
          draw/measure -> see what you drew -> persist it -> sequence a briefing. Each used
          to be an independently `fixed`-positioned panel with a hardcoded left offset;
          Plans (`left-[28rem]`) and Brief sequence (`left-[34rem]`) genuinely overlapped
          for 6rem because neither offset accounted for the other's rendered width. One
          PanelRail resolves position/height via real CSS flow instead. */}
      {apiKey && !fatal && mode === 'strategist' && (
        <PanelRail side="left">
          <PanelSection title="Tools">
            {TOOLS.map((t) => (
              <button
                key={t.id}
                className={`btn btn-sm justify-start font-normal ${
                  tool === t.id ? 'btn-primary' : 'btn-ghost'
                }`}
                onClick={() => selectTool(t.id)}
              >
                <t.Icon className="h-4 w-4" /> {t.label}
              </button>
            ))}
            <div className="divider my-0" />
            <div className="flex flex-col gap-1 px-2 pb-1">
              <label className="flex flex-col gap-0.5 text-[10px] uppercase tracking-widest text-base-content/40">
                Unit affiliation
                <select
                  className="select select-bordered select-xs font-normal normal-case"
                  value={unitAffiliation}
                  onChange={(e) => selectUnitAffiliation(e.target.value as Affiliation)}
                >
                  {AFFILIATIONS.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-0.5 text-[10px] uppercase tracking-widest text-base-content/40">
                Unit echelon
                <select
                  className="select select-bordered select-xs font-normal normal-case"
                  value={unitEchelon}
                  onChange={(e) => selectUnitEchelon(e.target.value as Echelon)}
                >
                  {ECHELONS.map((e) => (
                    <option key={e} value={e}>
                      {e}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-0.5 text-[10px] uppercase tracking-widest text-base-content/40">
                Range fan system
                <select
                  className="select select-bordered select-xs font-normal normal-case"
                  value={rangeFanSystemId}
                  onChange={(e) => selectRangeFanSystem(e.target.value as SystemId)}
                >
                  {(Object.keys(WEAPON_SYSTEMS) as SystemId[]).map((id) => (
                    <option key={id} value={id}>
                      {WEAPON_SYSTEMS[id].name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="divider my-0" />
            <button
              className="btn btn-ghost btn-sm justify-start font-normal"
              onClick={() => {
                const next = !labelsOn;
                setLabelsOn(next);
                sandboxRef.current?.setLabelsVisible(next);
              }}
            >
              <Tag className="h-4 w-4" /> Labels {labelsOn && <Check className="h-3 w-3" />}
            </button>
            <button
              className="btn btn-ghost btn-sm justify-start font-normal text-error hover:bg-error/10"
              onClick={clearAllFeatures}
            >
              <Trash2 className="h-4 w-4" /> Clear All
            </button>
          </PanelSection>

          <PanelSection title="Battle">
            <div className="mb-1 flex items-start gap-2 rounded-box bg-base-200/70 p-2">
              <Swords className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <div>
                <div className="text-xs font-semibold">Autonomous battle lab</div>
                <div className="text-[10px] leading-snug text-base-content/50">
                  Deterministic 20 Hz tactics with restrained steering, sensing, weapons, and
                  damage.
                </div>
              </div>
            </div>

            <div className="rounded-box border border-white/5 bg-base-300/45 p-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-widest text-base-content/55">
                  Terrain safety
                </span>
                <span
                  className={`badge badge-xs ${
                    battleTerrainSummary?.status === 'ready'
                      ? 'badge-success'
                      : battleTerrainSummary?.status === 'error'
                        ? 'badge-error'
                        : 'badge-warning'
                  }`}
                >
                  {battleTerrainSummary?.status ?? 'loading'}
                </span>
              </div>
              <p className="mt-1 text-[10px] leading-snug text-base-content/55">
                {battleTerrainSummary?.message ?? 'Loading mapped buildings and water…'}
              </p>
              {(battleTerrainSummary?.buildingCount ?? 0) +
                (battleTerrainSummary?.waterCount ?? 0) >
                0 && (
                <div className="mt-1 flex gap-3 font-mono text-[9px] text-base-content/45">
                  <span>{battleTerrainSummary?.buildingCount ?? 0} buildings</span>
                  <span>{battleTerrainSummary?.waterCount ?? 0} water areas</span>
                </div>
              )}
              {battleTerrainSummary?.status !== 'ready' && (
                <div className="mt-1 flex items-start justify-between gap-2">
                  <p className="text-[9px] leading-snug text-warning/90">
                    Limited mode is active. Known buildings and water remain blocked; unmapped space
                    no longer prevents setup or simulation.
                  </p>
                  {battleTerrainSummary?.status === 'error' && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs h-6 shrink-0 px-2 font-normal"
                      disabled={battleTerrainRetrying}
                      onClick={() => void retryBattleTerrain()}
                    >
                      {battleTerrainRetrying ? (
                        <span className="loading loading-spinner loading-xs" />
                      ) : (
                        <RotateCcw className="h-3 w-3" />
                      )}
                      Retry
                    </button>
                  )}
                </div>
              )}
            </div>

            <div className="mt-1 flex items-center justify-between px-1">
              <span className="text-[10px] font-semibold uppercase tracking-widest text-base-content/50">
                Force deployment
              </span>
              <span className="badge badge-ghost badge-xs font-mono">
                {battleManualUnitCounts[battleScenarioId]} placed
              </span>
            </div>

            <div className="grid grid-cols-2 gap-1 px-1" aria-label="Deployment team">
              {BATTLE_TEAM_IDS.map((teamId) => {
                const selected = battleTeamId === teamId;
                const team = BATTLE_TEAM_STYLE[teamId];
                return (
                  <button
                    key={teamId}
                    type="button"
                    className={`btn btn-xs h-7 font-normal ${selected ? 'bg-base-300' : 'btn-ghost'}`}
                    style={{
                      borderColor: selected ? team.color : 'transparent',
                      color: team.color,
                    }}
                    onClick={() => setBattleTeamId(teamId)}
                    disabled={loading || battleHasActiveRun}
                    aria-pressed={selected}
                  >
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: team.color }}
                    />
                    {team.label}
                  </button>
                );
              })}
            </div>

            <div className="grid grid-cols-2 gap-1 px-1">
              {BATTLE_UNIT_OPTIONS.map((unit) => {
                const deploymentAllowed = canDeployBattleUnit(unit.type);
                return (
                  <button
                    key={unit.type}
                    type="button"
                    draggable={deploymentAllowed}
                    disabled={!deploymentAllowed}
                    className="btn h-auto min-h-12 cursor-grab items-start justify-start gap-2 border-white/5 bg-base-200/70 px-2 py-2 text-left font-normal active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-35"
                    onDragStart={(event) => beginBattleUnitDrag(event, unit.type)}
                    onDragEnd={finishBattleUnitDrag}
                    onClick={() =>
                      setBattlePlacementFeedback({
                        tone: 'info',
                        message: `Drag ${unit.label.toLowerCase()} onto the 3D terrain to place it for ${BATTLE_TEAM_STYLE[battleTeamId].label.toLowerCase()}.`,
                      })
                    }
                    title={
                      deploymentAllowed
                        ? `Drag to place ${BATTLE_TEAM_STYLE[battleTeamId].label.toLowerCase()} ${unit.label.toLowerCase()}`
                        : deploymentBlockedMessage(unit.type)
                    }
                  >
                    <unit.Icon
                      className="mt-0.5 h-4 w-4 shrink-0"
                      style={{ color: BATTLE_TEAM_STYLE[battleTeamId].color }}
                    />
                    <span className="min-w-0">
                      <span className="block text-[10px] font-semibold">{unit.label}</span>
                      <span className="block truncate text-[9px] text-base-content/40">
                        {unit.role}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="px-1 text-[9px] leading-snug text-base-content/40">
              Drag units onto clear terrain. Movement follows terrain-aware, bounded steering;
              deployment locks when the run begins.
            </p>
            <p className="px-1 text-[9px] leading-snug text-base-content/40">
              Imported detections can be linked here from Intel Import using{' '}
              <span className="font-medium text-base-content/60">Add to battle</span>.
            </p>

            {battlePlacementFeedback && (
              <div
                className={`mx-1 rounded border-l-2 px-2 py-1 text-[10px] leading-snug ${
                  battlePlacementFeedback.tone === 'success'
                    ? 'border-success bg-success/10 text-success'
                    : battlePlacementFeedback.tone === 'error'
                      ? 'border-error bg-error/10 text-error'
                      : 'border-info bg-info/10 text-info'
                }`}
                role={battlePlacementFeedback.tone === 'error' ? 'alert' : 'status'}
                aria-live="polite"
              >
                {battlePlacementFeedback.message}
              </div>
            )}

            <label className="flex flex-col gap-1 px-1 text-[10px] uppercase tracking-widest text-base-content/50">
              Scenario template
              <select
                className="select select-bordered select-sm font-normal normal-case"
                value={battleScenarioId}
                onChange={(event) => setBattleScenarioId(event.target.value as BattleScenarioId)}
                disabled={loading || battleHasActiveRun}
              >
                {BATTLE_SCENARIO_OPTIONS.map((scenario) => (
                  <option key={scenario.id} value={scenario.id}>
                    {scenario.label}
                  </option>
                ))}
              </select>
            </label>
            <p className="px-1 pb-1 text-[10px] leading-snug text-base-content/45">
              {BATTLE_SCENARIO_OPTIONS.find((scenario) => scenario.id === battleScenarioId)
                ?.description ?? ''}
            </p>

            <div className="grid grid-cols-2 gap-1 px-1">
              <button
                className="btn btn-primary btn-sm font-normal"
                onClick={startBattle}
                disabled={!canRunBattle}
                title={
                  battleHasActiveRun
                    ? 'A battle is already running'
                    : loading
                      ? 'The operating area is still loading'
                      : battleTerrainReady
                        ? 'Run the selected scenario with mapped terrain safety'
                        : 'Run with limited coverage; known mapped obstacles still block units'
                }
              >
                <Swords className="h-3.5 w-3.5" /> Run
              </button>
              <button
                className="btn btn-ghost btn-sm font-normal"
                onClick={toggleBattlePause}
                disabled={
                  battleSnapshot?.status.phase !== 'running' &&
                  battleSnapshot?.status.phase !== 'paused'
                }
              >
                {battleSnapshot?.status.phase === 'paused' ? (
                  <Play className="h-3.5 w-3.5" />
                ) : (
                  <Pause className="h-3.5 w-3.5" />
                )}
                {battleSnapshot?.status.phase === 'paused' ? 'Resume' : 'Pause'}
              </button>
              <button
                className="btn btn-ghost btn-sm font-normal"
                onClick={restartBattle}
                disabled={!battleSnapshot}
              >
                <RotateCcw className="h-3.5 w-3.5" /> Restart
              </button>
              <button
                className="btn btn-ghost btn-sm font-normal text-error"
                onClick={stopBattle}
                disabled={!battleSnapshot}
              >
                <Square className="h-3.5 w-3.5" /> Stop
              </button>
            </div>

            <div className="mt-1 flex items-center justify-between px-1">
              <span className="text-[10px] uppercase tracking-widest text-base-content/40">
                Speed
              </span>
              <div className="join">
                {BATTLE_TIME_SCALES.map((scale) => (
                  <button
                    key={scale}
                    className={`btn join-item btn-xs min-h-0 h-6 px-2 font-normal ${
                      battleTimeScale === scale ? 'btn-primary' : 'btn-ghost'
                    }`}
                    onClick={() => setBattleTimeScale(scale)}
                    aria-pressed={battleTimeScale === scale}
                  >
                    {scale}x
                  </button>
                ))}
              </div>
            </div>

            {battleSnapshot ? (
              <div className="mt-2 flex flex-col gap-2 rounded-box border border-white/5 bg-base-300/55 p-2">
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={`badge badge-sm ${
                      battleSnapshot.status.phase === 'victory'
                        ? 'badge-success'
                        : battleSnapshot.status.phase === 'draw'
                          ? 'badge-warning'
                          : battleSnapshot.status.phase === 'paused'
                            ? 'badge-ghost'
                            : 'badge-primary'
                    }`}
                  >
                    {battleStatusLabel(battleSnapshot)}
                  </span>
                  <span className="font-mono text-[10px] text-base-content/55">
                    T+{battleSnapshot.timeSeconds.toFixed(1)}s · #{battleSnapshot.tick}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-1">
                  {battleSnapshot.teams.map((team) => (
                    <div
                      key={team.id}
                      className="rounded border-l-2 bg-base-200/75 px-2 py-1"
                      style={{ borderLeftColor: team.color }}
                    >
                      <div className="truncate text-[10px] font-semibold">{team.name}</div>
                      <div className="font-mono text-[10px] text-base-content/55">
                        {team.aliveUnits}/{team.totalUnits} active
                      </div>
                    </div>
                  ))}
                </div>

                <div>
                  <div className="mb-1 text-[9px] uppercase tracking-widest text-base-content/35">
                    Combat feed
                  </div>
                  <div className="flex flex-col gap-1" aria-live="polite">
                    {[...battleSnapshot.events]
                      .slice(-BATTLE_EVENT_FEED_LIMIT)
                      .reverse()
                      .map((event) => (
                        <div
                          key={event.id}
                          className="border-l border-white/10 pl-2 text-[9px] leading-snug text-base-content/60"
                        >
                          <span className="mr-1 font-mono text-base-content/35">
                            {event.timeSeconds.toFixed(1)}
                          </span>
                          {event.message}
                        </div>
                      ))}
                    {battleSnapshot.events.length === 0 && (
                      <div className="text-[9px] text-base-content/35">Awaiting first contact…</div>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="px-2 py-2 text-[10px] leading-snug text-base-content/40">
                Deploy your own forces or choose an example, then run it. Each restart replays the
                same seeded decisions.
              </div>
            )}
          </PanelSection>

          <PanelSection
            title={`Features (${features.length})`}
            actions={
              <button
                className="btn btn-ghost btn-xs font-normal disabled:opacity-30"
                onClick={undoLastFeature}
                disabled={features.length === 0}
                aria-label="Undo last placed feature"
              >
                <Undo2 className="h-3.5 w-3.5" /> Undo
              </button>
            }
          >
            {features.length === 0 && (
              <div className="px-2 py-1 text-xs text-base-content/40">No features placed yet</div>
            )}
            {features.map((f) => (
              <div
                key={f.id}
                className={`flex items-center gap-1 rounded px-1 py-0.5 ${
                  selectedFeatureId === f.id ? 'bg-primary/10' : ''
                }`}
              >
                {renamingId === f.id ? (
                  <input
                    autoFocus
                    aria-label={`Rename ${f.name}`}
                    className="input input-bordered input-xs flex-1"
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename(f.id);
                      if (e.key === 'Escape') setRenamingId(null);
                    }}
                    onBlur={() => commitRename(f.id)}
                  />
                ) : (
                  <button
                    className="btn btn-ghost btn-xs flex-1 flex-col items-start justify-start truncate font-normal"
                    onClick={() => selectFeatureRow(f.id)}
                    aria-pressed={selectedFeatureId === f.id}
                    title={[
                      f.mgrs ? `${f.name} — ${f.mgrs}` : f.name,
                      f.provenance
                        ? `by ${f.provenance.author} at ${f.provenance.createdAt}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join('\n')}
                  >
                    <span className="truncate">
                      <span className="text-[10px] uppercase text-base-content/40">{f.type}</span>{' '}
                      {f.name}
                    </span>
                    {f.mgrs && (
                      <span className="font-mono text-[9px] text-base-content/40">{f.mgrs}</span>
                    )}
                  </button>
                )}
                {renamingId !== f.id && phases.length > 0 && (
                  <select
                    aria-label={`Phase for ${f.name}`}
                    className="select select-bordered select-xs w-20 font-normal normal-case"
                    value={sandboxRef.current?.getFeaturePhase(f.id) ?? ALL_PHASES}
                    onChange={(e) => selectFeaturePhase(f.id, e.target.value)}
                  >
                    <option value={ALL_PHASES}>All</option>
                    {phases.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                )}
                {renamingId !== f.id && f.type === 'unit' && phases.length > 0 && (
                  <button
                    className={`btn btn-xs px-1 font-normal ${
                      armedFeatureId === f.id ? 'btn-primary' : 'btn-ghost'
                    }`}
                    onClick={() => {
                      const phaseId = phases[timelineState.currentIndex]?.id;
                      if (phaseId) armSetUnitPosition(f.id, phaseId);
                    }}
                    title={`Click the map to set this unit's position for "${phases[timelineState.currentIndex]?.name ?? ''}"`}
                    aria-label={`Set position for ${f.name} at current timeline phase`}
                  >
                    <MapPin className="h-3.5 w-3.5" />
                  </button>
                )}
                {renamingId !== f.id && sandboxRef.current?.isPathFeature(f.id) && (
                  <button
                    className={`btn btn-xs px-1 font-normal ${
                      analyzedFeatureId === f.id ? 'btn-primary' : 'btn-ghost'
                    }`}
                    onClick={() => setAnalyzedFeatureId((prev) => (prev === f.id ? null : f.id))}
                    aria-label={`Analyze ${f.name}`}
                    title="Elevation profile + move-time analysis"
                  >
                    <Mountain className="h-3.5 w-3.5" />
                  </button>
                )}
                {renamingId !== f.id && (
                  <>
                    <button
                      className="btn btn-ghost btn-xs px-1 font-normal"
                      onClick={() => startRename(f)}
                      aria-label={`Rename ${f.name}`}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      className="btn btn-ghost btn-xs px-1 font-normal text-error"
                      onClick={() => deleteFeature(f.id)}
                      aria-label={`Delete ${f.name}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </>
                )}
              </div>
            ))}
          </PanelSection>

          <PanelSection title="Plans">
            <label className="flex flex-col gap-0.5 px-2 text-[10px] uppercase tracking-widest text-base-content/40">
              Classification
              <select
                className="select select-bordered select-xs font-normal normal-case"
                value={classification}
                onChange={(e) => selectClassification(e.target.value as ClassificationLevel)}
              >
                {CLASSIFICATION_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex gap-1 px-2">
              <input
                aria-label="Plan name"
                className="input input-bordered input-xs flex-1"
                placeholder="COY ATTACK"
                value={planNameDraft}
                onChange={(e) => setPlanNameDraft(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && savePlan()}
              />
              <button
                className="btn btn-primary btn-xs disabled:opacity-30"
                onClick={savePlan}
                disabled={!planNameDraft.trim()}
                aria-label="Save plan"
              >
                <Save className="h-3.5 w-3.5" />
              </button>
            </div>
            {plans.length === 0 && (
              <div className="px-2 py-1 text-xs text-base-content/40">No saved plans yet</div>
            )}
            {plans.map((p) => (
              <div key={p.id} className="flex items-center gap-1 rounded px-1 py-0.5">
                <button
                  className="btn btn-ghost btn-xs flex-1 justify-start truncate font-normal"
                  onClick={() => loadPlan(p.id)}
                  title={`Load "${p.name}" (${p.features.length} features)`}
                >
                  {p.name}
                </button>
                <button
                  className="btn btn-ghost btn-xs px-1 font-normal text-error"
                  onClick={() => deletePlan(p.id)}
                  aria-label={`Delete plan ${p.name}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            <div className="divider my-1" />
            <div className="px-2 text-[10px] font-semibold uppercase tracking-widest text-base-content/40">
              Phases ({phases.length})
            </div>
            <div className="flex gap-1 px-2">
              <input
                aria-label="Phase name"
                className="input input-bordered input-xs flex-1"
                placeholder="Move to FUP"
                value={phaseNameDraft}
                onChange={(e) => setPhaseNameDraft(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addPhase()}
              />
              <button
                className="btn btn-primary btn-xs disabled:opacity-30"
                onClick={addPhase}
                disabled={!phaseNameDraft.trim()}
                aria-label="Add phase"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
            {phases.length === 0 && (
              <div className="px-2 py-1 text-xs text-base-content/40">No phases defined yet</div>
            )}
            {phases.map((p, i) => (
              <div key={p.id} className="flex items-center gap-1 rounded px-1 py-0.5">
                <span className="text-[10px] text-base-content/40">{i + 1}</span>
                {renamingPhaseId === p.id ? (
                  <input
                    autoFocus
                    aria-label={`Rename ${p.name}`}
                    className="input input-bordered input-xs flex-1"
                    value={renamePhaseDraft}
                    onChange={(e) => setRenamePhaseDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRenamePhase(p.id);
                      if (e.key === 'Escape') setRenamingPhaseId(null);
                    }}
                    onBlur={() => commitRenamePhase(p.id)}
                  />
                ) : (
                  <button
                    className="btn btn-ghost btn-xs flex-1 justify-start truncate font-normal"
                    onClick={() => startRenamePhase(p)}
                    aria-label={`Rename ${p.name}`}
                  >
                    {p.name}
                  </button>
                )}
                <button
                  className="btn btn-ghost btn-xs px-1 font-normal disabled:opacity-20"
                  onClick={() => movePhase(p.id, -1)}
                  disabled={i === 0}
                  aria-label={`Move ${p.name} earlier`}
                >
                  <ChevronUp className="h-3.5 w-3.5" />
                </button>
                <button
                  className="btn btn-ghost btn-xs px-1 font-normal disabled:opacity-20"
                  onClick={() => movePhase(p.id, 1)}
                  disabled={i === phases.length - 1}
                  aria-label={`Move ${p.name} later`}
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
                <button
                  className="btn btn-ghost btn-xs px-1 font-normal text-error"
                  onClick={() => deletePhase(p.id)}
                  aria-label={`Delete phase ${p.name}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            {phases.length > 0 && (
              <label className="flex flex-col gap-0.5 px-2 pb-1 text-[10px] uppercase tracking-widest text-base-content/40">
                Show phase
                <select
                  className="select select-bordered select-xs font-normal normal-case"
                  value={phaseFilter}
                  onChange={(e) => selectPhaseFilter(e.target.value)}
                >
                  <option value={ALL_PHASES}>All phases</option>
                  {phases.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {phases.length > 1 && (
              <div className="flex flex-col gap-0.5 px-2 pb-1">
                <span className="text-[10px] uppercase tracking-widest text-base-content/40">
                  Timeline
                </span>
                <input
                  type="range"
                  aria-label="Timeline scrubber"
                  className="range range-primary range-xs"
                  min={0}
                  max={phases.length - 1}
                  value={timelineState.currentIndex}
                  onChange={(e) => scrubTimeline(Number(e.target.value))}
                />
                <div className="flex items-center justify-between">
                  <button
                    className="btn btn-ghost btn-xs px-1 font-normal disabled:opacity-20"
                    onClick={() => stepTimeline(-1)}
                    disabled={timelineState.currentIndex <= 0}
                    aria-label="Step to previous phase"
                  >
                    <SkipBack className="h-3.5 w-3.5" />
                  </button>
                  <span className="text-[10px] text-base-content/60">
                    {phases[timelineState.currentIndex]?.name ?? ''}
                    {timelineState.isPlaying ? ' ▶' : ''}
                  </span>
                  <button
                    className="btn btn-ghost btn-xs px-1 font-normal disabled:opacity-20"
                    onClick={() => stepTimeline(1)}
                    disabled={timelineState.currentIndex >= phases.length - 1}
                    aria-label="Step to next phase"
                  >
                    <SkipForward className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            )}

            <div className="divider my-1" />
            <div className="px-2 text-[10px] font-semibold uppercase tracking-widest text-base-content/40">
              Brief sequence
            </div>
            <div className="flex gap-1 px-2">
              <input
                aria-label="Viewpoint name"
                className="input input-bordered input-xs flex-1"
                placeholder="Line of departure"
                value={viewpointNameDraft}
                onChange={(e) => setViewpointNameDraft(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && saveViewpoint()}
              />
              <button
                className="btn btn-primary btn-xs disabled:opacity-30"
                onClick={saveViewpoint}
                disabled={!viewpointNameDraft.trim()}
                aria-label="Save current view as a viewpoint"
              >
                <MapPin className="h-3.5 w-3.5" />
              </button>
            </div>
            {viewpoints.length === 0 && (
              <div className="px-2 py-1 text-xs text-base-content/40">No viewpoints saved yet</div>
            )}
            {viewpoints.map((v, i) => (
              <div key={v.id} className="flex items-center gap-1 rounded px-1 py-0.5">
                <span className="text-[10px] text-base-content/40">{i + 1}</span>
                <button
                  className="btn btn-ghost btn-xs flex-1 justify-start truncate font-normal"
                  onClick={() => sandboxRef.current?.restoreViewpoint(v.id)}
                  title={`Jump to "${v.name}"`}
                >
                  {v.name}
                </button>
                {phases.length > 0 && (
                  <select
                    aria-label={`Phase for ${v.name}`}
                    className="select select-bordered select-xs w-20 font-normal normal-case"
                    value={v.phaseId ?? ALL_PHASES}
                    onChange={(e) => selectViewpointPhase(v.id, e.target.value)}
                  >
                    <option value={ALL_PHASES}>—</option>
                    {phases.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                )}
                <button
                  className="btn btn-ghost btn-xs px-1 font-normal disabled:opacity-20"
                  onClick={() => moveViewpoint(v.id, -1)}
                  disabled={i === 0}
                  aria-label={`Move ${v.name} earlier`}
                >
                  <ChevronUp className="h-3.5 w-3.5" />
                </button>
                <button
                  className="btn btn-ghost btn-xs px-1 font-normal disabled:opacity-20"
                  onClick={() => moveViewpoint(v.id, 1)}
                  disabled={i === viewpoints.length - 1}
                  aria-label={`Move ${v.name} later`}
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
                <button
                  className="btn btn-ghost btn-xs px-1 font-normal text-error"
                  onClick={() => sandboxRef.current?.deleteViewpoint(v.id)}
                  aria-label={`Delete viewpoint ${v.name}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            {viewpoints.length > 0 && (
              <>
                <div className="divider my-0" />
                <div className="flex items-center justify-between px-2 pb-1">
                  <button
                    className="btn btn-ghost btn-xs px-1 font-normal disabled:opacity-20"
                    onClick={() => sandboxRef.current?.playBriefPrevious()}
                    disabled={briefState.currentIndex <= 0}
                    aria-label="Previous viewpoint"
                  >
                    <SkipBack className="h-3.5 w-3.5" />
                  </button>
                  <span className="text-[10px] text-base-content/60">
                    {briefState.currentIndex + 1} / {viewpoints.length}
                    {briefState.isPlaying ? ' ▶' : ''}
                  </span>
                  <button
                    className="btn btn-ghost btn-xs px-1 font-normal disabled:opacity-20"
                    onClick={() => sandboxRef.current?.playBriefNext()}
                    disabled={briefState.currentIndex >= viewpoints.length - 1}
                    aria-label="Next viewpoint"
                  >
                    <SkipForward className="h-3.5 w-3.5" />
                  </button>
                </div>
              </>
            )}
          </PanelSection>

          {viewpoints.length > 0 && (
            <PanelSection title="Rehearse">
              <div className="flex items-center justify-between px-2 pb-1">
                <button
                  className="btn btn-ghost btn-xs px-1 font-normal"
                  onClick={() => sandboxRef.current?.cancelRehearsal()}
                  aria-label="Stop rehearsal"
                >
                  <Square className="h-3.5 w-3.5" />
                </button>
                <span className="text-[10px] text-base-content/60">
                  {briefState.currentIndex + 1} / {viewpoints.length}
                  {rehearsing ? ' — rehearsing' : ''}
                </span>
                <button
                  className="btn btn-primary btn-xs px-1 font-normal"
                  onClick={() =>
                    rehearsing
                      ? sandboxRef.current?.pauseRehearsal()
                      : sandboxRef.current?.startRehearsal()
                  }
                  aria-label={rehearsing ? 'Pause rehearsal' : 'Start rehearsal'}
                >
                  {rehearsing ? (
                    <Pause className="h-3.5 w-3.5" />
                  ) : (
                    <Play className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
            </PanelSection>
          )}

          {analyzedFeatureId && (
            <PanelSection title="Analysis">
              {elevationProfile.length > 0 ? (
                <>
                  <canvas
                    ref={elevationChartRef}
                    width={272}
                    height={90}
                    className="mx-2 rounded bg-base-300"
                    aria-label="Elevation profile chart"
                  />
                  <div className="px-2 text-[9px] text-base-content/40">
                    Sampled every {ELEVATION_SAMPLE_SPACING_M}m from streamed 3D-tile geometry —
                    vegetation/structures not modelled. Red = past {SLOPE_NOGO_THRESHOLD_PERCENT}%
                    slope.
                  </div>
                </>
              ) : (
                <div className="px-2 py-1 text-xs text-base-content/40">
                  No terrain samples along this path (off the loaded tile area?)
                </div>
              )}
              <div className="divider my-0" />
              <label className="flex flex-col gap-0.5 px-2 pb-1 text-[10px] uppercase tracking-widest text-base-content/40">
                Move rate
                <select
                  className="select select-bordered select-xs font-normal normal-case"
                  value={moveRate}
                  onChange={(e) => setMoveRate(e.target.value as MoveRate)}
                >
                  {(Object.keys(MOVE_RATES_KMH) as MoveRate[]).map((rate) => (
                    <option key={rate} value={rate}>
                      {rate} ({MOVE_RATES_KMH[rate]} km/h)
                    </option>
                  ))}
                </select>
              </label>
              {moveTimeMinutes !== null && (
                <div className="px-2 pb-1 text-xs">
                  Estimated move time: <strong>{moveTimeMinutes.toFixed(0)} min</strong>{' '}
                  <span className="text-[9px] text-base-content/40">
                    (assumed {moveRate} rate — {MOVE_RATES_KMH[moveRate]} km/h)
                  </span>
                </div>
              )}
              {features.some((f) => f.type === 'unit') && (
                <>
                  <div className="divider my-0" />
                  <label className="flex flex-col gap-0.5 px-2 text-[10px] uppercase tracking-widest text-base-content/40">
                    Threat unit
                    <select
                      className="select select-bordered select-xs font-normal normal-case"
                      value={exposureThreatId}
                      onChange={(e) => setExposureThreatId(e.target.value)}
                    >
                      <option value="">— select —</option>
                      {features
                        .filter((f) => f.type === 'unit')
                        .map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <div className="flex gap-1 px-2 pb-1 pt-1">
                    <button
                      className="btn btn-xs flex-1 border-none bg-base-300 disabled:opacity-30"
                      onClick={runExposure}
                      disabled={!exposureThreatId}
                    >
                      Run Exposure
                    </button>
                    <button
                      className="btn btn-ghost btn-xs"
                      onClick={clearExposure}
                      aria-label="Clear exposure overlay"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  {exposureResult && (
                    <div className="px-2 pb-1 text-xs">
                      <strong>
                        {(exposureResult.fraction * SANDBOX_COMMON.PERCENT_MULTIPLIER).toFixed(0)}%
                      </strong>{' '}
                      of route exposed{' '}
                      <span className="text-[9px] text-base-content/40">
                        (computed from {features.find((f) => f.id === exposureThreatId)?.name}
                        &apos;s position,
                        {exposureResult.sampleCount} samples every {ELEVATION_SAMPLE_SPACING_M}
                        m)
                      </span>
                    </div>
                  )}
                </>
              )}
            </PanelSection>
          )}
        </PanelRail>
      )}

      {/* Player vehicle switcher */}
      {apiKey && !fatal && mode === 'player' && (
        <PanelRail side="left">
          {VEHICLES.map((v) => (
            <button
              key={v.id}
              className="btn btn-ghost btn-sm justify-start font-normal"
              onClick={() => {
                sandboxRef.current?.switchVehicle(v.id);
                setActiveVehicle(v.id);
              }}
            >
              <kbd className="kbd kbd-xs">{v.key}</kbd> {v.Icon && <v.Icon className="h-4 w-4" />}{' '}
              {v.label}
            </button>
          ))}
          <div className="px-2 pb-1 text-[10px] text-base-content/40">
            {activeVehicle === 'jet'
              ? 'Q/E roll · SHIFT boost · B bomb'
              : 'WASD drive · SPACE fire'}
          </div>
        </PanelRail>
      )}

      {/* Status bar */}
      {apiKey && !fatal && (
        <div className="fixed bottom-8 left-1/2 z-40 -translate-x-1/2">
          <div className="rounded-box max-w-[80vw] truncate bg-base-100 px-4 py-2 text-sm text-base-content/80 shadow-md">
            {mode === 'strategist'
              ? status || TOOL_HINTS[tool]
              : activeVehicle === 'jet'
                ? 'W/S throttle · A/D yaw · ↑↓ pitch · Q/E barrel roll · SHIFT afterburner · B bomb · SPACE guns · TAB strategist'
                : activeVehicle === 'spider'
                  ? '🕸 SHIFT+W sprint · SPACE jump/swing · W dive · A/D steer · SHIFT zip · E web-pull · swing INTO a wall to run it (W climb, A/D traverse) · F web-fling'
                  : 'WASD = drive · SPACE = fire · drag = orbit · TAB = strategist'}
          </div>
        </div>
      )}

      {/* HUD */}
      {apiKey && !fatal && hudLines.length > 0 && (
        <div className="rounded-box fixed bottom-8 right-4 z-40 bg-base-100 px-4 py-2 text-right font-mono text-sm shadow-md">
          {hudLines.map((line, i) => (
            <div key={line} className={i === 0 ? 'font-bold text-primary' : ''}>
              {line}
            </div>
          ))}
        </div>
      )}

      {/* Camera pose readout + intel import (top-right) */}
      {apiKey && !fatal && !loading && pose && (
        <PanelRail side="right">
          <div className="rounded-box bg-base-100 px-3 py-2 font-mono text-xs shadow-md">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-base-content/40">
              Camera pose
            </div>
            <div>
              lat {pose.camera.geo.lat.toFixed(SANDBOX_WORLD_VIEW.CAMERA_POSE_DECIMALS)} lon{' '}
              {pose.camera.geo.lon.toFixed(SANDBOX_WORLD_VIEW.CAMERA_POSE_DECIMALS)}
            </div>
            <div>
              alt {pose.camera.geo.altM.toFixed(0)} m · hdg {pose.camera.geo.headingDeg.toFixed(1)}°
              · pitch {pose.camera.geo.pitchDeg.toFixed(1)}° · fov {pose.camera.fovDeg.toFixed(0)}°
            </div>
          </div>
          <div className="grid grid-cols-2 gap-1">
            <button
              className="btn btn-sm w-full min-w-0 bg-base-100 px-2 shadow-md"
              onClick={() => sandboxRef.current?.captureShot()}
              title="Download a clean tiles-only PNG + matching pose JSON"
            >
              <Camera className="h-4 w-4" /> Capture
            </button>
            <button
              className="btn btn-sm w-full min-w-0 bg-base-100 px-2 shadow-md"
              onClick={copyPose}
            >
              {poseCopied ? (
                <>
                  <Check className="h-4 w-4" /> Copied
                </>
              ) : (
                <>
                  <Clipboard className="h-4 w-4" /> Copy pose
                </>
              )}
            </button>
            <button
              className="btn btn-primary btn-sm w-full min-w-0 px-2 shadow-md"
              onClick={() => setShowImport(true)}
            >
              <Import className="h-4 w-4" /> Import intel
            </button>
            <button
              className="btn btn-sm w-full min-w-0 bg-base-100 px-2 text-error shadow-md"
              onClick={() => sandboxRef.current?.clearDetections()}
              title="Remove deployed detections"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        </PanelRail>
      )}

      {/* Intel import modal */}
      {showImport && (
        <Suspense fallback={<IntelImportFallback />}>
          <modalComponents.IntelImport
            currentPose={pose}
            onDeploy={(p, anns, img, provenance) =>
              sandboxRef.current
                ? sandboxRef.current.deployFromImage(p, anns, img, provenance)
                : { detections: [], projectedContacts: [], placed: 0, failed: anns.length }
            }
            onAddToBattle={(contacts, assignment) => {
              const result = sandboxRef.current?.addIntelToBattle(
                battleScenarioId,
                assignment,
                contacts
              );
              if (!result) {
                return {
                  acceptedIds: [],
                  duplicateIds: [],
                  held: contacts.map((contact) => ({
                    detectionId: contact.detection.detection_id,
                    reason: 'Battle controller is unavailable.',
                  })),
                  deploymentCount: battleManualUnitCounts[battleScenarioId],
                  snapshot: battleSnapshot,
                  message: 'Battle controller is unavailable.',
                };
              }
              setBattleSnapshot(result.snapshot);
              setBattleManualUnitCounts((current) => ({
                ...current,
                [battleScenarioId]: result.deploymentCount,
              }));
              setBattlePlacementFeedback({
                tone: result.acceptedIds.length > 0 ? 'success' : 'error',
                message: result.message,
              });
              return result;
            }}
            onClose={() => setShowImport(false)}
          />
        </Suspense>
      )}

      {/* Google imagery and OSM semantics are distinct sources with separate attribution. */}
      <div
        className={`fixed left-2 z-40 flex max-w-[70vw] items-center gap-1.5 truncate text-[10px] text-white/75 [text-shadow:0_0_2px_#000] ${
          mode === 'strategist' ? 'bottom-5' : 'bottom-1'
        }`}
      >
        <span className="truncate">{attributions}</span>
        <span aria-hidden="true">·</span>
        <a
          className="shrink-0 underline decoration-white/40 underline-offset-2 hover:text-white"
          href="https://www.openstreetmap.org/copyright"
          target="_blank"
          rel="noreferrer"
        >
          © OpenStreetMap contributors
        </a>
      </div>

      {/* Loading */}
      {apiKey && !fatal && loading && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-base-200/80">
          <div className="rounded-box flex items-center gap-3 bg-base-100 px-6 py-4 shadow-md">
            <span className="loading loading-spinner text-primary" />
            <span className="text-sm">Streaming Google Photorealistic 3D Tiles…</span>
          </div>
        </div>
      )}

      {/* Fatal error */}
      {fatal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-base-200/80">
          <div className="rounded-box max-w-md bg-base-100 p-6 text-center shadow-md">
            <div className="mb-2 text-lg font-semibold text-error">Tile service error</div>
            <p className="mb-4 text-sm text-base-content/70">{fatal}</p>
            <button className="btn btn-primary btn-sm" onClick={resetKey}>
              Reset API key
            </button>
          </div>
        </div>
      )}

      {/* API key prompt */}
      {!apiKey && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-base-200">
          <div className="rounded-box w-full max-w-lg bg-base-100 p-8 shadow-md">
            <div className="mb-1 flex items-center gap-2 text-xl font-bold">
              <Satellite className="h-5 w-5" /> Google Map Tiles API key
            </div>
            <p className="mb-4 text-sm text-base-content/60">
              Enable <b>Map Tiles API</b> in Google Cloud Console, create an API key, and paste it
              here. Stored only in this browser&apos;s localStorage.
            </p>
            <div className="flex gap-2">
              <input
                className="input input-bordered flex-1 font-mono text-sm"
                placeholder="AIza..."
                value={keyDraft}
                spellCheck={false}
                onChange={(e) => setKeyDraft(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submitKey()}
              />
              <button className="btn btn-primary" onClick={submitKey}>
                Start
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
