import {
  Box3,
  type BufferGeometry,
  Color,
  Group,
  type Material,
  Mesh,
  MeshStandardMaterial,
  type Texture,
  Vector3,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';

import { disposeObject3D, isObject3DDisposed } from './disposeThree';

import { SANDBOX_MISC } from '@/constants/sandbox';

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
  private draco: DRACOLoader;
  private cache = new Map<string, Promise<Group | null>>();
  private disposed = false;

  constructor() {
    this.loader = new GLTFLoader();
    this.draco = new DRACOLoader();
    this.draco.setDecoderPath('https://www.gstatic.com/draco/v1/decoders/');
    this.loader.setDRACOLoader(this.draco);
  }

  private load(id: string, def: ModelDef): Promise<Group | null> {
    if (this.disposed) return Promise.resolve(null);
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
    if (def && !this.disposed) {
      void this.load(id, def).then((model) => {
        if (this.disposed || !model || !holder.parent || isObject3DDisposed(holder)) return;
        const clone = cloneOwnedModel(model);
        if (tintHex !== undefined) tint(clone, tintHex);
        clone.traverse((o) => o.layers.set(1));
        if (this.disposed || !holder.parent || isObject3DDisposed(holder)) {
          disposeObject3D(clone);
          return;
        }
        disposeObject3D(fb);
        holder.add(clone);
      });
    }
    return holder;
  }

  public dispose(): void {
    this.disposed = true;
    for (const pending of this.cache.values()) {
      void pending.then((model) => {
        if (model) disposeObject3D(model);
      });
    }
    this.cache.clear();
    this.draco.dispose();
  }
}

function cloneOwnedModel(model: Group): Group {
  const clone = model.clone(true);
  clone.traverse((obj) => {
    const mesh = obj as Mesh & { geometry?: BufferGeometry; material?: Material | Material[] };
    if (!mesh.isMesh) return;
    if (mesh.geometry) mesh.geometry = mesh.geometry.clone();
    if (Array.isArray(mesh.material)) {
      mesh.material = mesh.material.map((material) => cloneOwnedMaterial(material));
    } else if (mesh.material) {
      mesh.material = cloneOwnedMaterial(mesh.material);
    }
  });
  return clone;
}

function isTexture(value: unknown): value is Texture {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { isTexture?: boolean }).isTexture === true
  );
}

function cloneOwnedMaterial<T extends Material>(material: T): T {
  const cloned = material.clone();
  for (const [key, value] of Object.entries(cloned as unknown as Record<string, unknown>)) {
    if (isTexture(value)) {
      (cloned as unknown as Record<string, unknown>)[key] = value.clone();
    }
  }
  return cloned as T;
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
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      const standardMaterial = material as MeshStandardMaterial;
      if (standardMaterial.color) standardMaterial.color.lerp(target, SANDBOX_MISC.MODEL_TINT_BLEND);
    }
  });
}
