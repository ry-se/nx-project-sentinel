import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  type CameraPose,
  createSandbox,
  preflightGoogleKey,
  type Sandbox,
  type SandboxMode,
} from './engine/createSandbox';
import type { Plan } from './engine/planStore';
import type { Viewpoint } from './engine/viewpoint';
import { getStoredSpawnKey, SPAWN_LOCATIONS } from './spawnLocations';
import { type FeatureSummary, type StratTool, TOOL_HINTS } from './engine/strategist';
import type { Affiliation, Echelon } from './engine/unitSymbol';
import type { VehicleType } from './engine/vehicles';
import { IntelImport } from './IntelImport';

const KEY_STORAGE = 'google_tiles_key';

// SPAWN_LOCATIONS imported from shared module

const TOOLS: Array<{ id: StratTool; label: string }> = [
  { id: 'select', label: '☰ Select' },
  { id: 'distance', label: '📏 Distance' },
  { id: 'focus', label: '🎯 Focus Area' },
  { id: 'arc', label: '🧭 Fire Arc' },
  { id: 'los', label: '👁 Line of Sight' },
  { id: 'viewshed', label: '🟢 Viewshed' },
  { id: 'boundary', label: '🚧 Boundary' },
  { id: 'phaseline', label: '〰️ Phase Line' },
  { id: 'loa', label: '⛔ Limit of Adv.' },
  { id: 'axis', label: '➡️ Axis of Adv.' },
  { id: 'objective', label: '🚩 Objective' },
  { id: 'symbol', label: '⬛ Unit Symbol' },
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

const VEHICLES: Array<{ id: VehicleType; label: string; key: string }> = [
  { id: 'tank', label: '🪖 Tank', key: '1' },
  { id: 'car', label: '🏎 GT Car', key: '2' },
  { id: 'jet', label: '✈️ Jet', key: '3' },
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
  const [viewpointVersion, setViewpointVersion] = useState(0);
  const [viewpointNameDraft, setViewpointNameDraft] = useState('');

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
  }, []);

  const deletePlan = useCallback((id: string) => {
    sandboxRef.current?.deletePlan(id);
    setPlanVersion((v) => v + 1);
  }, []);

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

      {/* Mode badge */}
      {apiKey && !fatal && (
        <div className="fixed left-4 top-20 z-40">
          <div
            className={`rounded-box bg-base-100 px-3 py-2 text-sm font-semibold shadow-md ${
              mode === 'strategist' ? 'text-indigo-600' : 'text-green-600'
            }`}
          >
            {mode === 'strategist' ? '🛰 STRATEGIST' : '🎮 PLAYER'}
            <span className="ml-2 font-normal text-base-content/40">TAB to switch</span>
          </div>
        </div>
      )}

      {/* Strategist toolbar */}
      {apiKey && !fatal && mode === 'strategist' && (
        <div className="rounded-box fixed left-4 top-32 z-40 flex w-44 flex-col gap-1 bg-base-100 p-2 shadow-md">
          <div className="px-2 pt-1 text-[10px] font-semibold uppercase tracking-widest text-base-content/40">
            Tools
          </div>
          {TOOLS.map((t) => (
            <button
              key={t.id}
              className={`btn btn-sm justify-start font-normal ${
                tool === t.id
                  ? 'border-none bg-indigo-600 text-white hover:bg-indigo-700'
                  : 'btn-ghost'
              }`}
              onClick={() => selectTool(t.id)}
            >
              {t.label}
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
            🏷 Labels {labelsOn ? '✓' : ''}
          </button>
          <button
            className="btn btn-ghost btn-sm justify-start font-normal"
            onClick={() => {
              const next = !mgrsHudOn;
              setMgrsHudOn(next);
              sandboxRef.current?.setMgrsHudEnabled(next);
            }}
          >
            🗺 MGRS HUD {mgrsHudOn ? '✓' : ''}
          </button>
          <button
            className="btn btn-ghost btn-sm justify-start font-normal text-red-500 hover:bg-red-50"
            onClick={() => sandboxRef.current?.clearAll()}
          >
            🗑 Clear All
          </button>
        </div>
      )}

      {/* Strategist plan persistence (todo 18: save/load/delete named plans) */}
      {apiKey && !fatal && mode === 'strategist' && (
        <div className="rounded-box fixed left-[28rem] top-32 z-40 flex max-h-[60vh] w-56 flex-col gap-1 overflow-y-auto bg-base-100 p-2 shadow-md">
          <div className="px-2 pt-1 text-[10px] font-semibold uppercase tracking-widest text-base-content/40">
            Plans
          </div>
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
              className="btn btn-xs border-none bg-indigo-600 text-white disabled:opacity-30"
              onClick={savePlan}
              disabled={!planNameDraft.trim()}
              aria-label="Save plan"
            >
              💾
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
                className="btn btn-ghost btn-xs px-1 font-normal text-red-500"
                onClick={() => deletePlan(p.id)}
                aria-label={`Delete plan ${p.name}`}
              >
                🗑
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Strategist brief sequence (todo 19: viewpoint bookmarks, ordered) */}
      {apiKey && !fatal && mode === 'strategist' && (
        <div className="rounded-box fixed left-[34rem] top-32 z-40 flex max-h-[60vh] w-56 flex-col gap-1 overflow-y-auto bg-base-100 p-2 shadow-md">
          <div className="px-2 pt-1 text-[10px] font-semibold uppercase tracking-widest text-base-content/40">
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
              className="btn btn-xs border-none bg-indigo-600 text-white disabled:opacity-30"
              onClick={saveViewpoint}
              disabled={!viewpointNameDraft.trim()}
              aria-label="Save current view as a viewpoint"
            >
              📍
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
              <button
                className="btn btn-ghost btn-xs px-1 font-normal disabled:opacity-20"
                onClick={() => moveViewpoint(v.id, -1)}
                disabled={i === 0}
                aria-label={`Move ${v.name} earlier`}
              >
                ↑
              </button>
              <button
                className="btn btn-ghost btn-xs px-1 font-normal disabled:opacity-20"
                onClick={() => moveViewpoint(v.id, 1)}
                disabled={i === viewpoints.length - 1}
                aria-label={`Move ${v.name} later`}
              >
                ↓
              </button>
              <button
                className="btn btn-ghost btn-xs px-1 font-normal text-red-500"
                onClick={() => sandboxRef.current?.deleteViewpoint(v.id)}
                aria-label={`Delete viewpoint ${v.name}`}
              >
                🗑
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Strategist feature list (todo 12: list/select/rename/delete/undo) */}
      {apiKey && !fatal && mode === 'strategist' && (
        <div className="rounded-box fixed left-52 top-32 z-40 flex max-h-[60vh] w-56 flex-col gap-1 overflow-y-auto bg-base-100 p-2 shadow-md">
          <div className="flex items-center justify-between px-2 pt-1">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-base-content/40">
              Features ({features.length})
            </span>
            <button
              className="btn btn-ghost btn-xs font-normal disabled:opacity-30"
              onClick={undoLastFeature}
              disabled={features.length === 0}
              aria-label="Undo last placed feature"
            >
              ↩ Undo
            </button>
          </div>
          {features.length === 0 && (
            <div className="px-2 py-1 text-xs text-base-content/40">No features placed yet</div>
          )}
          {features.map((f) => (
            <div
              key={f.id}
              className={`flex items-center gap-1 rounded px-1 py-0.5 ${
                selectedFeatureId === f.id ? 'bg-indigo-600/10' : ''
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
                  title={f.mgrs ? `${f.name} — ${f.mgrs}` : f.name}
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
              {renamingId !== f.id && (
                <>
                  <button
                    className="btn btn-ghost btn-xs px-1 font-normal"
                    onClick={() => startRename(f)}
                    aria-label={`Rename ${f.name}`}
                  >
                    ✎
                  </button>
                  <button
                    className="btn btn-ghost btn-xs px-1 font-normal text-red-500"
                    onClick={() => deleteFeature(f.id)}
                    aria-label={`Delete ${f.name}`}
                  >
                    🗑
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Player vehicle switcher */}
      {apiKey && !fatal && mode === 'player' && (
        <div className="rounded-box fixed left-4 top-32 z-40 flex flex-col gap-1 bg-base-100 p-2 shadow-md">
          {VEHICLES.map((v) => (
            <button
              key={v.id}
              className="btn btn-ghost btn-sm justify-start font-normal"
              onClick={() => {
                sandboxRef.current?.switchVehicle(v.id);
                setActiveVehicle(v.id);
              }}
            >
              <kbd className="kbd kbd-xs">{v.key}</kbd> {v.label}
            </button>
          ))}
          <div className="px-2 pb-1 text-[10px] text-base-content/40">
            {activeVehicle === 'jet'
              ? 'Q/E roll · SHIFT boost · B bomb'
              : 'WASD drive · SPACE fire'}
          </div>
        </div>
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
            <div key={line} className={i === 0 ? 'font-bold text-indigo-600' : ''}>
              {line}
            </div>
          ))}
        </div>
      )}

      {/* Camera pose readout + intel import (top-right) */}
      {apiKey && !fatal && !loading && pose && (
        <div className="fixed right-4 top-20 z-40 flex flex-col items-end gap-2">
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
              📸 Capture
            </button>
            <button className="btn btn-sm bg-base-100 shadow-md" onClick={copyPose}>
              {poseCopied ? '✓ Copied' : '📋 Copy pose'}
            </button>
            <button
              className="btn btn-sm border-none bg-indigo-600 text-white shadow-md hover:bg-indigo-700"
              onClick={() => setShowImport(true)}
            >
              📥 Import intel
            </button>
            <button
              className="btn btn-sm bg-base-100 text-red-500 shadow-md"
              onClick={() => sandboxRef.current?.clearDetections()}
              title="Remove deployed detections"
            >
              🗑
            </button>
          </div>
        </div>
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
            <span className="loading loading-spinner text-indigo-600" />
            <span className="text-sm">Streaming Google Photorealistic 3D Tiles…</span>
          </div>
        </div>
      )}

      {/* Fatal error */}
      {fatal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-base-200/80">
          <div className="rounded-box max-w-md bg-base-100 p-6 text-center shadow-md">
            <div className="mb-2 text-lg font-semibold text-red-500">Tile service error</div>
            <p className="mb-4 text-sm text-base-content/70">{fatal}</p>
            <button
              className="btn btn-sm border-none bg-indigo-600 text-white hover:bg-indigo-700"
              onClick={resetKey}
            >
              Reset API key
            </button>
          </div>
        </div>
      )}

      {/* API key prompt */}
      {!apiKey && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-base-200">
          <div className="rounded-box w-full max-w-lg bg-base-100 p-8 shadow-md">
            <div className="mb-1 text-xl font-bold">🛰 Google Map Tiles API key</div>
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
              <button
                className="btn border-none bg-indigo-600 text-white hover:bg-indigo-700"
                onClick={submitKey}
              >
                Start
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
