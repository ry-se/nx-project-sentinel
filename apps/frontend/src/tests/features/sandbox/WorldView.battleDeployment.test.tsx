import { createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { WorldView } from '../../../features/sandbox/WorldView';
import type {
  CameraPose,
  Sandbox,
  SandboxCallbacks,
} from '../../../features/sandbox/engine/createSandbox';

const placeBattleUnit = vi.fn(() => ({
  accepted: true as const,
  message: 'Blue Force tank deployed.',
  scenarioId: 'none' as const,
  teamId: 'blue' as const,
  unitType: 'tank' as const,
  unitId: 'manual-none-blue-tank-1',
  worldPosition: { x: 10, y: 0, z: 20 },
  manualUnitCount: 1,
  snapshot: null,
}));

const getBattleTerrainSummary = vi.fn(() => ({
  status: 'ready' as 'ready' | 'error',
  buildingCount: 42,
  waterCount: 3,
  message: '42 buildings · 3 water areas mapped',
}));

const cameraPose: CameraPose = {
  type: 'sentinel-camera-pose',
  version: 1,
  capturedAt: '2026-07-10T00:00:00.000Z',
  anchor: { lat: 1.35, lon: 103.8 },
  camera: {
    fovDeg: 60,
    aspect: 1.6,
    local: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
    geo: { lat: 1.35, lon: 103.8, altM: 200, headingDeg: 0, pitchDeg: -10 },
  },
};

const fakeSandbox = {
  listFeatures: vi.fn(() => []),
  listPlans: vi.fn(() => []),
  listViewpoints: vi.fn(() => []),
  listPhases: vi.fn(() => []),
  getBriefPlaybackState: vi.fn(() => ({ currentIndex: 0, isPlaying: false })),
  getTimelineState: vi.fn(() => ({ currentIndex: 0, isPlaying: false })),
  isRehearsing: vi.fn(() => false),
  getCameraPose: vi.fn(() => cameraPose),
  getBattleSnapshot: vi.fn(() => null),
  getBattleTerrainSummary,
  retryBattleTerrain: vi.fn(async () => getBattleTerrainSummary()),
  placeBattleUnit,
  setBattleTimeScale: vi.fn(),
  setMode: vi.fn(),
  setTool: vi.fn(),
  setLabelsVisible: vi.fn(),
  clearRouteExposureOverlay: vi.fn(),
  dispose: vi.fn(),
} as unknown as Sandbox;

vi.mock('../../../features/sandbox/engine/createSandbox', async () => {
  const actual = await vi.importActual<
    typeof import('../../../features/sandbox/engine/createSandbox')
  >('../../../features/sandbox/engine/createSandbox');
  return {
    ...actual,
    preflightGoogleKey: vi.fn().mockResolvedValue(null),
    createSandbox: vi.fn(
      (_canvas: HTMLCanvasElement, _key: string, _anchor: unknown, cb: SandboxCallbacks) => {
        queueMicrotask(() => {
          cb.onTilesLoaded();
          cb.onMode('strategist');
        });
        return fakeSandbox;
      }
    ),
  };
});

vi.mock('../../../features/sandbox/IntelImport', () => ({
  IntelImport: () => <div data-testid="intel-import-mock" />,
}));

function dataTransferStub(): DataTransfer {
  const values = new Map<string, string>();
  return {
    dropEffect: 'none',
    effectAllowed: 'all',
    files: [] as unknown as FileList,
    items: [] as unknown as DataTransferItemList,
    types: [],
    clearData: (format?: string) => {
      if (format) values.delete(format);
      else values.clear();
    },
    getData: (format: string) => values.get(format) ?? '',
    setData: (format: string, data: string) => {
      values.set(format, data);
    },
    setDragImage: vi.fn(),
  } as DataTransfer;
}

describe('WorldView battle deployment', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    getBattleTerrainSummary.mockReturnValue({
      status: 'ready',
      buildingCount: 42,
      waterCount: 3,
      message: '42 buildings · 3 water areas mapped',
    });
    vi.stubEnv('VITE_GOOGLE_TILES_KEY', 'test-key');
  });

  it('drags a selected team unit onto the canvas and surfaces placement feedback', async () => {
    const { container } = render(<WorldView />);
    const battleTab = await screen.findByRole('tab', { name: 'Battle' });
    fireEvent.click(battleTab);

    await waitFor(() => expect(screen.getByText('42 buildings')).toBeInTheDocument());
    expect(screen.getByRole('combobox', { name: 'Scenario template' })).toHaveValue('none');
    expect(screen.getByRole('option', { name: 'No example scenario' })).toBeInTheDocument();
    const tank = screen.getByTitle('Drag to place blue force tank');
    const canvas = container.querySelector('canvas');
    expect(canvas).not.toBeNull();

    const dataTransfer = dataTransferStub();
    fireEvent.dragStart(tank, { dataTransfer });
    fireEvent.dragOver(canvas as HTMLCanvasElement, { dataTransfer });
    const dropEvent = createEvent.drop(canvas as HTMLCanvasElement, { dataTransfer });
    Object.defineProperties(dropEvent, {
      clientX: { value: 320 },
      clientY: { value: 180 },
    });
    fireEvent(canvas as HTMLCanvasElement, dropEvent);

    expect(placeBattleUnit).toHaveBeenCalledWith('none', 'blue', 'tank', 320, 180);
    expect(await screen.findByText('Blue Force tank deployed.')).toBeInTheDocument();
    expect(screen.getByText('1 placed')).toBeInTheDocument();
  });

  it('keeps ground deployment and Run available when terrain services are degraded', async () => {
    getBattleTerrainSummary.mockReturnValue({
      status: 'error',
      buildingCount: 0,
      waterCount: 0,
      message: 'Obstacle services unavailable; limited coverage active',
    });
    render(<WorldView />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Battle' }));

    await screen.findByText(/Limited mode is active/i);
    expect(screen.getByTitle('Drag to place blue force tank')).toBeEnabled();
    expect(screen.getByRole('button', { name: /Run/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Retry/ })).toBeEnabled();
  });
});
