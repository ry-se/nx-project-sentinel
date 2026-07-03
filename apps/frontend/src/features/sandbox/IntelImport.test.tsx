import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { IntelImport } from './IntelImport';
import type { CameraPose, DeployProvenance, DeployResult } from './engine/createSandbox';
import { DetectClientError } from './intel/detectClient';

vi.mock('./intel/detectClient', async () => {
  const actual =
    await vi.importActual<typeof import('./intel/detectClient')>('./intel/detectClient');
  return { ...actual, detect: vi.fn() };
});
const { detect } = await import('./intel/detectClient');

const POSE: CameraPose = {
  type: 'sentinel-camera-pose',
  version: 1,
  capturedAt: '2026-07-02T00:00:00.000Z',
  anchor: { lat: 1.35, lon: 103.8 },
  camera: {
    fovDeg: 60,
    aspect: 1.6,
    local: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
    geo: { lat: 1.35, lon: 103.8, altM: 200, headingDeg: 90, pitchDeg: -10 },
  },
};

class FakeImage {
  public onload: (() => void) | null = null;
  public onerror: (() => void) | null = null;
  public naturalWidth = 800;
  public naturalHeight = 500;
  private _src = '';
  public get src() {
    return this._src;
  }
  public set src(value: string) {
    this._src = value;
    queueMicrotask(() => this.onload?.());
  }
}

function fakeCanvasContext() {
  return new Proxy(
    {},
    {
      get: () => vi.fn(),
    }
  );
}

async function loadImage(): Promise<void> {
  const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File(['fake-bytes'], 'shot.png', { type: 'image/png' });
  fireEvent.change(fileInput, { target: { files: [file] } });
  await waitFor(() => expect(screen.getByText(/rear of a vehicle/i)).toBeInTheDocument());
}

describe('IntelImport — auto-detect wiring', () => {
  const onDeploy =
    vi.fn<
      (
        pose: CameraPose,
        annotations: import('./engine/createSandbox').ImageAnnotation[],
        image: { width: number; height: number; name: string },
        provenance?: DeployProvenance
      ) => DeployResult
    >();
  const onClose = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('Image', FakeImage);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      fakeCanvasContext() as unknown as CanvasRenderingContext2D
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(
      'data:image/png;base64,ZmFrZQ=='
    );
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn().mockReturnValue('blob:fake') });
    onDeploy.mockReset();
    onClose.mockReset();
    vi.mocked(detect).mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('Auto-detect button is disabled until an image + pose are present', () => {
    render(<IntelImport currentPose={null} onDeploy={onDeploy} onClose={onClose} />);
    expect(screen.getByRole('button', { name: /auto-detect/i })).toBeDisabled();
  });

  it('runs detect() then feeds annotations straight into onDeploy — no manual boxes', async () => {
    vi.mocked(detect).mockResolvedValue({
      annotations: [
        {
          id: 'vlm-0',
          cls: 'armored_fighting_vehicle',
          rear: [10, 20],
          front: [10, 40],
          halfWidthPx: 15,
          confidence: 0.9,
        },
      ],
      model: 'fixture-model',
      latencyMs: 120,
    });
    onDeploy.mockReturnValue({ detections: [], placed: 1, failed: 0 });

    render(<IntelImport currentPose={POSE} onDeploy={onDeploy} onClose={onClose} />);
    await loadImage();

    fireEvent.click(screen.getByRole('button', { name: /auto-detect/i }));

    await waitFor(() => expect(onDeploy).toHaveBeenCalledTimes(1));

    expect(detect).toHaveBeenCalledWith(
      'ZmFrZQ==',
      expect.objectContaining({ type: 'sentinel-camera-pose' }),
      expect.objectContaining({ name: 'shot.png' })
    );
    const [, annotations, , provenance] = onDeploy.mock.calls[0];
    expect(annotations).toHaveLength(1);
    expect(annotations[0].confidence).toBe(0.9); // detector's value, not a client-side 1.0
    expect(screen.getByText(/Deployed 1 detection/i)).toBeInTheDocument();
    // W4: auto path carries real provenance — never a client-fabricated value.
    expect(provenance?.method).toBe('auto');
    expect(provenance?.model).toBe('fixture-model');
    expect(provenance?.detectedAt).toBeTruthy();
  });

  it('review toggle ON holds auto-detect results for accept/reject instead of deploying immediately', async () => {
    vi.mocked(detect).mockResolvedValue({
      annotations: [
        {
          id: 'vlm-0',
          cls: 'armored_fighting_vehicle',
          rear: [10, 20],
          front: [10, 40],
          halfWidthPx: 15,
          confidence: 0.9,
        },
        {
          id: 'vlm-1',
          cls: 'aircraft',
          rear: [50, 60],
          front: [50, 80],
          halfWidthPx: 10,
          confidence: 0.4,
        },
      ],
      model: 'fixture-model',
      latencyMs: 120,
    });
    onDeploy.mockReturnValue({ detections: [], placed: 1, failed: 0 });

    render(<IntelImport currentPose={POSE} onDeploy={onDeploy} onClose={onClose} />);
    await loadImage();

    fireEvent.click(screen.getByLabelText(/require human confirmation/i));
    fireEvent.click(screen.getByRole('button', { name: /auto-detect/i }));

    await waitFor(() =>
      expect(screen.getByText(/review required before deploy/i)).toBeInTheDocument()
    );
    expect(onDeploy).not.toHaveBeenCalled();

    // Reject the second (low-confidence) detection, then confirm.
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[1]);
    fireEvent.click(screen.getByRole('button', { name: /confirm & deploy 1/i }));

    await waitFor(() => expect(onDeploy).toHaveBeenCalledTimes(1));
    const [, annotations, , provenance] = onDeploy.mock.calls[0];
    expect(annotations).toHaveLength(1);
    expect(annotations[0].id).toBe('vlm-0');
    expect(provenance?.method).toBe('auto');
  });

  it('review toggle ON — discard clears the pending review without deploying', async () => {
    vi.mocked(detect).mockResolvedValue({
      annotations: [
        {
          id: 'vlm-0',
          cls: 'armored_fighting_vehicle',
          rear: [10, 20],
          front: [10, 40],
          halfWidthPx: 15,
          confidence: 0.9,
        },
      ],
      model: 'fixture-model',
      latencyMs: 120,
    });

    render(<IntelImport currentPose={POSE} onDeploy={onDeploy} onClose={onClose} />);
    await loadImage();

    fireEvent.click(screen.getByLabelText(/require human confirmation/i));
    fireEvent.click(screen.getByRole('button', { name: /auto-detect/i }));

    await waitFor(() =>
      expect(screen.getByText(/review required before deploy/i)).toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole('button', { name: /discard/i }));

    expect(screen.queryByText(/review required before deploy/i)).not.toBeInTheDocument();
    expect(onDeploy).not.toHaveBeenCalled();
  });

  it('shows a clear error message when the backend is down — no crash', async () => {
    vi.mocked(detect).mockRejectedValue(
      new DetectClientError(
        'Could not reach the detection backend at http://localhost:8000 — is it running?',
        'network'
      )
    );

    render(<IntelImport currentPose={POSE} onDeploy={onDeploy} onClose={onClose} />);
    await loadImage();

    fireEvent.click(screen.getByRole('button', { name: /auto-detect/i }));

    await waitFor(() =>
      expect(screen.getByText(/could not reach the detection backend/i)).toBeInTheDocument()
    );
    expect(onDeploy).not.toHaveBeenCalled();
  });

  it('shows an empty-result message when the detector finds nothing', async () => {
    vi.mocked(detect).mockResolvedValue({ annotations: [], model: 'fixture-model', latencyMs: 50 });

    render(<IntelImport currentPose={POSE} onDeploy={onDeploy} onClose={onClose} />);
    await loadImage();

    fireEvent.click(screen.getByRole('button', { name: /auto-detect/i }));

    await waitFor(() => expect(screen.getByText(/no detections found/i)).toBeInTheDocument());
    expect(onDeploy).not.toHaveBeenCalled();
  });

  it('shows a loading state and disables the button while detect() is pending', async () => {
    let resolveDetect: (value: import('./intel/detectClient').DetectResult) => void;
    vi.mocked(detect).mockReturnValue(
      new Promise((resolve) => {
        resolveDetect = resolve;
      })
    );
    onDeploy.mockReturnValue({ detections: [], placed: 0, failed: 0 });

    render(<IntelImport currentPose={POSE} onDeploy={onDeploy} onClose={onClose} />);
    await loadImage();

    fireEvent.click(screen.getByRole('button', { name: /auto-detect/i }));

    await waitFor(() => expect(screen.getByText(/detecting/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /detecting/i })).toBeDisabled();

    resolveDetect!({ annotations: [], model: 'fixture-model', latencyMs: 50 });
    await waitFor(() => expect(screen.getByText(/no detections found/i)).toBeInTheDocument());
  });

  it('rejects an oversized image before calling detect() — no unbounded upload', async () => {
    class HugeFakeImage extends FakeImage {
      public override naturalWidth = 20000;
      public override naturalHeight = 20000;
    }
    vi.stubGlobal('Image', HugeFakeImage);

    render(<IntelImport currentPose={POSE} onDeploy={onDeploy} onClose={onClose} />);
    await loadImage();

    fireEvent.click(screen.getByRole('button', { name: /auto-detect/i }));

    await waitFor(() => expect(screen.getByText(/too large for auto-detect/i)).toBeInTheDocument());
    expect(detect).not.toHaveBeenCalled();
  });

  it('manual annotate flow is unaffected — still works alongside auto-detect (regression check)', async () => {
    onDeploy.mockReturnValue({ detections: [], placed: 1, failed: 0 });
    render(<IntelImport currentPose={POSE} onDeploy={onDeploy} onClose={onClose} />);
    await loadImage();

    const canvas = document.querySelector('canvas') as HTMLCanvasElement;
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 800,
      height: 500,
      right: 800,
      bottom: 500,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    fireEvent.click(canvas, { clientX: 100, clientY: 100 }); // rear
    fireEvent.click(canvas, { clientX: 200, clientY: 100 }); // front
    fireEvent.click(canvas, { clientX: 150, clientY: 130 }); // width

    const deployButton = screen.getByRole('button', { name: /deploy 1 to world/i });
    expect(deployButton).toBeEnabled();
    fireEvent.click(deployButton);

    await waitFor(() => expect(onDeploy).toHaveBeenCalledTimes(1));
    expect(detect).not.toHaveBeenCalled();
    const [, annotations, , provenance] = onDeploy.mock.calls[0];
    expect(annotations[0].confidence).toBeUndefined(); // manual box: no client-side confidence
    expect(provenance).toEqual({ method: 'manual' }); // W4: manual boxes carry manual provenance
  });
});
