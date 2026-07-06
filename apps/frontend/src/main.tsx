import { BrowserRouter } from 'react-router-dom';
import { useState } from 'react';
import * as ReactDOM from 'react-dom/client';

import { App } from './app/app';
import type { SandboxMode } from './features/sandbox/engine/createSandbox';
import { NavBar } from './layouts/NavBar';

// Tile caching is DISABLED. The cache-first service worker served stale /
// partial tiles forever (geometry that got cached mid-stream never re-fetched),
// which broke 3D-tile streaming away from spawn. Purge any previously-installed
// worker + its cache so streaming behaves normally again.
if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.getRegistrations().then((regs) => {
    for (const reg of regs) void reg.unregister();
  });
}
if ('caches' in window) {
  void caches.keys().then((names) => {
    for (const name of names) if (name.startsWith('sentinel-tiles')) void caches.delete(name);
  });
}

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);

interface SandboxPlanExportState {
  visible: boolean;
  disabled: boolean;
  onExportGeoJSON: () => void;
  onExportKML: () => void;
}

const noop = (): void => undefined;

function Root() {
  const [sandboxModeBadge, setSandboxModeBadge] = useState<{
    mode: SandboxMode;
    visible: boolean;
  }>({ mode: 'player', visible: false });
  const [sandboxPlanExport, setSandboxPlanExport] = useState<SandboxPlanExportState>({
    visible: false,
    disabled: true,
    onExportGeoJSON: noop,
    onExportKML: noop,
  });

  return (
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <NavBar sandboxModeBadge={sandboxModeBadge} sandboxPlanExport={sandboxPlanExport} />
      <App
        onSandboxModeBadgeChange={setSandboxModeBadge}
        onSandboxPlanExportChange={setSandboxPlanExport}
      />
    </BrowserRouter>
  );
}

root.render(<Root />);
