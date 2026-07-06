import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { WorldView } from '../../../features/sandbox/WorldView';
import type { FeatureSummary } from '../../../features/sandbox/engine/strategist';
import type { Sandbox, SandboxCallbacks } from '../../../features/sandbox/engine/createSandbox';

/**
 * Todo 12: the feature-list panel's React wiring — list/select/rename/delete/undo call the
 * right `Sandbox` methods and re-render on `onFeaturesChanged`. `createSandbox` is mocked
 * (WebGL/Google-tiles auth are out of scope for this panel) with a small in-memory feature
 * store standing in for the real `StrategistController`; every mutation below fires the
 * SAME `onFeaturesChanged` callback contract the real controller fires, so this proves the
 * panel reacts the way it would against the real engine.
 */

let features: FeatureSummary[] = [];
let capturedCb: SandboxCallbacks | null = null;
const selectFeature = vi.fn();

function seedFeatures(next: FeatureSummary[]): void {
  features = next;
}

const fakeSandbox: Partial<Sandbox> = {
  setMode: vi.fn(),
  setTool: vi.fn(),
  clearAll: vi.fn(),
  listFeatures: vi.fn(() => features),
  removeFeature: vi.fn((id: string) => {
    features = features.filter((f) => f.id !== id);
    capturedCb?.onFeaturesChanged?.();
  }),
  renameFeature: vi.fn((id: string, name: string) => {
    features = features.map((f) => (f.id === id ? { ...f, name } : f));
    capturedCb?.onFeaturesChanged?.();
  }),
  undoLastFeature: vi.fn(() => {
    features = features.slice(0, -1);
    capturedCb?.onFeaturesChanged?.();
  }),
  selectFeature,
  listPhases: vi.fn(() => []),
  getFeaturePhase: vi.fn(() => 'all-phases'),
  scrubToPhaseIndex: vi.fn(),
  stepTimelineNext: vi.fn(),
  stepTimelinePrevious: vi.fn(),
  cancelTimelinePlayback: vi.fn(),
  getTimelineState: vi.fn(() => ({ currentIndex: 0, isPlaying: false })),
  armSetUnitPhasePosition: vi.fn(),
  cancelSetUnitPhasePosition: vi.fn(),
  isArmedForPhasePosition: vi.fn(() => false),
  isPathFeature: vi.fn(() => false),
  getElevationProfile: vi.fn(() => null),
  getMoveTimeMinutes: vi.fn(() => null),
  runRouteExposure: vi.fn(() => null),
  clearRouteExposureOverlay: vi.fn(),
  listViewpoints: vi.fn(() => []),
  getBriefPlaybackState: vi.fn(() => ({ currentIndex: 0, isPlaying: false })),
  setViewpointPhase: vi.fn(),
  rehearseGoTo: vi.fn(),
  rehearseNext: vi.fn(),
  rehearsePrevious: vi.fn(),
  startRehearsal: vi.fn(),
  pauseRehearsal: vi.fn(),
  cancelRehearsal: vi.fn(),
  isRehearsing: vi.fn(() => false),
  switchVehicle: vi.fn(),
  setLabelsVisible: vi.fn(),
  getCameraPose: vi.fn(() => ({
    type: 'sentinel-camera-pose',
    version: 1,
    capturedAt: '2026-07-05T00:00:00.000Z',
    anchor: { lat: 1.35, lon: 103.8 },
    camera: {
      fovDeg: 60,
      aspect: 1.6,
      local: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
      geo: { lat: 1.35, lon: 103.8, altM: 200, headingDeg: 0, pitchDeg: -10 },
    },
  })),
  captureShot: vi.fn(),
  deployFromImage: vi.fn(),
  clearDetections: vi.fn(),
  dispose: vi.fn(),
};

vi.mock('../../../features/sandbox/engine/createSandbox', async () => {
  const actual =
    await vi.importActual<typeof import('../../../features/sandbox/engine/createSandbox')>('../../../features/sandbox/engine/createSandbox');
  return {
    ...actual,
    preflightGoogleKey: vi.fn().mockResolvedValue(null),
    createSandbox: vi.fn(
      (_canvas: HTMLCanvasElement, _key: string, _anchor: unknown, cb: SandboxCallbacks) => {
        capturedCb = cb;
        // Simulate tiles finishing load + a TAB-switch into strategist mode, same as a real
        // session would report via these callbacks before the panel is usable.
        queueMicrotask(() => {
          cb.onTilesLoaded();
          cb.onMode('strategist');
        });
        return fakeSandbox as Sandbox;
      }
    ),
  };
});

async function mountInStrategistMode(): Promise<void> {
  vi.stubEnv('VITE_GOOGLE_TILES_KEY', 'test-key');
  render(<WorldView />);
  await waitFor(() => expect(screen.getByRole('tab', { name: /Tools/ })).toBeInTheDocument());
}

function selectPanelTab(name: RegExp): void {
  fireEvent.click(screen.getByRole('tab', { name }));
}

describe('WorldView — feature list panel (todo 12)', () => {
  beforeEach(() => {
    localStorage.clear();
    capturedCb = null;
    seedFeatures([
      { id: 'f1', name: 'Distance 1', type: 'distance' },
      { id: 'f2', name: 'Fire Arc 1', type: 'arc' },
    ]);
    vi.clearAllMocks();
  });

  it('lists every drawn feature by name and type', async () => {
    await mountInStrategistMode();
    selectPanelTab(/Features/);

    expect(screen.getByText('Features (2)')).toBeInTheDocument();
    expect(screen.getByText(/Distance 1/)).toBeInTheDocument();
    expect(screen.getByText(/Fire Arc 1/)).toBeInTheDocument();
  });

  it('selecting a row calls selectFeature and toggles off on a second click', async () => {
    await mountInStrategistMode();
    selectPanelTab(/Features/);

    fireEvent.click(screen.getByTitle('Distance 1'));
    expect(selectFeature).toHaveBeenLastCalledWith('f1');
    fireEvent.click(screen.getByTitle('Distance 1'));
    expect(selectFeature).toHaveBeenLastCalledWith(null);
  });

  it('renaming a feature updates the panel row', async () => {
    await mountInStrategistMode();
    selectPanelTab(/Features/);

    fireEvent.click(screen.getByLabelText('Rename Distance 1'));
    const input = screen.getByLabelText('Rename Distance 1') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'PL COBRA' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(screen.getByText(/PL COBRA/)).toBeInTheDocument());
    expect(fakeSandbox.renameFeature).toHaveBeenCalledWith('f1', 'PL COBRA');
  });

  it('deleting a feature removes it from the panel and drops the count', async () => {
    await mountInStrategistMode();
    selectPanelTab(/Features/);

    fireEvent.click(screen.getByLabelText('Delete Fire Arc 1'));

    await waitFor(() => expect(screen.getByText('Features (1)')).toBeInTheDocument());
    expect(fakeSandbox.removeFeature).toHaveBeenCalledWith('f2');
    expect(screen.queryByText(/Fire Arc 1/)).not.toBeInTheDocument();
  });

  it('undo removes the last feature and disables once the list is empty', async () => {
    await mountInStrategistMode();
    selectPanelTab(/Features/);

    const undo = screen.getByLabelText('Undo last placed feature');
    expect(undo).not.toBeDisabled();

    fireEvent.click(undo);
    await waitFor(() => expect(screen.getByText('Features (1)')).toBeInTheDocument());
    expect(fakeSandbox.undoLastFeature).toHaveBeenCalledTimes(1);

    fireEvent.click(undo);
    await waitFor(() => expect(screen.getByText('Features (0)')).toBeInTheDocument());
    expect(screen.getByText(/No features placed yet/)).toBeInTheDocument();
    expect(screen.getByLabelText('Undo last placed feature')).toBeDisabled();
  });
});
