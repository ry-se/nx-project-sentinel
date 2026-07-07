import type { BufferGeometry, Material, Object3D, Texture } from 'three';

interface DisposableOptions {
  disposeMaterials?: boolean;
  disposeTextures?: boolean;
  preserveMaterials?: readonly Material[];
  removeFromParent?: boolean;
}

interface DisposeState {
  geometries: Set<BufferGeometry>;
  materials: Set<Material>;
  textures: Set<Texture>;
}

const DISPOSED_USER_DATA_KEY = '__sentinelDisposed';

function isTexture(value: unknown): value is Texture {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { isTexture?: boolean }).isTexture === true &&
    typeof (value as { dispose?: unknown }).dispose === 'function'
  );
}

function createDisposeState(): DisposeState {
  return {
    geometries: new Set(),
    materials: new Set(),
    textures: new Set(),
  };
}

function markDisposed(object: Object3D): void {
  (object.userData as Record<string, unknown>)[DISPOSED_USER_DATA_KEY] = true;
}

export function isObject3DDisposed(object: Object3D): boolean {
  let current: Object3D | null = object;
  while (current) {
    if ((current.userData as Record<string, unknown>)[DISPOSED_USER_DATA_KEY] === true) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function disposeMaterial(material: Material, options: DisposableOptions, state: DisposeState): void {
  if (options.preserveMaterials?.includes(material)) return;
  if (state.materials.has(material)) return;
  state.materials.add(material);

  if (options.disposeTextures !== false) {
    for (const value of Object.values(material as unknown as Record<string, unknown>)) {
      if (isTexture(value) && !state.textures.has(value)) {
        state.textures.add(value);
        value.dispose();
      }
    }
  }

  material.dispose();
}

/** Dispose GPU resources held by an Object3D subtree before removing it from the scene. */
export function disposeObject3D(
  root: Object3D,
  options: DisposableOptions = {},
  state: DisposeState = createDisposeState()
): void {
  root.traverse((object) => {
    markDisposed(object);
    const withAssets = object as Object3D & {
      geometry?: BufferGeometry;
      material?: Material | Material[];
    };

    if (withAssets.geometry && !state.geometries.has(withAssets.geometry)) {
      state.geometries.add(withAssets.geometry);
      withAssets.geometry.dispose();
    }

    if (options.disposeMaterials !== false && withAssets.material) {
      const materials = Array.isArray(withAssets.material) ? withAssets.material : [withAssets.material];
      for (const material of materials) disposeMaterial(material, options, state);
    }
  });

  if (options.removeFromParent !== false) root.removeFromParent();
}

export function disposeObjectChildren(root: Object3D, options: DisposableOptions = {}): void {
  const state = createDisposeState();
  for (const child of [...root.children]) disposeObject3D(child, options, state);
}
