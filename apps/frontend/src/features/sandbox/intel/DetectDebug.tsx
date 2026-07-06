import { useEffect, useRef, useState } from 'react';

import type { CameraPose } from '../engine/createSandbox';

import { detect, DetectClientError, type DetectResult } from './detectClient';
import { drawOBB } from './renderDetectionBox';

type RunState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'done' };

const CANVAS_MAX_W = 900;
const CANVAS_MAX_H = 620;

// Reasonable Singapore defaults so the tool is usable with zero typing — pose is only
// prompt context for the detector (see vision_adapter.py), not required for a bare
// recognition/localization check, so these values don't need to be exact.
const DEFAULT_POSE = { lat: 1.3521, lon: 103.8198, altM: 200, headingDeg: 0, pitchDeg: -45 };

/** Standalone detector test bench — pick an image, run detection, see exactly what the
 * model returned drawn on the image. No 3D world, no capture step, no deploy: repeatable
 * in seconds instead of spawn → navigate → capture → open Intel Import each time. */
export function DetectDebug() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);

  const [imageName, setImageName] = useState<string | null>(null);
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);
  const [scale, setScale] = useState(1);

  const [pose, setPose] = useState(DEFAULT_POSE);
  const [run, setRun] = useState<RunState>({ status: 'idle' });
  const [result, setResult] = useState<DetectResult | null>(null);

  const onFile = (file: File | undefined): void => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      imageRef.current = img;
      setImageName(file.name);
      setImageSize({ width: img.naturalWidth, height: img.naturalHeight });
      setScale(Math.min(CANVAS_MAX_W / img.naturalWidth, CANVAS_MAX_H / img.naturalHeight, 1));
      setResult(null);
      setRun({ status: 'idle' });
    };
    img.src = url;
  };

  // Draws the base image plus every returned box — reruns whenever a new result lands
  // or the loaded image/scale changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    const img = imageRef.current;
    if (!canvas || !img || !imageSize) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.width = Math.round(imageSize.width * scale);
    canvas.height = Math.round(imageSize.height * scale);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    result?.annotations.forEach((a, i) => {
      const label = `#${i + 1} ${a.cls}${a.confidence !== undefined ? ` ${a.confidence.toFixed(2)}` : ''}`;
      drawOBB(ctx, a.rear, a.front, a.halfWidthPx, 'rgba(16,185,129,1)', scale, label);
    });
  }, [result, imageSize, scale]);

  const runDetect = async (): Promise<void> => {
    const img = imageRef.current;
    if (!img || !imageSize || !imageName) return;
    setRun({ status: 'loading' });
    setResult(null);

    const canvas = document.createElement('canvas');
    canvas.width = imageSize.width;
    canvas.height = imageSize.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      setRun({ status: 'error', message: 'canvas 2d context unavailable' });
      return;
    }
    ctx.drawImage(img, 0, 0, imageSize.width, imageSize.height);
    const dataUrl = canvas.toDataURL('image/png');
    const imageB64 = dataUrl.split(',')[1];
    if (!imageB64) {
      setRun({ status: 'error', message: 'failed to encode the image' });
      return;
    }

    // detect() only reads pose.camera.geo.* — the rest of CameraPose is inert here, so a
    // minimal synthetic pose is correct, not a shortcut.
    const syntheticPose: CameraPose = {
      type: 'sentinel-camera-pose',
      version: 1,
      capturedAt: new Date(0).toISOString(),
      anchor: { lat: pose.lat, lon: pose.lon },
      camera: {
        fovDeg: 60,
        aspect: imageSize.width / imageSize.height,
        local: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
        geo: pose,
      },
    };

    try {
      const detectResult = await detect(imageB64, syntheticPose, { ...imageSize, name: imageName });
      setResult(detectResult);
      setRun({ status: 'done' });
    } catch (err) {
      const message =
        err instanceof DetectClientError
          ? err.message
          : 'Unexpected error running detection — see console for details.';
      if (!(err instanceof DetectClientError)) console.error('[detect-debug]', err);
      setRun({ status: 'error', message });
    }
  };

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-6 pt-24">
      <div>
        <h1 className="text-lg font-bold">Detect Debug</h1>
        <p className="text-sm text-base-content/50">
          Test the detector directly against any image — no 3D world, no capture, no deploy. Repeat
          as many times as you want.
        </p>
      </div>

      <div className="flex gap-4">
        <div className="flex flex-1 flex-col gap-2">
          <input
            type="file"
            accept="image/*"
            className="file-input file-input-bordered file-input-sm w-full"
            onChange={(e) => onFile(e.target.files?.[0])}
          />
          {imageSize ? (
            <canvas ref={canvasRef} className="rounded-lg border border-base-300" />
          ) : (
            <div className="flex h-48 items-center justify-center rounded-lg border border-dashed border-base-300 text-sm text-base-content/40">
              Pick an image to test
            </div>
          )}
        </div>

        <div className="flex w-72 flex-col gap-3">
          <div className="text-xs font-semibold uppercase tracking-widest text-base-content/40">
            Pose context (optional, affects prompt only)
          </div>
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                ['lat', 'Lat'],
                ['lon', 'Lon'],
                ['altM', 'Alt (m)'],
                ['headingDeg', 'Heading°'],
                ['pitchDeg', 'Pitch°'],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="flex flex-col gap-0.5 text-[10px] text-base-content/50">
                {label}
                <input
                  type="number"
                  className="input input-bordered input-xs"
                  value={pose[key]}
                  onChange={(e) => setPose((prev) => ({ ...prev, [key]: Number(e.target.value) }))}
                />
              </label>
            ))}
          </div>

          <button
            className="btn border-none bg-emerald-600 text-white hover:bg-emerald-700"
            disabled={!imageSize || run.status === 'loading'}
            onClick={() => void runDetect()}
          >
            {run.status === 'loading' ? (
              <>
                <span className="loading loading-spinner loading-xs" /> Detecting…
              </>
            ) : (
              <>
                <span role="img" aria-label="robot">
                  🤖
                </span>{' '}
                Run detection
              </>
            )}
          </button>

          {run.status === 'error' && <div className="alert alert-error text-xs">{run.message}</div>}
          {run.status === 'done' && result?.annotations.length === 0 && (
            <div className="alert alert-warning text-xs">No detections found in this image.</div>
          )}

          {result && (
            <div className="flex flex-col gap-1">
              <div className="text-xs text-base-content/50">
                model={result.model} · {result.latencyMs.toFixed(0)}ms · {result.annotations.length}{' '}
                box{result.annotations.length === 1 ? '' : 'es'}
              </div>
              <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
                {result.annotations.map((a, i) => (
                  <div key={a.id} className="rounded-lg bg-base-200 px-2 py-1 text-xs">
                    <span className="font-bold text-emerald-600">#{i + 1}</span> {a.cls} · conf=
                    {a.confidence?.toFixed(2) ?? 'n/a'} · heading={a.headingConfidence ?? 'n/a'}
                  </div>
                ))}
              </div>
              <button
                className="btn btn-xs"
                onClick={() => void navigator.clipboard.writeText(JSON.stringify(result, null, 2))}
              >
                Copy raw JSON
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
