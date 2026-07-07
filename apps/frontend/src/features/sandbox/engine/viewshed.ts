import {
  CameraHelper,Color, Material, Matrix4, Mesh, MeshDepthMaterial, NoBlending,
  Object3D, PerspectiveCamera, RGBADepthPacking, Scene, Vector3,
  WebGLRenderer, WebGLRenderTarget,
} from 'three'
import type { TilesRenderer } from '3d-tiles-renderer'

import { disposeObject3D } from './disposeThree'

import { VIEWSHED } from '@/constants/engine'

/**
 * ArcGIS-style viewshed: renders a depth map from an observer's eye and tints
 * every photogrammetry fragment green (visible) or red (hidden) by comparing
 * its distance against that depth map — classic shadow-mapping, repurposed.
 */
export class ViewshedController {
  private depthCam: PerspectiveCamera
  private depthTarget: WebGLRenderTarget
  private depthMaterial = new MeshDepthMaterial({ depthPacking: RGBADepthPacking, blending: NoBlending })
  private helper: CameraHelper | null = null
  private scene: Scene
  private tiles: TilesRenderer
  private enabled = false
  private readonly onLoadModel = (e: { scene: Object3D }): void => this.patchModel(e.scene)

  private uniforms = {
    uVsEnabled: { value: 0 },
    uVsMatrix: { value: new Matrix4() },
    uVsDepth: { value: null as WebGLRenderTarget['texture'] | null },
  }

  constructor(scene: Scene, tiles: TilesRenderer) {
    this.scene = scene
    this.tiles = tiles
    this.depthCam = new PerspectiveCamera(VIEWSHED.V_FOV_DEG, hAspect(), 2, VIEWSHED.FAR_PLANE)
    this.depthCam.layers.set(0) // tiles only — overlays/tank live on layer 1
    this.depthTarget = new WebGLRenderTarget(VIEWSHED.DEPTH_RES, VIEWSHED.DEPTH_RES)
    this.uniforms.uVsDepth.value = this.depthTarget.texture

    // Patch every tile material (current and future) with the viewshed shader
    tiles.forEachLoadedModel(model => this.patchModel(model))
    tiles.addEventListener('load-model', this.onLoadModel)
  }

  /** Aim the analysis wedge from observer toward target; range = distance. */
  public aim(observerGround: Vector3, targetGround: Vector3): void {
    const obs = observerGround.clone()
    obs.y += VIEWSHED.EYE_HEIGHT
    const tgt = targetGround.clone()
    tgt.y += VIEWSHED.EYE_HEIGHT

    const range = Math.max(obs.distanceTo(tgt), VIEWSHED.DEPTH_MIN)
    this.depthCam.position.copy(obs)
    this.depthCam.far = range
    this.depthCam.aspect = hAspect()
    this.depthCam.updateProjectionMatrix()
    this.depthCam.lookAt(tgt)
    this.depthCam.updateMatrixWorld(true)

    this.uniforms.uVsMatrix.value
      .multiplyMatrices(this.depthCam.projectionMatrix, this.depthCam.matrixWorldInverse)
    this.uniforms.uVsEnabled.value = 1
    this.enabled = true

    if (!this.helper) {
      this.helper = new CameraHelper(this.depthCam)
      this.helper.traverse(o => o.layers.set(1))
      this.scene.add(this.helper)
    }
    this.helper.update()
    this.helper.visible = true
  }

  public disable(): void {
    this.enabled = false
    this.uniforms.uVsEnabled.value = 0
    if (this.helper) this.helper.visible = false
  }

  public get active(): boolean {
    return this.enabled
  }

  public dispose(): void {
    this.disable()
    this.tiles.removeEventListener('load-model', this.onLoadModel)
    if (this.helper) {
      disposeObject3D(this.helper)
      this.helper = null
    }
    this.depthTarget.dispose()
    this.depthMaterial.dispose()
    this.uniforms.uVsDepth.value = null
  }

  /** Re-render the observer depth map. Call once per frame while active —
   *  this keeps the analysis correct as higher-detail tiles stream in. */
  public update(renderer: WebGLRenderer): void {
    if (!this.enabled) return

    const prevTarget = renderer.getRenderTarget()
    const prevOverride = this.scene.overrideMaterial
    const prevBackground = this.scene.background
    const prevFog = this.scene.fog
    const prevClear = new Color()
    renderer.getClearColor(prevClear)
    const prevAlpha = renderer.getClearAlpha()

    this.scene.overrideMaterial = this.depthMaterial
    this.scene.background = null
    this.scene.fog = null
    renderer.setClearColor(VIEWSHED.WHITE, 1) // cleared = max depth = unoccluded
    renderer.setRenderTarget(this.depthTarget)
    renderer.clear()
    renderer.render(this.scene, this.depthCam)

    renderer.setRenderTarget(prevTarget)
    renderer.setClearColor(prevClear, prevAlpha)
    this.scene.overrideMaterial = prevOverride
    this.scene.background = prevBackground
    this.scene.fog = prevFog
  }

  // ---------- shader patching ----------

  private patchModel(model: Object3D): void {
    model.traverse(obj => {
      const mesh = obj as Mesh
      if (!mesh.isMesh) return
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const mat of materials) this.patchMaterial(mat)
    })
  }

  private patchMaterial(material: Material): void {
    if ((material.userData as { vsPatched?: boolean }).vsPatched) return
    ;(material.userData as { vsPatched?: boolean }).vsPatched = true

    const uniforms = this.uniforms
    material.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, uniforms)

      shader.vertexShader = 'varying vec3 vVsWorldPos;\n' + shader.vertexShader.replace(
        '#include <project_vertex>',
        '#include <project_vertex>\n  vVsWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      )

      shader.fragmentShader = `
uniform float uVsEnabled;
uniform mat4 uVsMatrix;
uniform sampler2D uVsDepth;
varying vec3 vVsWorldPos;

float vsUnpackDepth(const in vec4 v) {
  const float UnpackDownscale = 255. / 256.;
  const vec3 PackFactors = vec3(256. * 256. * 256., 256. * 256., 256.);
  const vec4 UnpackFactors = UnpackDownscale / vec4(PackFactors, 1.);
  return dot(v, UnpackFactors);
}

vec3 vsApply(vec3 color) {
  if (uVsEnabled < 0.5) return color;
  vec4 clip = uVsMatrix * vec4(vVsWorldPos, 1.0);
  if (clip.w <= 0.0) return color;
  vec3 ndc = clip.xyz / clip.w;
  if (abs(ndc.x) > 1.0 || abs(ndc.y) > 1.0 || ndc.z > 1.0 || ndc.z < -1.0) return color;
  vec2 uv = ndc.xy * 0.5 + 0.5;
  float mapDepth = vsUnpackDepth(texture2D(uVsDepth, uv));
  float fragDepth = ndc.z * 0.5 + 0.5;
  bool visible = fragDepth - 0.0015 <= mapDepth;
  vec3 tint = visible ? vec3(0.25, 1.0, 0.35) : vec3(1.0, 0.22, 0.18);
  return mix(color, tint, 0.40);
}
` + shader.fragmentShader.replace(
        '#include <dithering_fragment>',
        '#include <dithering_fragment>\n  gl_FragColor.rgb = vsApply(gl_FragColor.rgb);',
      )
    }
    material.needsUpdate = true
  }
}

function hAspect(): number {
  // aspect = tan(hfov/2) / tan(vfov/2)
  return Math.tan((VIEWSHED.H_FOV_DEG * Math.PI) / VIEWSHED.BALL_DEG) / Math.tan((VIEWSHED.V_FOV_DEG * Math.PI) / VIEWSHED.BALL_DEG)
}
