import { Route, Routes } from 'react-router-dom';

import { DetectDebug } from '../features/sandbox/intel/DetectDebug';
import { WorldView } from '../features/sandbox/WorldView';
import type { SandboxMode } from '../features/sandbox/engine/createSandbox';

interface AppProps {
  onSandboxModeBadgeChange?: (state: { mode: SandboxMode; visible: boolean }) => void;
  onSandboxPlanExportChange?: (state: {
    visible: boolean;
    disabled: boolean;
    onExportGeoJSON: () => void;
    onExportKML: () => void;
  }) => void;
}

export function App({ onSandboxModeBadgeChange, onSandboxPlanExportChange }: AppProps = {}) {
  return (
    <Routes>
      <Route
        path="/"
        element={
          <WorldView
            onModeBadgeChange={onSandboxModeBadgeChange}
            onPlanExportChange={onSandboxPlanExportChange}
          />
        }
      />
      <Route path="/detect-debug" element={<DetectDebug />} />
    </Routes>
  );
}
