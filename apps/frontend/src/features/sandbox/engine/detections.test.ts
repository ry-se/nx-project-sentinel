import { Mesh, MeshStandardMaterial, RingGeometry, Scene, Vector3 } from 'three';

import { confidenceToRingOpacity, DetectionLayer } from './detections';
import { ModelLibrary } from './modelCatalog';

/** jsdom has no native canvas 2D implementation — makeTag()'s canvas.getContext('2d')
 * would return null and throw. A permissive Proxy (same pattern IntelImport.test.tsx
 * uses) keeps spawn() runnable without asserting on canvas-drawn pixel content, which
 * would be fragile and low-value here. measureText is special-cased (unlike
 * IntelImport.test.tsx's fixture) because makeTag() reads `.width` off its return value
 * — a bare vi.fn() call returns undefined, which throws on property access. */
function fakeCanvasContext() {
  const measureText = () => ({ width: 42 });
  return new Proxy(
    { measureText },
    {
      get: (target, prop) => (prop in target ? (target as never)[prop] : vi.fn()),
    }
  );
}

function findRingMesh(scene: Scene): Mesh {
  let found: Mesh | undefined;
  scene.traverse((o) => {
    if (o instanceof Mesh && o.geometry instanceof RingGeometry) found = o;
  });
  if (!found) throw new Error('ring mesh not found in scene — spawn() did not add it');
  return found;
}

describe('confidenceToRingOpacity', () => {
  it('maps full confidence (1.0) to the pre-W4 constant opacity (0.7) — no visual regression', () => {
    expect(confidenceToRingOpacity(1.0)).toBeCloseTo(0.7);
  });

  it('maps zero confidence to a visibly fainter opacity than full confidence', () => {
    expect(confidenceToRingOpacity(0)).toBeCloseTo(0.2);
    expect(confidenceToRingOpacity(0)).toBeLessThan(confidenceToRingOpacity(1.0));
  });

  it('is monotonically increasing across the [0,1] range', () => {
    const low = confidenceToRingOpacity(0.2);
    const mid = confidenceToRingOpacity(0.5);
    const high = confidenceToRingOpacity(0.9);
    expect(low).toBeLessThan(mid);
    expect(mid).toBeLessThan(high);
  });

  it('clamps out-of-range inputs instead of producing an invalid opacity', () => {
    expect(confidenceToRingOpacity(-1)).toBeCloseTo(0.2);
    expect(confidenceToRingOpacity(5)).toBeCloseTo(0.7);
  });
});

describe('DetectionLayer.spawn — confidence -> ring opacity wiring', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      fakeCanvasContext() as unknown as CanvasRenderingContext2D
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a low-confidence detection renders visibly fainter than a high-confidence one', () => {
    const sceneLow = new Scene();
    new DetectionLayer(sceneLow, new ModelLibrary()).spawn(
      new Vector3(0, 0, 0),
      0,
      'armored_fighting_vehicle',
      'AFV-1',
      { confidence: 0.1 }
    );
    const lowOpacity = (findRingMesh(sceneLow).material as MeshStandardMaterial).opacity;

    const sceneHigh = new Scene();
    new DetectionLayer(sceneHigh, new ModelLibrary()).spawn(
      new Vector3(0, 0, 0),
      0,
      'armored_fighting_vehicle',
      'AFV-1',
      { confidence: 0.95 }
    );
    const highOpacity = (findRingMesh(sceneHigh).material as MeshStandardMaterial).opacity;

    expect(lowOpacity).toBeLessThan(highOpacity);
  });

  it('omitting confidence (manual annotation path) defaults to full opacity — no regression', () => {
    const scene = new Scene();
    new DetectionLayer(scene, new ModelLibrary()).spawn(
      new Vector3(0, 0, 0),
      0,
      'light_military_vehicle',
      'LMV-1'
    );
    const opacity = (findRingMesh(scene).material as MeshStandardMaterial).opacity;
    expect(opacity).toBeCloseTo(0.7);
  });
});
