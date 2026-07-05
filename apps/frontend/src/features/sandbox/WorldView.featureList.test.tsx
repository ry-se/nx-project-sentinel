import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { WorldView } from './WorldView';
import type { FeatureSummary } from './engine/strategist';
import type { Sandbox, SandboxCallbacks } from './engine/createSandbox';

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

vi.mock('./engine/createSandbox', async () => {
  const actual =
    await vi.importActual<typeof import('./engine/createSandbox')>('./engine/createSandbox');
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
  localStorage.setItem('google_tiles_key', 'test-key');
  render(<WorldView />);
  await waitFor(() => expect(screen.getByText(/🛰 STRATEGIST/)).toBeInTheDocument());
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
    expect(screen.getByText('Features (2)')).toBeInTheDocument();
    expect(screen.getByText(/Distance 1/)).toBeInTheDocument();
    expect(screen.getByText(/Fire Arc 1/)).toBeInTheDocument();
  });

  it('selecting a row calls selectFeature and toggles off on a second click', async () => {
    await mountInStrategistMode();
    fireEvent.click(screen.getByTitle('Distance 1'));
    expect(selectFeature).toHaveBeenLastCalledWith('f1');
    fireEvent.click(screen.getByTitle('Distance 1'));
    expect(selectFeature).toHaveBeenLastCalledWith(null);
  });

  it('renaming a feature updates the panel row', async () => {
    await mountInStrategistMode();
    fireEvent.click(screen.getByLabelText('Rename Distance 1'));
    const input = screen.getByLabelText('Rename Distance 1') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'PL COBRA' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(screen.getByText(/PL COBRA/)).toBeInTheDocument());
    expect(fakeSandbox.renameFeature).toHaveBeenCalledWith('f1', 'PL COBRA');
  });

  it('deleting a feature removes it from the panel and drops the count', async () => {
    await mountInStrategistMode();
    fireEvent.click(screen.getByLabelText('Delete Fire Arc 1'));

    await waitFor(() => expect(screen.getByText('Features (1)')).toBeInTheDocument());
    expect(fakeSandbox.removeFeature).toHaveBeenCalledWith('f2');
    expect(screen.queryByText(/Fire Arc 1/)).not.toBeInTheDocument();
  });

  it('undo removes the last feature and disables once the list is empty', async () => {
    await mountInStrategistMode();
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
