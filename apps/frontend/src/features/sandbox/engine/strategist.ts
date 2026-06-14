import {
  BufferGeometry, CanvasTexture, DoubleSide, EdgesGeometry, ExtrudeGeometry,
  Group, Line, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial,
  Object3D, PerspectiveCamera, Plane, Raycaster, Scene, Shape, ShapeGeometry,
  SphereGeometry, Sprite, SpriteMaterial, Vector2, Vector3,
} from 'three'

import type { ViewshedController } from './viewshed'

export type StratTool = 'select' | 'distance' | 'focus' | 'arc' | 'los' | 'viewshed'

export const TOOL_HINTS: Record<StratTool, string> = {
  select: 'SELECT — drag to pan, right-drag to orbit, scroll to zoom',
  distance: 'DISTANCE — click waypoints, right-click to finish',
  focus: 'FOCUS AREA — click 3+ corners, right-click to close',
  arc: 'FIRE ARC — click ① weapon ② max-range point ③ end bearing',
  los: 'LINE OF SIGHT — click observer, then target. Buildings block the ray.',
  viewshed: 'VIEWSHED — click observer, aim with mouse (green = seen, red = hidden), click to lock',
}

const EYE_HEIGHT = 2 // metres above clicked surface for LOS endpoints

const MAT_MEASURE = new LineBasicMaterial({ color: 0x35d4ff, depthTest: false, transparent: true })
const MAT_LOS_CLEAR = new LineBasicMaterial({ color: 0x55ff55, depthTest: false, transparent: true })
const MAT_LOS_BLOCKED = new LineBasicMaterial({ color: 0xff4444, depthTest: false, transparent: true })

interface Feature {
  id: string
  tool: StratTool
  group: Group
}

export class StrategistController {
  enabled = false
  tool: StratTool = 'select'
  onStatus: (text: string) => void = () => {}

  private camera: PerspectiveCamera
  private canvas: HTMLCanvasElement
  private tiles: Object3D
  private raycaster = new Raycaster()
  private draft: Vector3[] = []
  private hover: Vector3 | null = null
  private features: Feature[] = []
  private featureRoot = new Group()
  private previewRoot = new Group()
  private pivot = new Vector3()

  private dragButton = -1
  private dragged = false
  private lastX = 0
  private lastY = 0
  private panAnchorY = 0
  private lastPreviewAt = 0

  private viewshed: ViewshedController

  constructor(
    camera: PerspectiveCamera,
    canvas: HTMLCanvasElement,
    tiles: Object3D,
    scene: Scene,
    viewshed: ViewshedController,
  ) {
    this.camera = camera
    this.canvas = canvas
    this.tiles = tiles
    this.viewshed = viewshed
    scene.add(this.featureRoot)
    scene.add(this.previewRoot)
    this.featureRoot.renderOrder = 999
    ;(this.raycaster as unknown as { firstHitOnly: boolean }).firstHitOnly = true

    canvas.addEventListener('pointerdown', this.onDown)
    window.addEventListener('pointermove', this.onMove)
    window.addEventListener('pointerup', this.onUp)
    canvas.addEventListener('wheel', this.onWheel, { passive: false })
    canvas.addEventListener('contextmenu', e => { if (this.enabled) e.preventDefault() })
    window.addEventListener('keydown', e => {
      if (this.enabled && e.key === 'Escape') this.cancelDraft()
    })
  }

  enable(center: Vector3): void {
    this.enabled = true
    this.pivot.copy(center)
    this.camera.position.set(center.x + 100, center.y + 500, center.z + 380)
    this.camera.lookAt(this.pivot)
    this.setTool('select')
  }

  disable(): void {
    this.enabled = false
    this.cancelDraft()
  }

  setTool(tool: StratTool): void {
    this.cancelDraft()
    this.tool = tool
    this.onStatus(TOOL_HINTS[tool])
  }

  clearAll(): void {
    this.cancelDraft()
    for (const f of this.features) this.featureRoot.remove(f.group)
    this.features = []
    this.viewshed.disable()
    this.onStatus('All features cleared')
  }

  get featureCount(): number {
    return this.features.length
  }

  // ---------- picking ----------

  private ndc(e: PointerEvent | WheelEvent): Vector2 {
    const rect = this.canvas.getBoundingClientRect()
    return new Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    )
  }

  private pick(e: PointerEvent): Vector3 | null {
    this.raycaster.setFromCamera(this.ndc(e), this.camera)
    this.raycaster.far = Infinity
    const hits = this.raycaster.intersectObject(this.tiles, true)
    return hits.length > 0 ? hits[0].point.clone() : null
  }

  // ---------- camera controls ----------

  private onDown = (e: PointerEvent): void => {
    if (!this.enabled) return
    this.dragButton = e.button
    this.dragged = false
    this.lastX = e.clientX
    this.lastY = e.clientY
    const hit = this.pick(e)
    this.panAnchorY = hit ? hit.y : this.pivot.y
  }

  private onMove = (e: PointerEvent): void => {
    if (!this.enabled) return

    if (this.dragButton === 0 || this.dragButton === 2) {
      const dx = e.clientX - this.lastX
      const dy = e.clientY - this.lastY
      if (Math.abs(dx) + Math.abs(dy) > 3) this.dragged = true

      if (this.dragged) {
        if (this.dragButton === 0) this.pan(e)
        else this.orbit(dx, dy)
      }
      this.lastX = e.clientX
      this.lastY = e.clientY
      return
    }

    // hover preview while drafting (throttled — raycasts against the tileset)
    if (this.draft.length > 0 && performance.now() - this.lastPreviewAt > 33) {
      this.lastPreviewAt = performance.now()
      this.hover = this.pick(e)
      this.updatePreview()
    }
  }

  private onUp = (e: PointerEvent): void => {
    if (!this.enabled) return
    const wasDragged = this.dragged
    const button = this.dragButton
    this.dragButton = -1
    this.dragged = false
    if (wasDragged) return

    if (button === 0 && this.tool !== 'select') {
      const p = this.pick(e)
      if (p) this.place(p)
    } else if (button === 2) {
      this.finishPolyline()
    }
  }

  private pan(e: PointerEvent): void {
    const plane = new Plane(new Vector3(0, 1, 0), -this.panAnchorY)
    const prev = new Vector3()
    const curr = new Vector3()
    const rect = this.canvas.getBoundingClientRect()

    const rayAt = (cx: number, cy: number, out: Vector3): boolean => {
      const ndc = new Vector2(
        ((cx - rect.left) / rect.width) * 2 - 1,
        -((cy - rect.top) / rect.height) * 2 + 1,
      )
      this.raycaster.setFromCamera(ndc, this.camera)
      return this.raycaster.ray.intersectPlane(plane, out) !== null
    }

    if (rayAt(this.lastX, this.lastY, prev) && rayAt(e.clientX, e.clientY, curr)) {
      const delta = prev.sub(curr)
      this.camera.position.add(delta)
      this.pivot.add(delta)
    }
  }

  private orbit(dx: number, dy: number): void {
    const offset = this.camera.position.clone().sub(this.pivot)
    const radius = offset.length()
    let theta = Math.atan2(offset.x, offset.z)
    let phi = Math.acos(Math.max(-1, Math.min(1, offset.y / radius)))
    theta -= dx * 0.005
    phi = Math.max(0.15, Math.min(1.45, phi + dy * 0.005))
    offset.set(
      radius * Math.sin(phi) * Math.sin(theta),
      radius * Math.cos(phi),
      radius * Math.sin(phi) * Math.cos(theta),
    )
    this.camera.position.copy(this.pivot).add(offset)
    this.camera.lookAt(this.pivot)
  }

  private onWheel = (e: WheelEvent): void => {
    if (!this.enabled) return
    e.preventDefault()
    this.raycaster.setFromCamera(this.ndc(e), this.camera)
    const speed = Math.max(this.camera.position.y - this.pivot.y, 60) * 0.0012
    this.camera.position.addScaledVector(this.raycaster.ray.direction, -e.deltaY * speed)
    if (this.camera.position.y < this.pivot.y + 25) this.camera.position.y = this.pivot.y + 25
  }

  // ---------- drafting ----------

  private place(p: Vector3): void {
    this.draft.push(p)

    switch (this.tool) {
      case 'distance':
        this.onStatus(`${this.draft.length} pts — ${fmtDist(pathLength(this.draft))} — right-click to finish`)
        break
      case 'focus':
        this.onStatus(`${this.draft.length} corners — right-click to close`)
        break
      case 'arc':
        if (this.draft.length === 3) this.finalizeArc()
        else this.onStatus(`FIRE ARC — point ${this.draft.length + 1} of 3`)
        break
      case 'los':
        if (this.draft.length === 2) this.finalizeLos()
        else this.onStatus('LOS — now click the target')
        break
      case 'viewshed':
        if (this.draft.length === 2) {
          this.viewshed.aim(this.draft[0], this.draft[1])
          this.onStatus('VIEWSHED locked — green = visible, red = hidden. Clear All to remove.')
          this.draft = []
          this.previewRoot.clear()
        } else {
          this.onStatus('VIEWSHED — sweep the mouse to aim, click to lock')
        }
        break
      default:
        break
    }
    this.updatePreview()
  }

  private finishPolyline(): void {
    if (this.tool === 'distance' && this.draft.length >= 2) this.finalizeDistance()
    else if (this.tool === 'focus' && this.draft.length >= 3) this.finalizeFocus()
    else this.cancelDraft()
  }

  private cancelDraft(): void {
    this.draft = []
    this.hover = null
    this.previewRoot.clear()
    this.onStatus(TOOL_HINTS[this.tool])
  }

  private updatePreview(): void {
    this.previewRoot.clear()
    if (this.draft.length === 0) return

    const pts = this.hover ? [...this.draft, this.hover] : [...this.draft]

    if (this.tool === 'los') {
      // live LOS sweep from the observer to wherever the mouse is
      if (this.draft.length === 1 && this.hover) {
        this.previewRoot.add(this.buildLosGroup(this.draft[0], this.hover, false))
        this.previewRoot.traverse(o => o.layers.set(1))
      }
      return
    }

    if (this.tool === 'viewshed') {
      // live aim — the whole mesh repaints as you sweep
      if (this.draft.length === 1 && this.hover) {
        this.viewshed.aim(this.draft[0], this.hover)
      }
      this.previewRoot.add(marker(this.draft[0], 0xffaa33))
      this.previewRoot.traverse(o => o.layers.set(1))
      return
    }

    if (pts.length >= 2) {
      const line = new Line(new BufferGeometry().setFromPoints(pts), MAT_MEASURE)
      line.renderOrder = 999
      this.previewRoot.add(line)
    }
    for (const p of this.draft) this.previewRoot.add(marker(p, 0x35d4ff))
    this.previewRoot.traverse(o => o.layers.set(1))
  }

  // ---------- finalizers ----------

  private addFeature(tool: StratTool, group: Group): void {
    group.renderOrder = 999
    group.traverse(o => o.layers.set(1)) // overlays stay out of the viewshed depth pass
    this.featureRoot.add(group)
    this.features.push({ id: crypto.randomUUID(), tool, group })
    this.draft = []
    this.hover = null
    this.previewRoot.clear()
  }

  private finalizeDistance(): void {
    const pts = [...this.draft]
    const total = pathLength(pts)
    const g = new Group()
    const line = new Line(new BufferGeometry().setFromPoints(pts), MAT_MEASURE)
    line.renderOrder = 999
    g.add(line)
    for (const p of pts) g.add(marker(p, 0x35d4ff))
    g.add(label(pts[pts.length - 1].clone().add(new Vector3(0, 12, 0)), fmtDist(total)))
    this.addFeature('distance', g)
    this.onStatus(`Distance: ${fmtDist(total)}`)
  }

  private finalizeFocus(): void {
    const pts = [...this.draft]
    const name = window.prompt('Name this focus area:', `AO-${this.features.filter(f => f.tool === 'focus').length + 1}`) ?? 'AO'
    const minY = Math.min(...pts.map(p => p.y))
    const maxY = Math.max(...pts.map(p => p.y))
    const height = maxY - minY + 80

    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length
    const cz = pts.reduce((s, p) => s + p.z, 0) / pts.length

    const shape = new Shape()
    pts.forEach((p, i) => {
      const sx = p.x - cx
      const sy = -(p.z - cz)
      if (i === 0) shape.moveTo(sx, sy)
      else shape.lineTo(sx, sy)
    })
    shape.closePath()

    const geo = new ExtrudeGeometry(shape, { depth: height, bevelEnabled: false })
    geo.rotateX(-Math.PI / 2)
    const mesh = new Mesh(geo, new MeshBasicMaterial({
      color: 0xffb74d, transparent: true, opacity: 0.16, side: DoubleSide, depthWrite: false,
    }))
    mesh.position.set(cx, minY - 5, cz)

    const edges = new LineSegments(
      new EdgesGeometry(geo),
      new LineBasicMaterial({ color: 0xffb74d, transparent: true, opacity: 0.8 }),
    )
    edges.position.copy(mesh.position)

    const areaM2 = shoelaceXZ(pts)
    const g = new Group()
    g.add(mesh, edges)
    g.add(label(new Vector3(cx, maxY + 95, cz), `${name}\n${fmtArea(areaM2)}`))
    this.addFeature('focus', g)
    this.onStatus(`${name}: ${fmtArea(areaM2)}`)
  }

  private finalizeArc(): void {
    const [center, radiusPt, bearingPt] = this.draft
    const r = Math.hypot(radiusPt.x - center.x, radiusPt.z - center.z)
    const a1 = Math.atan2(-(radiusPt.z - center.z), radiusPt.x - center.x)
    let a2 = Math.atan2(-(bearingPt.z - center.z), bearingPt.x - center.x)
    if (a2 <= a1) a2 += Math.PI * 2

    const shape = new Shape()
    shape.moveTo(0, 0)
    shape.absarc(0, 0, r, a1, a2, false)
    shape.closePath()

    const geo = new ShapeGeometry(shape, 48)
    geo.rotateX(-Math.PI / 2)
    const mesh = new Mesh(geo, new MeshBasicMaterial({
      color: 0xef5350, transparent: true, opacity: 0.22, side: DoubleSide, depthWrite: false,
    }))
    mesh.position.set(center.x, center.y + 1.5, center.z)

    const g = new Group()
    g.add(mesh)
    g.add(marker(center, 0xef5350))
    g.add(label(center.clone().add(new Vector3(0, 25, 0)), `r=${fmtDist(r)}`))
    this.addFeature('arc', g)
    this.onStatus(`Fire arc: radius ${fmtDist(r)}`)
  }

  private finalizeLos(): void {
    const [obs, tgt] = this.draft
    const g = this.buildLosGroup(obs, tgt, true)
    this.addFeature('los', g)
  }

  /** Raycast obs→tgt against the photogrammetry mesh; green/red split if a building blocks. */
  private buildLosGroup(obsGround: Vector3, tgtGround: Vector3, report: boolean): Group {
    const obs = obsGround.clone().add(new Vector3(0, EYE_HEIGHT, 0))
    const tgt = tgtGround.clone().add(new Vector3(0, EYE_HEIGHT, 0))
    const dir = tgt.clone().sub(obs)
    const dist = dir.length()
    dir.normalize()

    this.raycaster.set(obs, dir)
    this.raycaster.far = dist - 2
    const hits = this.raycaster.intersectObject(this.tiles, true)
    const blocked = hits.length > 0 ? hits[0] : null

    const g = new Group()
    g.add(marker(obs, 0xffffff))

    if (!blocked) {
      const line = new Line(new BufferGeometry().setFromPoints([obs, tgt]), MAT_LOS_CLEAR)
      line.renderOrder = 999
      g.add(line)
      g.add(marker(tgt, 0x55ff55))
      if (report) {
        g.add(label(tgt.clone().add(new Vector3(0, 14, 0)), `CLEAR ${fmtDist(dist)}`))
        this.onStatus(`LOS CLEAR — ${fmtDist(dist)}`)
      }
    } else {
      const clearLine = new Line(new BufferGeometry().setFromPoints([obs, blocked.point]), MAT_LOS_CLEAR)
      const blockedLine = new Line(new BufferGeometry().setFromPoints([blocked.point, tgt]), MAT_LOS_BLOCKED)
      clearLine.renderOrder = 999
      blockedLine.renderOrder = 999
      g.add(clearLine, blockedLine)
      g.add(marker(blocked.point, 0xff4444, 3))
      g.add(marker(tgt, 0xff4444))
      if (report) {
        g.add(label(blocked.point.clone().add(new Vector3(0, 14, 0)), `BLOCKED @ ${fmtDist(blocked.distance)}`))
        this.onStatus(`LOS BLOCKED at ${fmtDist(blocked.distance)} of ${fmtDist(dist)}`)
      }
    }
    return g
  }
}

// ---------- helpers ----------

function pathLength(pts: Vector3[]): number {
  let total = 0
  for (let i = 1; i < pts.length; i++) total += pts[i].distanceTo(pts[i - 1])
  return total
}

function shoelaceXZ(pts: Vector3[]): number {
  let sum = 0
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % pts.length]
    sum += a.x * b.z - b.x * a.z
  }
  return Math.abs(sum) / 2
}

function fmtDist(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${m.toFixed(0)} m`
}

function fmtArea(m2: number): string {
  if (m2 >= 1_000_000) return `${(m2 / 1_000_000).toFixed(2)} km²`
  if (m2 >= 10_000) return `${(m2 / 10_000).toFixed(1)} ha`
  return `${m2.toFixed(0)} m²`
}

function marker(at: Vector3, color: number, size = 2): Mesh {
  const m = new Mesh(
    new SphereGeometry(size, 12, 12),
    new MeshBasicMaterial({ color, depthTest: false, transparent: true }),
  )
  m.position.copy(at)
  m.renderOrder = 1000
  return m
}

function label(at: Vector3, text: string): Sprite {
  const lines = text.split('\n')
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 64 + lines.length * 56
  const ctx = canvas.getContext('2d')!
  ctx.font = 'bold 44px monospace'
  ctx.textAlign = 'center'
  ctx.lineWidth = 10
  ctx.strokeStyle = 'rgba(0,0,0,0.9)'
  ctx.fillStyle = '#ffffff'
  lines.forEach((line, i) => {
    const y = 56 + i * 56
    ctx.strokeText(line, 256, y)
    ctx.fillText(line, 256, y)
  })

  const sprite = new Sprite(new SpriteMaterial({
    map: new CanvasTexture(canvas),
    depthTest: false,
    transparent: true,
  }))
  sprite.position.copy(at)
  const w = 70
  sprite.scale.set(w, w * (canvas.height / canvas.width), 1)
  sprite.renderOrder = 1001
  return sprite
}
