import type { CameraPose } from '../engine/createSandbox';

import { detect, DetectClientError } from './detectClient';

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

const IMAGE = { width: 800, height: 500, name: 'test.png' };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('detectClient.detect', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_DETECT_API', 'http://localhost:8000');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('throws no_backend_configured when VITE_DETECT_API is unset', async () => {
    vi.stubEnv('VITE_DETECT_API', '');
    await expect(detect('img', POSE, IMAGE)).rejects.toMatchObject({
      kind: 'no_backend_configured',
    });
  });

  it('maps a successful response into { annotations, model, latencyMs }', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          annotations: [
            {
              id: 'vlm-0',
              cls: 'armored_fighting_vehicle',
              rear: [10, 20],
              front: [10, 40],
              halfWidthPx: 15,
              confidence: 0.87,
              heading_confidence: 'high',
            },
          ],
          model: 'qwen2.5vl:3b',
          latency_ms: 42.5,
        })
      )
    );

    const result = await detect('img-b64', POSE, IMAGE);

    expect(result.annotations).toEqual([
      {
        id: 'vlm-0',
        cls: 'armored_fighting_vehicle',
        rear: [10, 20],
        front: [10, 40],
        halfWidthPx: 15,
        confidence: 0.87,
        headingConfidence: 'high',
      },
    ]);
    expect(result.model).toBe('qwen2.5vl:3b');
    expect(result.latencyMs).toBe(42.5);
  });

  it('carries heading_confidence through to headingConfidence — regression guard for the W4 drop', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          annotations: [
            {
              id: 'vlm-0',
              cls: 'aircraft',
              rear: [0, 0],
              front: [0, 5],
              halfWidthPx: 5,
              confidence: 0.6,
              heading_confidence: 'medium',
            },
          ],
          model: 'x',
          latency_ms: 1,
        })
      )
    );

    const result = await detect('img', POSE, IMAGE);
    expect(result.annotations[0].headingConfidence).toBe('medium');
  });

  it('throws invalid_response when heading_confidence is not one of high/medium/low', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          annotations: [
            {
              id: 'vlm-0',
              cls: 'aircraft',
              rear: [0, 0],
              front: [0, 5],
              halfWidthPx: 5,
              confidence: 0.6,
              heading_confidence: 'certain', // not a valid enum value
            },
          ],
          model: 'x',
          latency_ms: 1,
        })
      )
    );

    await expect(detect('img', POSE, IMAGE)).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('sends pose mapped to the backend snake_case contract', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { annotations: [], model: 'x', latency_ms: 1 }));
    vi.stubGlobal('fetch', fetchMock);

    await detect('img-b64', POSE, IMAGE);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8000/api/v1/detect');
    const body = JSON.parse(init.body as string) as { pose: Record<string, number> };
    expect(body.pose).toEqual({
      lat: 1.35,
      lon: 103.8,
      alt_m: 200,
      heading_deg: 90,
      pitch_deg: -10,
    });
  });

  it('throws a network DetectClientError when fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    await expect(detect('img', POSE, IMAGE)).rejects.toMatchObject({ kind: 'network' });
  });

  it('throws an http DetectClientError with the typed backend detail on non-200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(502, {
          error: 'detector_unavailable',
          detail: 'detector provider request failed',
          request_id: 'r1',
        })
      )
    );

    await expect(detect('img', POSE, IMAGE)).rejects.toMatchObject({
      kind: 'http',
      message: 'detector provider request failed',
    });
  });

  it('clamps an oversized backend detail string before it becomes the error message', async () => {
    const longDetail = 'x'.repeat(5000);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(jsonResponse(500, { error: 'e', detail: longDetail, request_id: 'r1' }))
    );

    let err: DetectClientError | undefined;
    try {
      await detect('img', POSE, IMAGE);
    } catch (e) {
      err = e as DetectClientError;
    }
    expect(err?.message.length).toBeLessThanOrEqual(300);
  });

  it('throws an http DetectClientError with a generic detail when body is not the typed shape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not json', { status: 500 })));

    await expect(detect('img', POSE, IMAGE)).rejects.toMatchObject({ kind: 'http' });
  });

  it('throws invalid_response when annotations is missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { model: 'x', latency_ms: 1 }))
    );

    await expect(detect('img', POSE, IMAGE)).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('resolves to an empty annotations array (not an error) when the detector finds nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { annotations: [], model: 'x', latency_ms: 1 }))
    );

    await expect(detect('img', POSE, IMAGE)).resolves.toMatchObject({ annotations: [] });
  });

  it('preserves a real confidence of 0 — regression guard for the "no client-side 1.0" invariant', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          annotations: [
            {
              id: 'vlm-0',
              cls: 'aircraft',
              rear: [0, 0],
              front: [0, 5],
              halfWidthPx: 5,
              confidence: 0,
              heading_confidence: 'low',
            },
          ],
          model: 'x',
          latency_ms: 1,
        })
      )
    );

    const result = await detect('img', POSE, IMAGE);
    expect(result.annotations[0].confidence).toBe(0);
  });

  it('throws invalid_response for a malformed annotation (missing rear point)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          annotations: [
            { id: 'vlm-0', cls: 'aircraft', front: [0, 5], halfWidthPx: 5, confidence: 0.5 },
          ],
          model: 'x',
          latency_ms: 1,
        })
      )
    );

    await expect(detect('img', POSE, IMAGE)).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('does not crash on a missing/non-numeric latency_ms — typed success, not a raw TypeError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          annotations: [
            {
              id: 'vlm-0',
              cls: 'aircraft',
              rear: [0, 0],
              front: [0, 5],
              halfWidthPx: 5,
              confidence: 0.5,
              heading_confidence: 'low',
            },
          ],
          model: 'x',
          // latency_ms deliberately omitted
        })
      )
    );

    const result = await detect('img', POSE, IMAGE);
    expect(result.annotations).toHaveLength(1);
  });

  it('DetectClientError is a real Error subclass with a name', () => {
    const err = new DetectClientError('boom', 'network');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('DetectClientError');
    expect(err.kind).toBe('network');
  });
});
