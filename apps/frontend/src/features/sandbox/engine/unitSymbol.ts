import { CanvasTexture, Group, Sprite, SpriteMaterial, Vector3 } from 'three';

export type Affiliation = 'friendly' | 'enemy' | 'neutral';
export type Echelon =
  | 'team'
  | 'squad'
  | 'section'
  | 'platoon'
  | 'company'
  | 'battalion'
  | 'brigade';

/** Fixed affiliation → color mapping (invariant 1) — deterministic, not per-placement freehand. */
export const AFFILIATION_COLOR: Record<Affiliation, number> = {
  friendly: 0x2979ff,
  enemy: 0xe53935,
  neutral: 0x43a047,
};

const ECHELON_ORDER: Echelon[] = [
  'team',
  'squad',
  'section',
  'platoon',
  'company',
  'battalion',
  'brigade',
];

export const ECHELON_ABBR: Record<Echelon, string> = {
  team: 'TM',
  squad: 'SQD',
  section: 'SEC',
  platoon: 'PL',
  company: 'CO',
  battalion: 'BN',
  brigade: 'BDE',
};

/** Echelon "ticks" (simplified subset-symbology, D-Army-3(b) — NOT full APP-6 size marks):
 * team=1 dot through brigade=7 dots, rendered above the unit frame. */
export function echelonTickCount(echelon: Echelon): number {
  return ECHELON_ORDER.indexOf(echelon) + 1;
}

export interface UnitMetadata {
  affiliation: Affiliation;
  echelon: Echelon;
}

/** Reads `{ affiliation, echelon }` out of a `PlanFeature.metadata` bag, falling back to
 * safe defaults if either key is missing or malformed (defensive against hand-edited/older
 * saved data — metadata is an open `Record<string, unknown>`, not a typed contract). */
export function readUnitMetadata(metadata: Record<string, unknown>): UnitMetadata {
  const affiliation = metadata.affiliation as Affiliation | undefined;
  const echelon = metadata.echelon as Echelon | undefined;
  return {
    affiliation: affiliation && affiliation in AFFILIATION_COLOR ? affiliation : 'friendly',
    echelon: echelon && ECHELON_ORDER.includes(echelon) ? echelon : 'platoon',
  };
}

function buildSymbolSprite(affiliation: Affiliation, echelon: Echelon, text: string): Sprite {
  const color = AFFILIATION_COLOR[affiliation];
  const colorHex = `#${color.toString(16).padStart(6, '0')}`;

  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;

  // frame
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(30, 70, 196, 130);
  ctx.strokeStyle = colorHex;
  ctx.lineWidth = 10;
  ctx.strokeRect(30, 70, 196, 130);

  // echelon ticks (dots) above the frame
  const ticks = echelonTickCount(echelon);
  const spacing = 22;
  const startX = 128 - ((ticks - 1) * spacing) / 2;
  ctx.fillStyle = colorHex;
  for (let i = 0; i < ticks; i++) {
    ctx.beginPath();
    ctx.arc(startX + i * spacing, 40, 7, 0, Math.PI * 2);
    ctx.fill();
  }

  // unit designator label
  ctx.font = 'bold 42px monospace';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, 128, 150);

  const sprite = new Sprite(
    new SpriteMaterial({ map: new CanvasTexture(canvas), depthTest: false, transparent: true })
  );
  const w = 26;
  sprite.scale.set(w, w * (canvas.height / canvas.width), 1);
  sprite.renderOrder = 1000; // above ground features (invariant 3)
  return sprite;
}

/** How far above the clicked ground point the symbol sprite floats — shared by
 * `buildUnitSymbolGroup` (draw time) and `repositionUnitSymbolGroup` (todo 26 timeline
 * movement), so a unit repositioned between phases floats at the identical height as one
 * freshly placed. */
export const UNIT_SPRITE_LIFT_M = 6;

/** A billboarded unit-symbol sprite at `point` — frame color by affiliation, echelon
 * ticks, and a short designator label (e.g. "2 PL"). */
export function buildUnitSymbolGroup(
  point: Vector3,
  affiliation: Affiliation,
  echelon: Echelon,
  name: string
): Group {
  const g = new Group();
  const sprite = buildSymbolSprite(affiliation, echelon, name);
  sprite.position.copy(point).add(new Vector3(0, UNIT_SPRITE_LIFT_M, 0));
  g.add(sprite);
  return g;
}

/** Moves an already-built unit symbol group to a new ground point (todo 26 — a unit's
 * position advancing between phases) — repositions the sprite CHILD, not the group itself
 * (the group's own transform stays at origin; `buildUnitSymbolGroup` bakes the absolute
 * position into the sprite, so moving the group would double-offset it). */
export function repositionUnitSymbolGroup(group: Group, point: Vector3): void {
  const sprite = group.children[0];
  if (!sprite) return;
  sprite.position.copy(point).add(new Vector3(0, UNIT_SPRITE_LIFT_M, 0));
}
