import { Box3, Color, Group, Mesh, MeshStandardMaterial, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';

import { SANDBOX_MISC } from '@/constants';

/**
 * Central model catalogue. Drop a .glb into apps/frontend/public/models/ and
 * register it here — every consumer (player vehicles, hostile detections,
 * future friendly units) pulls from this registry. Models are auto-normalised
 * (faces +Z, bottom at y=0, scaled to targetLength), so arbitrary downloads
 * work without hand-tuning. If a file is missing the primitive fallback stays.
 */
export interface ModelDef {
  label: string;
  /** Path under /public (e.g. '/models/tank.glb') or a full URL. */
  url: string;
  /** Hull length in metres — the model is uniformly scaled to match. */
  targetLength: number;
  /** Yaw correction (radians) if the source model doesn't face +Z. */
  rotationY?: number;
}

export const MODEL_CATALOG: Record<string, ModelDef> = {
  tank: { label: 'Main battle tank', url: '/models/tank.glb', targetLength: 7.5 },
  car: { label: 'Sports car', url: '/models/car.glb', targetLength: 4.6, rotationY: Math.PI },
  jet: { label: 'Jet aircraft', url: '/models/jet.glb', targetLength: 12 },
};

export class ModelLibrary {
  private loader: GLTFLoader;
  private cache = new Map<string, Promise<Group | null>>();

  constructor() {
    this.loader = new GLTFLoader();
    const draco = new DRACOLoader();
    draco.setDecoderPath('https://www.gstatic.com/draco/v1/decoders/');
    this.loader.setDRACOLoader(draco);
  }

  private load(id: string, def: ModelDef): Promise<Group | null> {
    let pending = this.cache.get(id);
    if (!pending) {
      pending = this.loader
        .loadAsync(def.url)
        .then((gltf) => normalise(gltf.scene as unknown as Group, def))
        .catch(() => {
          console.warn(`[models] '${id}' not available at ${def.url} — using primitive fallback`);
          return null;
        });
      this.cache.set(id, pending);
    }
    return pending;
  }

  /**
   * Returns a group immediately (containing the primitive fallback); when the
   * catalogue GLB finishes loading it is swapped in transparently.
   */
  public instance(id: string, fallback: () => Group, tintHex?: number): Group {
    const holder = new Group();
    const fb = fallback();
    holder.add(fb);

    const def = MODEL_CATALOG[id];
    if (def) {
      void this.load(id, def).then((model) => {
        if (!model) return;
        const clone = model.clone(true);
        if (tintHex !== undefined) tint(clone, tintHex);
        clone.traverse((o) => o.layers.set(1));
        holder.remove(fb);
        holder.add(clone);
      });
    }
    return holder;
  }
}

/** Face +Z, bottom at y = 0, centred in XZ, scaled to targetLength. */
function normalise(scene: Group, def: ModelDef): Group {
  const model = scene;
  if (def.rotationY) model.rotation.y = def.rotationY;
  model.updateMatrixWorld(true);

  const box = new Box3().setFromObject(model);
  const size = box.getSize(new Vector3());
  const length = Math.max(size.z, SANDBOX_MISC.MODEL_LENGTH_EPSILON);
  model.scale.setScalar(def.targetLength / length);
  model.updateMatrixWorld(true);

  const scaled = new Box3().setFromObject(model);
  const center = scaled.getCenter(new Vector3());
  model.position.x -= center.x;
  model.position.z -= center.z;
  model.position.y -= scaled.min.y;

  const wrapper = new Group();
  wrapper.add(model);
  return wrapper;
}

/** Clone materials and blend toward a colour (e.g. hostile red). */
function tint(root: Group, hex: number): void {
  const target = new Color(hex);
  root.traverse((obj) => {
    const mesh = obj as Mesh;
    if (!mesh.isMesh) return;
    const wasArray = Array.isArray(mesh.material);
    const materials = wasArray ? (mesh.material as MeshStandardMaterial[]) : [mesh.material as MeshStandardMaterial];
    const tinted = materials.map((m) => {
      const cloned = m.clone();
      if (cloned.color) cloned.color.lerp(target, SANDBOX_MISC.MODEL_TINT_BLEND);
      return cloned;
    });
    mesh.material = wasArray ? tinted : tinted[0];
  });
}
