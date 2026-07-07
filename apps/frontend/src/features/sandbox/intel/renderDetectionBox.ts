import { CANVAS } from '@/constants/canvas';

/** Draws one oriented bounding box (rear→front axis + width) on a canvas already scaled
 * to `scale`. Shared by IntelImport's manual/auto annotation canvas and the standalone
 * detect-debug tool — both need the identical box shape so what you see in either place
 * matches what deployFromImage will actually reproject. */
export function drawOBB(
  ctx: CanvasRenderingContext2D,
  rear: [number, number],
  front: [number, number],
  halfWidthPx: number,
  color: string,
  scale: number,
  label?: string
): void {
  const r = [rear[0] * scale, rear[1] * scale];
  const f = [front[0] * scale, front[1] * scale];
  const hw = halfWidthPx * scale;
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
  ctx.lineTo(
    f[0] - ax * CANVAS.AXIS_MULT + px * CANVAS.POS_MULT,
    f[1] - ay * CANVAS.AXIS_MULT + py * CANVAS.POS_MULT
  );
  ctx.lineTo(
    f[0] - ax * CANVAS.AXIS_MULT - px * CANVAS.POS_MULT,
    f[1] - ay * CANVAS.AXIS_MULT - py * CANVAS.POS_MULT
  );
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();

  if (label) {
    ctx.font = 'bold 12px monospace';
    ctx.fillStyle = color;
    ctx.fillText(label, r[0] + CANVAS.X_OFFSET, r[1] - CANVAS.Y_OFFSET);
  }
}
