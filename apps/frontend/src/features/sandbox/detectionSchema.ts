export type DetectionClass = 'armored_fighting_vehicle' | 'light_military_vehicle' | 'aircraft';

export const DETECTION_CLASSES: Array<{ id: DetectionClass; label: string }> = [
  { id: 'armored_fighting_vehicle', label: 'AFV (tank)' },
  { id: 'light_military_vehicle', label: 'LMV (light vehicle)' },
  { id: 'aircraft', label: 'Aircraft' },
];
