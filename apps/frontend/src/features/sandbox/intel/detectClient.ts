import type { CameraPose, ImageAnnotation } from '../engine/createSandbox';
import { DETECTION_CLASSES, type DetectionClass } from '../engine/detections';

export type DetectClientErrorKind =
  | 'no_backend_configured'
  | 'network'
  | 'http'
  | 'invalid_response';

// The backend's error `detail` string is untrusted display text (a hostile/misconfigured
// provider could return an arbitrarily long one) — clamp before it reaches the DOM.
const MAX_DETAIL_CHARS = 300;

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

export interface DetectResult {
  annotations: ImageAnnotation[];
  model: string;
  latencyMs: number;
}

/** POSTs the image + pose to the detection backend and returns oriented annotations
 * ready to feed straight into deployFromImage — no reshaping downstream — plus which
 * model answered and how long it took, so callers can show what the model actually did. */
export async function detect(
  imageB64: string,
  pose: CameraPose,
  image: { width: number; height: number; name: string }
): Promise<DetectResult> {
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
    // baseUrl stays in the console log only — the user-facing message doesn't need to
    // expose the configured backend host.
    console.error('[detect] network error', { baseUrl, err });
    throw new DetectClientError(
      'Could not reach the detection backend — is it running?',
      'network'
    );
  }

  if (!resp.ok) {
    let detail = `Detector responded with status ${resp.status}`;
    try {
      const body = (await resp.json()) as DetectApiError;
      // The backend's detail string is untrusted display text, not markup (React
      // renders it as an escaped text child) — clamp length defensively regardless.
      if (body.detail) detail = body.detail.slice(0, MAX_DETAIL_CHARS);
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
  // Every box must actually have the shape "no reshaping downstream" promises — a
  // malformed box here would otherwise crash deployFromImage with a raw TypeError
  // instead of surfacing as this function's own typed-error contract.
  if (!data.annotations.every(isValidDetectApiBox)) {
    console.error('[detect] malformed annotation in response', data.annotations);
    throw new DetectClientError(
      'Detector response contained a malformed annotation',
      'invalid_response'
    );
  }
  const latencyMs = Number.isFinite(data.latency_ms) ? data.latency_ms : 0;

  console.warn(
    `[detect] ok — ${data.annotations.length} annotation(s), model=${data.model}, ` +
      `round-trip ${(performance.now() - start).toFixed(0)}ms (server latency_ms=${latencyMs.toFixed(1)})`
  );

  return {
    annotations: data.annotations.map((box) => ({
      id: box.id,
      cls: box.cls,
      rear: box.rear,
      front: box.front,
      halfWidthPx: box.halfWidthPx,
      confidence: box.confidence,
      headingConfidence: box.heading_confidence,
    })),
    // Same untrusted-display-text treatment as the error `detail` above — a non-string
    // model would otherwise crash the React tree ("Objects are not valid as a React
    // child") wherever it's rendered.
    model: typeof data.model === 'string' ? data.model.slice(0, MAX_DETAIL_CHARS) : 'unknown',
    latencyMs,
  };
}

const HEADING_CONFIDENCE_VALUES = ['high', 'medium', 'low'];
const DETECTION_CLASS_IDS = DETECTION_CLASSES.map((c) => c.id);

function isValidDetectApiBox(box: DetectApiBox): boolean {
  return (
    typeof box.id === 'string' &&
    typeof box.cls === 'string' &&
    DETECTION_CLASS_IDS.includes(box.cls) &&
    Array.isArray(box.rear) &&
    box.rear.length === 2 &&
    box.rear.every(Number.isFinite) &&
    Array.isArray(box.front) &&
    box.front.length === 2 &&
    box.front.every(Number.isFinite) &&
    Number.isFinite(box.halfWidthPx) &&
    Number.isFinite(box.confidence) &&
    HEADING_CONFIDENCE_VALUES.includes(box.heading_confidence)
  );
}
