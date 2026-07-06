import { useState } from 'react';
import { Download, Gamepad2, Satellite } from 'lucide-react';
import { Link } from 'react-router-dom';

import type { SandboxMode } from '../features/sandbox/engine/createSandbox';
import {
  getStoredSpawnKey,
  setStoredSpawnKey,
  SPAWN_LOCATIONS,
} from '../features/sandbox/spawnLocations';

interface NavBarProps {
  sandboxModeBadge?: {
    mode: SandboxMode;
    visible: boolean;
  };
  sandboxPlanExport?: {
    visible: boolean;
    disabled: boolean;
    onExportGeoJSON: () => void;
    onExportKML: () => void;
  };
}

export function NavBar({ sandboxModeBadge, sandboxPlanExport }: NavBarProps = {}) {
  const [spawn, setSpawn] = useState(getStoredSpawnKey());
  const exportDisabled = !sandboxPlanExport?.visible || sandboxPlanExport.disabled;

  return (
    <div style={{ width: '100vw' }} className="fixed top-0 left-0 right-0 z-50 px-4 pt-3">
      <div className="navbar bg-base-100 shadow-md rounded-box min-h-0 py-2 px-3">
        {/* Left: Logo + breadcrumb */}
        <div className="navbar-start gap-3">
          <div className="avatar placeholder">
            <div className="bg-primary text-black rounded-lg w-8 text-sm font-bold flex items-center justify-center">
              <span>S</span>
            </div>
          </div>

          <div className="flex items-center gap-2 text-sm">
            <span className="font-semibold">Sentinel</span>
            <span className="text-base-content/30">/</span>
            <span className="text-base-content/60">Op Raven</span>
            <span className="text-base-content/30">·</span>
            <span className="text-base-content/60">COA-B</span>
            <span className="text-base-content/30">·</span>
            <span className="text-base-content/40">Sandbox 03</span>
          </div>

          {sandboxModeBadge?.visible && (
            <div className="rounded-box flex items-center gap-2 bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary">
              {sandboxModeBadge.mode === 'strategist' ? (
                <Satellite className="h-3.5 w-3.5" />
              ) : (
                <Gamepad2 className="h-3.5 w-3.5" />
              )}
              {sandboxModeBadge.mode === 'strategist' ? 'STRATEGIST' : 'PLAYER'}
              <span className="font-normal text-base-content/40">TAB to switch</span>
            </div>
          )}
        </div>

        {/* Right: Actions */}
        <div className="navbar-end gap-1 items-center">
          
          <div className="mr-2">
            <select
              className="select select-sm select-bordered"
              value={spawn}
              onChange={(e) => {
                const v = e.target.value;
                setSpawn(v);
                setStoredSpawnKey(v);
              }}
            >
              {SPAWN_LOCATIONS.map((loc) => (
                <option key={loc.key} value={loc.key}>
                  {loc.label}
                </option>
              ))}
            </select>
          </div>

          <div className="divider divider-horizontal mx-0" />

          <Link to="/detect-debug" className="btn btn-sm btn-ghost font-normal">
            <span role="img" aria-label="microscope">
              🔬
            </span>{' '}
            Detect Debug
          </Link>

          <div className="divider divider-horizontal mx-0" />

          <div className="dropdown dropdown-end">
            <button
              type="button"
              tabIndex={0}
              className="btn btn-sm gap-1.5 border-none bg-primary text-black shadow-sm transition-all duration-150 hover:-translate-y-0.5 hover:bg-primary/90 hover:shadow-lg active:translate-y-0 disabled:hover:translate-y-0 disabled:hover:shadow-sm"
              disabled={exportDisabled}
              aria-label="Export"
            >
              <Download className="h-4 w-4" />
              Export
            </button>
            <ul
              tabIndex={0}
              className="dropdown-content menu z-[60] mt-2 w-44 rounded-box bg-base-100 p-2 shadow-xl"
            >
              <li>
                <button
                  type="button"
                  disabled={exportDisabled}
                  aria-label="Export plan as GeoJSON"
                  onClick={() => sandboxPlanExport?.onExportGeoJSON()}
                >
                  GeoJSON
                </button>
              </li>
              <li>
                <button
                  type="button"
                  disabled={exportDisabled}
                  aria-label="Export plan as KML"
                  onClick={() => sandboxPlanExport?.onExportKML()}
                >
                  KML
                </button>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
