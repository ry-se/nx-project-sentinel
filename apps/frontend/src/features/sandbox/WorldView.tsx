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
  Eye,
  Flag,
  Footprints,
  Gamepad2,
  Import,
  type LucideIcon,
  Map,
  MapPin,
  MousePointer2,
  Pause,
  Pencil,
  Plane,
  Play,
  Plus,
  Radar,
  Ruler,
  Satellite,
  Save,
  SkipBack,
  SkipForward,
  Square,
  SquareDashed,
  Tag,
  Target,
  Trash2,
  Undo2,
  Waves,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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
import { ALL_PHASES } from './engine/planFeature';
import type { Plan, PlanPhase } from './engine/planStore';
import type { Viewpoint } from './engine/viewpoint';
import { getStoredSpawnKey, SPAWN_LOCATIONS } from './spawnLocations';
import { type FeatureSummary, type StratTool, TOOL_HINTS } from './engine/strategist';
import type { Affiliation, Echelon } from './engine/unitSymbol';
import type { VehicleType } from './engine/vehicles';
import { IntelImport } from './IntelImport';
import { PanelRail } from './ui/PanelRail';
import { PanelSection } from './ui/PanelSection';

const KEY_STORAGE = 'google_tiles_key';

// SPAWN_LOCATIONS imported from shared module

const TOOLS: Array<{ id: StratTool; label: string; Icon: LucideIcon }> = [
  { id: 'select', label: 'Select', Icon: MousePointer2 },
  { id: 'distance', label: 'Distance', Icon: Ruler },
  { id: 'focus', label: 'Focus Area', Icon: Target },
  { id: 'arc', label: 'Fire Arc', Icon: Compass },
  { id: 'los', label: 'Line of Sight', Icon: Eye },
  { id: 'viewshed', label: 'Viewshed', Icon: Radar },
  { id: 'boundary', label: 'Boundary', Icon: SquareDashed },
  { id: 'phaseline', label: 'Phase Line', Icon: Waves },
  { id: 'loa', label: 'Limit of Adv.', Icon: Ban },
  { id: 'axis', label: 'Axis of Adv.', Icon: ArrowRight },
  { id: 'objective', label: 'Objective', Icon: Flag },
  { id: 'symbol', label: 'Unit Symbol', Icon: Square },
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
  return env ?? localStorage.getItem(KEY_STORAGE);
}

export function WorldView() {
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
  const [mgrsHudOn, setMgrsHudOn] = useState(true);
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
    const canvas = canvasRef.current;
    if (!apiKey || !canvas) return;

    let cancelled = false;
    let sandbox: Sandbox | null = null;
    setLoading(true);
    setFatal(null);

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
    }, 200);
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
    }, 200);
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
    }, 200);
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
    }, 200);
    return () => window.clearInterval(timer);
  }, [apiKey, loading, fatal, mode]);

  // Live camera-pose readout (lon/lat/alt/heading) — this is the metadata a
  // real drone would embed; copy it whenever you take a screenshot.
  useEffect(() => {
    if (!apiKey || loading || fatal) return;
    const timer = window.setInterval(() => {
      const sb = sandboxRef.current;
      if (sb) setPose(sb.getCameraPose());
    }, 500);
    return () => window.clearInterval(timer);
  }, [apiKey, loading, fatal]);

  const copyPose = (): void => {
    const sb = sandboxRef.current;
    if (!sb) return;
    void navigator.clipboard.writeText(JSON.stringify(sb.getCameraPose(), null, 2));
    setPoseCopied(true);
    window.setTimeout(() => setPoseCopied(false), 1500);
  };

  const submitKey = (): void => {
    const trimmed = keyDraft.trim();
    if (!trimmed) return;
    localStorage.setItem(KEY_STORAGE, trimmed);
    setApiKey(trimmed);
  };

  const resetKey = (): void => {
    localStorage.removeItem(KEY_STORAGE);
    setApiKey(null);
    setFatal(null);
  };

  return (
    <div className="fixed inset-0">
      <canvas ref={canvasRef} className="block h-full w-full touch-none" />

      {/* Classification banner (todo 22 invariant 1) — persistent top + bottom, standard
          military marking placement, always visible in strategist mode so a plan is never
          silently unclassified (invariant 2 — default EXERCISE). */}
      {apiKey && !fatal && mode === 'strategist' && (
        <>
          <div
            className="fixed inset-x-0 top-0 z-50 py-0.5 text-center text-xs font-bold tracking-widest text-white"
            style={{ backgroundColor: CLASSIFICATION_COLOR[classification] }}
          >
            {classification}
          </div>
          <div
            className="fixed inset-x-0 bottom-0 z-50 py-0.5 text-center text-xs font-bold tracking-widest text-white"
            style={{ backgroundColor: CLASSIFICATION_COLOR[classification] }}
          >
            {classification}
          </div>
        </>
      )}

      {/* Mode badge */}
      {apiKey && !fatal && (
        <div className="fixed left-4 top-20 z-40">
          <div className="rounded-box flex items-center gap-2 bg-base-100 px-3 py-2 text-sm font-semibold text-primary shadow-md">
            {mode === 'strategist' ? (
              <Satellite className="h-4 w-4" />
            ) : (
              <Gamepad2 className="h-4 w-4" />
            )}
            {mode === 'strategist' ? 'STRATEGIST' : 'PLAYER'}
            <span className="font-normal text-base-content/40">TAB to switch</span>
          </div>
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

      {/* Strategist left rail — Tools, Features, Plans, Brief sequence, in that order:
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
              className="btn btn-ghost btn-sm justify-start font-normal"
              onClick={() => {
                const next = !mgrsHudOn;
                setMgrsHudOn(next);
                sandboxRef.current?.setMgrsHudEnabled(next);
              }}
            >
              <Map className="h-4 w-4" /> MGRS HUD {mgrsHudOn && <Check className="h-3 w-3" />}
            </button>
            <button
              className="btn btn-ghost btn-sm justify-start font-normal text-error hover:bg-error/10"
              onClick={clearAllFeatures}
            >
              <Trash2 className="h-4 w-4" /> Clear All
            </button>
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
            {/* Hand-off export (todo 23/24) — a subordinate opens the file elsewhere, no
                live session needed. Reads the LIVE feature set, not a saved snapshot. */}
            <div className="flex gap-1 px-2 pt-1">
              <button
                className="btn btn-xs flex-1 border-none bg-base-300 disabled:opacity-30"
                onClick={() => exportPlanFile('geojson')}
                disabled={features.length === 0}
                aria-label="Export plan as GeoJSON"
              >
                Export GeoJSON
              </button>
              <button
                className="btn btn-xs flex-1 border-none bg-base-300 disabled:opacity-30"
                onClick={() => exportPlanFile('kml')}
                disabled={features.length === 0}
                aria-label="Export plan as KML"
              >
                Export KML
              </button>
            </div>
          </PanelSection>

          <PanelSection title={`Phases (${phases.length})`}>
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
          </PanelSection>

          <PanelSection title="Brief sequence">
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
              lat {pose.camera.geo.lat.toFixed(6)} lon {pose.camera.geo.lon.toFixed(6)}
            </div>
            <div>
              alt {pose.camera.geo.altM.toFixed(0)} m · hdg {pose.camera.geo.headingDeg.toFixed(1)}°
              · pitch {pose.camera.geo.pitchDeg.toFixed(1)}° · fov {pose.camera.fovDeg.toFixed(0)}°
            </div>
          </div>
          <div className="flex gap-1">
            <button
              className="btn btn-sm bg-base-100 shadow-md"
              onClick={() => sandboxRef.current?.captureShot()}
              title="Download a clean tiles-only PNG + matching pose JSON"
            >
              <Camera className="h-4 w-4" /> Capture
            </button>
            <button className="btn btn-sm bg-base-100 shadow-md" onClick={copyPose}>
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
              className="btn btn-primary btn-sm shadow-md"
              onClick={() => setShowImport(true)}
            >
              <Import className="h-4 w-4" /> Import intel
            </button>
            <button
              className="btn btn-sm bg-base-100 text-error shadow-md"
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
        <IntelImport
          currentPose={pose}
          onDeploy={(p, anns, img, provenance) =>
            sandboxRef.current
              ? sandboxRef.current.deployFromImage(p, anns, img, provenance)
              : { detections: [], placed: 0, failed: anns.length }
          }
          onClose={() => setShowImport(false)}
        />
      )}

      {/* Attribution (required by Google ToS) */}
      <div className="fixed bottom-1 left-2 z-40 max-w-[70vw] truncate text-[10px] text-white/75 [text-shadow:0_0_2px_#000]">
        {attributions}
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
