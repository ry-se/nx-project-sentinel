import type { CameraPose, ImageAnnotation } from '../engine/createSandbox';
import type { DetectionClass } from '../engine/detections';

export type DetectClientErrorKind =
  | 'no_backend_configured'
  | 'network'
  | 'http'
  | 'invalid_response';

/** Typed error for every detect() failure path — never a silent empty result. */
export class DetectClientError extends Error {
  constructor(
    message: string,
    public readonly kind: DetectClientErrorKind
  ) {
    super(message);
    this.name = 'DetectClientError';
  }
}

interface DetectApiBox {
  id: string;
  cls: DetectionClass;
  rear: [number, number];
  front: [number, number];
  halfWidthPx: number;
  confidence: number;
  heading_confidence: 'high' | 'medium' | 'low';
}

interface DetectApiResponse {
  annotations: DetectApiBox[];
  model: string;
  latency_ms: number;
}

interface DetectApiError {
  error: string;
  detail: string;
  request_id: string;
}

function getBaseUrl(): string {
  const url = import.meta.env.VITE_DETECT_API as string | undefined;
  if (!url) {
    throw new DetectClientError(
      'No detection backend configured — set VITE_DETECT_API in .env',
      'no_backend_configured'
    );
  }
  return url.replace(/\/+$/, '');
}

/** POSTs the image + pose to the detection backend and returns oriented annotations
 * ready to feed straight into deployFromImage — no reshaping downstream. */
export async function detect(
  imageB64: string,
  pose: CameraPose,
  image: { width: number; height: number; name: string }
): Promise<ImageAnnotation[]> {
  const baseUrl = getBaseUrl();
  const start = performance.now();
  // console.warn, not .log — this repo's eslint config only allows warn/error.
  console.warn(`[detect] start -> ${baseUrl}/api/v1/detect`, { image: image.name });

  let resp: Response;
  try {
    resp = await fetch(`${baseUrl}/api/v1/detect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image_b64: imageB64,
        pose: {
          lat: pose.camera.geo.lat,
          lon: pose.camera.geo.lon,
          alt_m: pose.camera.geo.altM,
          heading_deg: pose.camera.geo.headingDeg,
          pitch_deg: pose.camera.geo.pitchDeg,
        },
        image_meta: image,
      }),
    });
  } catch (err) {
    console.error('[detect] network error', err);
    throw new DetectClientError(
      `Could not reach the detection backend at ${baseUrl} — is it running?`,
      'network'
    );
  }

  if (!resp.ok) {
    let detail = `Detector responded with status ${resp.status}`;
    try {
      const body = (await resp.json()) as DetectApiError;
      if (body.detail) detail = body.detail;
    } catch {
      // Body wasn't the typed error shape — keep the generic status-based detail.
    }
    console.error('[detect] http error', { status: resp.status, detail });
    throw new DetectClientError(detail, 'http');
  }

  let data: DetectApiResponse;
  try {
    data = (await resp.json()) as DetectApiResponse;
  } catch (err) {
    console.error('[detect] invalid JSON response', err);
    throw new DetectClientError(
      'Detector returned a response that was not valid JSON',
      'invalid_response'
    );
  }
  if (!Array.isArray(data.annotations)) {
    console.error('[detect] response missing annotations array', data);
    throw new DetectClientError(
      'Detector response did not include an annotations array',
      'invalid_response'
    );
  }

  console.warn(
    `[detect] ok — ${data.annotations.length} annotation(s), model=${data.model}, ` +
      `round-trip ${(performance.now() - start).toFixed(0)}ms (server latency_ms=${data.latency_ms.toFixed(1)})`
  );

  return data.annotations.map((box) => ({
    id: box.id,
    cls: box.cls,
    rear: box.rear,
    front: box.front,
    halfWidthPx: box.halfWidthPx,
    confidence: box.confidence,
  }));
}
