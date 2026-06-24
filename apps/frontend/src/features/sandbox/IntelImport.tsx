import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  CameraPose,
  DeployResult,
  ImageAnnotation,
} from './engine/createSandbox';
import { DETECTION_CLASSES, type DetectionClass } from './engine/detections';

import { CANVAS } from '@/constants';

interface IntelImportProps {
  /** Current camera pose, used to prefill the pose field. */
  currentPose: CameraPose | null;
  onDeploy(
    pose: CameraPose,
    annotations: ImageAnnotation[],
    image: { width: number; height: number; name: string }
  ): DeployResult;
  onClose(): void;
}

type DrawPhase =
  | { step: 'idle' }
  | { step: 'axis'; rear: [number, number] }
  | { step: 'width'; rear: [number, number]; front: [number, number] };

const CANVAS_MAX_W = 760;
const CANVAS_MAX_H = 460;

export function IntelImport({ currentPose, onDeploy, onClose }: IntelImportProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);

  const [imageName, setImageName] = useState<string | null>(null);
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);
  const [scale, setScale] = useState(1);

  const [poseText, setPoseText] = useState(
    currentPose ? JSON.stringify(currentPose, null, 2) : ''
  );
  const [poseError, setPoseError] = useState<string | null>(null);

  const [annotations, setAnnotations] = useState<ImageAnnotation[]>([]);
  const [phase, setPhase] = useState<DrawPhase>({ step: 'idle' });
  const [hover, setHover] = useState<[number, number] | null>(null);

  const [result, setResult] = useState<DeployResult | null>(null);

  // ---------- image loading ----------

  const onFile = (file: File | undefined): void => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      imageRef.current = img;
      setImageName(file.name);
      setImageSize({ width: img.naturalWidth, height: img.naturalHeight });
      setScale(
        Math.min(CANVAS_MAX_W / img.naturalWidth, CANVAS_MAX_H / img.naturalHeight, 1)
      );
      setAnnotations([]);
      setPhase({ step: 'idle' });
      setResult(null);
    };
    img.src = url;
  };

  // ---------- canvas drawing ----------

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imageRef.current;
    if (!canvas || !img || !imageSize) return;
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    canvas.width = Math.round(imageSize.width * scale);
    canvas.height = Math.round(imageSize.height * scale);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const drawOBB = (
      rear: [number, number],
      front: [number, number],
      halfW: number,
      color: string,
      label?: string
    ): void => {
      const r = [rear[0] * scale, rear[1] * scale];
      const f = [front[0] * scale, front[1] * scale];
      const hw = halfW * scale;
      const len = Math.hypot(f[0] - r[0], f[1] - r[1]) || 1;
      const ax = (f[0] - r[0]) / len;
      const ay = (f[1] - r[1]) / len;
      const px = -ay;
      const py = ax;

      ctx.strokeStyle = color;
      ctx.fillStyle = color.replace('1)', '0.15)');
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(r[0] + px * hw, r[1] + py * hw);
      ctx.lineTo(f[0] + px * hw, f[1] + py * hw);
      ctx.lineTo(f[0] - px * hw, f[1] - py * hw);
      ctx.lineTo(r[0] - px * hw, r[1] - py * hw);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // facing arrow at the front
      ctx.beginPath();
      ctx.moveTo(f[0], f[1]);
      ctx.lineTo(f[0] - ax * CANVAS.AXIS_MULT + px * CANVAS.POS_MULT, f[1] - ay * CANVAS.AXIS_MULT + py * CANVAS.POS_MULT);
      ctx.lineTo(f[0] - ax * CANVAS.AXIS_MULT - px * CANVAS.POS_MULT, f[1] - ay * CANVAS.AXIS_MULT - py * CANVAS.POS_MULT);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();

      if (label) {
        ctx.font = 'bold 12px monospace';
        ctx.fillStyle = color;
        ctx.fillText(label, r[0] + CANVAS.X_OFFSET, r[1] - CANVAS.Y_OFFSET);
      }
    };

    annotations.forEach((a, i) => {
      drawOBB(a.rear, a.front, a.halfWidthPx, 'rgba(239,68,68,1)', `#${i + 1}`);
    });

    if (phase.step === 'axis' && hover) {
      ctx.strokeStyle = 'rgba(99,102,241,1)';
      ctx.lineWidth = 2;
      ctx.setLineDash([CANVAS.DASH, CANVAS.GAP]);
      ctx.beginPath();
      ctx.moveTo(phase.rear[0] * scale, phase.rear[1] * scale);
      ctx.lineTo(hover[0] * scale, hover[1] * scale);
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (phase.step === 'width' && hover) {
      // Symmetric OBB: half-width = perpendicular distance from axis to cursor
      const hw = Math.max(distToAxis(phase.rear, phase.front, hover), 2);
      drawOBB(phase.rear, phase.front, hw, 'rgba(99,102,241,1)');
    }
  }, [annotations, phase, hover, imageSize, scale]);

  useEffect(() => {
    redraw();
  }, [redraw]);

  const toImagePx = (e: React.MouseEvent<HTMLCanvasElement>): [number, number] => {
    const rect = canvasRef.current?.getBoundingClientRect() ?? {left: CANVAS_MAX_H, top: CANVAS_MAX_W};
    return [(e.clientX - rect.left) / scale, (e.clientY - rect.top) / scale];
  };

  const onCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    if (!imageSize) return;
    const p = toImagePx(e);
    if (phase.step === 'idle') {
      setPhase({ step: 'axis', rear: p });
    } else if (phase.step === 'axis') {
      setPhase({ step: 'width', rear: phase.rear, front: p });
    } else {
      const halfW = Math.max(distToAxis(phase.rear, phase.front, p), 2);
      setAnnotations((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          cls: 'armored_fighting_vehicle',
          rear: phase.rear,
          front: phase.front,
          halfWidthPx: halfW,
        },
      ]);
      setPhase({ step: 'idle' });
    }
  };

  // ---------- pose parsing + deploy ----------

  const parsePose = (): CameraPose | null => {
    try {
      const parsed = JSON.parse(poseText) as CameraPose;
      if (parsed.type !== 'sentinel-camera-pose' || !parsed.camera?.local) {
        setPoseError('Not a sentinel-camera-pose JSON');
        return null;
      }
      setPoseError(null);
      return parsed;
    } catch {
      setPoseError('Invalid JSON');
      return null;
    }
  };

  const deploy = (): void => {
    if (!imageSize || !imageName) return;
    const pose = parsePose();
    if (!pose) return;
    if (pose.image) {
      // Captured via the Capture button — exact dims are known
      if (pose.image.width !== imageSize.width || pose.image.height !== imageSize.height) {
        setPoseError(
          `Warning: pose was captured at ${pose.image.width}×${pose.image.height} but this image is ${imageSize.width}×${imageSize.height} — it was resized or cropped. Placement may be off. Deploying anyway.`
        );
      }
    } else {
      const aspectDelta = Math.abs(imageSize.width / imageSize.height - pose.camera.aspect);
      if (aspectDelta > CANVAS.ASPECT_MIN) {
        setPoseError(
          `Warning: image aspect ${(imageSize.width / imageSize.height).toFixed(2)} ≠ pose aspect ${pose.camera.aspect.toFixed(2)} — screenshot may be cropped. Deploying anyway.`
        );
      }
    }
    setResult(onDeploy(pose, annotations, { ...imageSize, name: imageName }));
  };

  // ---------- render ----------

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-base-200/80 p-4">
      <div className="rounded-box flex max-h-[92vh] w-full max-w-5xl flex-col gap-3 overflow-y-auto bg-base-100 p-6 shadow-xl">
        <div className="flex items-center justify-between">
          <div>
            <span className="text-lg font-bold"><span role='img' aria-label='import'>📥</span> Intel Import</span>
            <span className="ml-3 text-sm text-base-content/50">
              photo + pose → annotate → deploy to world (no AI)
            </span>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button>
        </div>

        {result ? (
          <div className="flex flex-col gap-3">
            <div className="alert alert-success text-sm">
              Deployed {result.placed} detection{result.placed === 1 ? '' : 's'} to the world
              {result.failed > 0 ? ` — ${result.failed} failed (ray missed the mesh)` : ''}.
            </div>
            <div className="text-xs font-semibold uppercase tracking-widest text-base-content/40">
              Sentinel detection schema (what YOLO must emit later)
            </div>
            <pre className="max-h-64 overflow-auto rounded-lg bg-base-200 p-3 text-xs">
              {JSON.stringify(result.detections, null, 2)}
            </pre>
            <div className="flex justify-end gap-2">
              <button
                className="btn btn-sm"
                onClick={() => void navigator.clipboard.writeText(JSON.stringify(result.detections, null, 2))}
              >
                Copy JSON
              </button>
              <button className="btn btn-sm border-none bg-indigo-600 text-white hover:bg-indigo-700" onClick={onClose}>
                Done — view world
              </button>
            </div>
          </div>
        ) : (
          <div className="flex gap-4">
            {/* Left: image + annotation canvas */}
            <div className="flex flex-1 flex-col gap-2">
              <input
                type="file"
                accept="image/*"
                className="file-input file-input-bordered file-input-sm w-full"
                onChange={(e) => onFile(e.target.files?.[0])}
              />
              {imageSize ? (
                <>
                  <canvas
                    ref={canvasRef}
                    className="cursor-crosshair rounded-lg border border-base-300"
                    onClick={onCanvasClick}
                    onMouseMove={(e) => setHover(toImagePx(e))}
                    onMouseLeave={() => setHover(null)}
                  />
                  <div className="text-xs text-base-content/50">
                    {phase.step === 'idle' && 'Click the REAR of a vehicle to start a box'}
                    {phase.step === 'axis' && 'Now click the FRONT (sets length + facing)'}
                    {phase.step === 'width' && 'Now click to set the width'}
                  </div>
                </>
              ) : (
                <div className="flex h-48 items-center justify-center rounded-lg border border-dashed border-base-300 text-sm text-base-content/40">
                  Upload the screenshot you annotated
                </div>
              )}
            </div>

            {/* Right: pose + annotation list */}
            <div className="flex w-80 flex-col gap-2">
              <div className="text-xs font-semibold uppercase tracking-widest text-base-content/40">
                Camera pose (paste from screenshot time)
              </div>
              <textarea
                className="textarea textarea-bordered h-36 font-mono text-[10px] leading-tight"
                value={poseText}
                onChange={(e) => setPoseText(e.target.value)}
                spellCheck={false}
              />
              {poseError && <div className="text-xs text-orange-600">{poseError}</div>}

              <div className="mt-1 text-xs font-semibold uppercase tracking-widest text-base-content/40">
                Annotations ({annotations.length})
              </div>
              <div className="flex max-h-44 flex-col gap-1 overflow-y-auto">
                {annotations.map((a, i) => (
                  <div key={a.id} className="flex items-center gap-2 rounded-lg bg-base-200 px-2 py-1">
                    <span className="text-xs font-bold text-red-500">#{i + 1}</span>
                    <select
                      className="select select-bordered select-xs flex-1"
                      value={a.cls}
                      onChange={(e) =>
                        setAnnotations((prev) =>
                          prev.map((x) =>
                            x.id === a.id ? { ...x, cls: e.target.value as DetectionClass } : x
                          )
                        )
                      }
                    >
                      {DETECTION_CLASSES.map((c) => (
                        <option key={c.id} value={c.id}>{c.label}</option>
                      ))}
                    </select>
                    <button
                      className="btn btn-ghost btn-xs text-red-500"
                      onClick={() => setAnnotations((prev) => prev.filter((x) => x.id !== a.id))}
                    >
                      ✕
                    </button>
                  </div>
                ))}
                {annotations.length === 0 && (
                  <div className="text-xs text-base-content/40">None yet — draw on the image</div>
                )}
              </div>

              <button
                className="btn mt-auto border-none bg-indigo-600 text-white hover:bg-indigo-700"
                disabled={!imageSize || annotations.length === 0 || !poseText.trim()}
                onClick={deploy}
              >
                <span role='img' aria-label='world'>🌍</span> Deploy {annotations.length || ''} to world
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function distToAxis(rear: [number, number], front: [number, number], p: [number, number]): number {
  const ax = front[0] - rear[0];
  const ay = front[1] - rear[1];
  const len = Math.hypot(ax, ay) || 1;
  // perpendicular distance from p to the rear→front line
  return Math.abs(((p[0] - rear[0]) * ay - (p[1] - rear[1]) * ax) / len);
}
