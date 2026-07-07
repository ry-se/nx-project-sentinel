import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';

import type { SandboxMode } from '../features/sandbox/engine/createSandbox';

const routeComponents = {
  WorldView: lazy(() =>
    import('../features/sandbox/WorldView').then((module) => ({ default: module.WorldView }))
  ),
  DetectDebug: lazy(() =>
    import('../features/sandbox/intel/DetectDebug').then((module) => ({
      default: module.DetectDebug,
    }))
  ),
};

interface AppProps {
  onSandboxModeBadgeChange?: (state: { mode: SandboxMode; visible: boolean }) => void;
  onSandboxPlanExportChange?: (state: {
    visible: boolean;
    disabled: boolean;
    onExportGeoJSON: () => void;
    onExportKML: () => void;
  }) => void;
}

function RouteFallback() {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-base-200/80"
      role="status"
      aria-live="polite"
    >
      <div className="rounded-box flex items-center gap-3 bg-base-100 px-6 py-4 shadow-md">
        <span className="loading loading-spinner text-primary" />
        <span className="text-sm">Loading workspace...</span>
      </div>
    </div>
  );
}

export function App({ onSandboxModeBadgeChange, onSandboxPlanExportChange }: AppProps = {}) {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route
          path="/"
          element={
            <routeComponents.WorldView
              onModeBadgeChange={onSandboxModeBadgeChange}
              onPlanExportChange={onSandboxPlanExportChange}
            />
          }
        />
        <Route path="/detect-debug" element={<routeComponents.DetectDebug />} />
      </Routes>
    </Suspense>
  );
}
