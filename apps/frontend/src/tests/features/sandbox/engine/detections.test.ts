import { Group, Mesh, MeshStandardMaterial, RingGeometry, Scene, Sprite, Vector3 } from 'three';

import {
  confidenceToRingOpacity,
  DETECTION_CLASS_TO_BATTLE_UNIT,
  DetectionLayer,
  type ProjectedIntelContact,
  type SentinelDetection,
} from '../../../../features/sandbox/engine/detections';
import { ModelLibrary } from '../../../../features/sandbox/engine/modelCatalog';

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

function createModelLibraryStub(): ModelLibrary {
  return {
    instance: (_id: string, fallback: () => Group): Group => fallback(),
  } as unknown as ModelLibrary;
}

function findRegisteredParts(
  scene: Scene,
  detectionId: string
): {
  group: Group;
  model: Group;
  ring: Mesh<RingGeometry, MeshStandardMaterial>;
  tag: Sprite;
} {
  const group = scene.getObjectByName(`sentinel-detection-${detectionId}`);
  const model = scene.getObjectByName(`sentinel-detection-model-${detectionId}`);
  if (!(group instanceof Group) || !(model instanceof Group)) {
    throw new Error(`registered detection ${detectionId} not found`);
  }
  let ring: Mesh<RingGeometry, MeshStandardMaterial> | undefined;
  let tag: Sprite | undefined;
  group.traverse((object) => {
    if (object instanceof Mesh && object.geometry instanceof RingGeometry) {
      ring = object as Mesh<RingGeometry, MeshStandardMaterial>;
    }
    if (object instanceof Sprite) tag = object;
  });
  if (!ring || !tag) throw new Error(`registered detection ${detectionId} is incomplete`);
  return { group, model, ring, tag };
}

function fixtureDetection(): SentinelDetection {
  return {
    detection_id: 'det-1',
    image_id: 'image-1',
    class: 'armored_fighting_vehicle',
    confidence: 0.8,
    bbox_pixel: { x: 10, y: 20, w: 30, h: 40, theta: 0 },
    lat: 1.3,
    lon: 103.8,
    world_heading: 90,
    heading_confidence: 'high',
    timestamp: '2026-07-10T00:00:00.000Z',
    source_image_url: 'sentinel://image-1',
    method: 'auto',
    model: 'fixture-model',
  };
}

describe('intel contact -> battle unit bridge', () => {
  it('maps every locked detection class to its battle-unit equivalent', () => {
    expect(DETECTION_CLASS_TO_BATTLE_UNIT).toEqual({
      armored_fighting_vehicle: 'tank',
      light_military_vehicle: 'car',
      aircraft: 'jet',
    });
  });

  it('keeps projected contacts as serializable plain world coordinates', () => {
    const contact: ProjectedIntelContact = {
      detection: fixtureDetection(),
      worldPosition: { x: 125, y: 18, z: -44 },
      localHeadingRad: Math.PI / 2,
    };

    expect(contact.worldPosition).toEqual({ x: 125, y: 18, z: -44 });
    expect(contact.detection.detection_id).toBe('det-1');
  });
});

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

  it('suppresses the intel model while retaining subdued provenance cues for battle-linked contacts', () => {
    const scene = new Scene();
    const layer = new DetectionLayer(scene, createModelLibraryStub());
    layer.spawn(new Vector3(0, 0, 0), 0, 'armored_fighting_vehicle', 'AFV-1', {
      confidence: 0.8,
      uncertaintyM: 18,
      detectionId: 'det-1',
    });
    const parts = findRegisteredParts(scene, 'det-1');
    const baseRingOpacity = parts.ring.material.opacity;

    layer.setBattleLinked(['missing-id', 'det-1'], true);

    expect(layer.count).toBe(1);
    expect(parts.group.visible).toBe(true);
    expect(parts.model.visible).toBe(false);
    expect(parts.ring.visible).toBe(true);
    expect(parts.ring.material.opacity).toBeGreaterThan(0);
    expect(parts.ring.material.opacity).toBeLessThan(baseRingOpacity);
    expect(parts.tag.visible).toBe(true);
    expect(parts.tag.material.opacity).toBeGreaterThan(0);
    expect(parts.tag.material.opacity).toBeLessThan(1);
    expect(parts.group.userData.battleLinked).toBe(true);

    layer.setBattleLinked(['det-1'], false);

    expect(parts.model.visible).toBe(true);
    expect(parts.ring.material.opacity).toBeCloseTo(baseRingOpacity);
    expect(parts.tag.material.opacity).toBe(1);
    expect(parts.group.userData.battleLinked).toBe(false);
    layer.dispose();
  });

  it('replaces duplicate IDs and clears per-ID references on clear and dispose', () => {
    const scene = new Scene();
    const layer = new DetectionLayer(scene, createModelLibraryStub());
    const spawn = (x: number) =>
      layer.spawn(new Vector3(x, 0, 0), 0, 'aircraft', 'AIR-1', {
        detectionId: 'det-1',
      });

    spawn(0);
    const first = findRegisteredParts(scene, 'det-1');
    spawn(0);
    const replacement = findRegisteredParts(scene, 'det-1');

    expect(replacement.group).not.toBe(first.group);
    expect(first.group.parent).toBeNull();
    expect(layer.count).toBe(1);

    replacement.model.visible = true;
    layer.clear();
    expect(layer.count).toBe(0);
    expect(() => layer.setBattleLinked(['det-1'], true)).not.toThrow();
    expect(replacement.model.visible).toBe(true);

    spawn(0);
    const afterClear = findRegisteredParts(scene, 'det-1');
    layer.setBattleLinked(['det-1'], true);
    expect(afterClear.model.visible).toBe(false);

    afterClear.model.visible = true;
    layer.dispose();
    layer.setBattleLinked(['det-1'], true);
    expect(afterClear.model.visible).toBe(true);
  });
});
