import {
  CanvasTexture, Group, MathUtils, PerspectiveCamera, Raycaster, Scene,
  Sprite, SpriteMaterial, Vector3,
} from 'three'
import type { TilesRenderer } from '3d-tiles-renderer'

const CACHE_KEY = 'osm_labels_cache_v1'
const MAX_LABELS = 90
const VISIBLE_RANGE = 2600   // hide labels beyond this camera distance (m)
const LABEL_LIFT = 22        // metres above the mesh surface

interface POI {
  name: string
  lat: number
  lon: number
  kind: string
  priority: number
}

const KIND_ICON: Record<string, string> = {
  place: '📍',
  tourism: '⭐',
  historic: '🏛',
  leisure: '🌳',
  amenity: '🏢',
  bridge: '🌉',
}

/**
 * Floating place-name labels sourced live from OpenStreetMap, positioned in
 * the tile set's local frame via exact ECEF transform and clamped to the
 * photogrammetry surface by raycast.
 */
export class LabelManager {
  visible = true

  private root = new Group()
  private tiles: TilesRenderer
  private raycaster = new Raycaster()
  private unclamped: Sprite[] = []
  private lastClampAt = 0
  private loaded = false

  constructor(scene: Scene, tiles: TilesRenderer) {
    this.tiles = tiles
    this.root.traverse(o => o.layers.set(1))
    scene.add(this.root)
    ;(this.raycaster as unknown as { firstHitOnly: boolean }).firstHitOnly = true
  }

  /** Fetch POIs and build sprites. Call once the root tileset has loaded
   *  (the reorientation transform must be in place). */
  async load(centerLat: number, centerLon: number): Promise<void> {
    if (this.loaded) return
    this.loaded = true

    let pois: POI[]
    try {
      pois = await fetchPOIs(centerLat, centerLon)
    } catch (e) {
      console.warn('[labels] OSM fetch failed:', e)
      return
    }

    this.tiles.group.updateMatrixWorld(true)
    for (const poi of pois) {
      const pos = new Vector3()
      this.tiles.ellipsoid.getCartographicToPosition(
        MathUtils.DEG2RAD * poi.lat,
        MathUtils.DEG2RAD * poi.lon,
        0,
        pos,
      )
      pos.applyMatrix4(this.tiles.group.matrixWorld)

      const sprite = makeLabelSprite(`${KIND_ICON[poi.kind] ?? '•'} ${poi.name}`)
      sprite.position.copy(pos)
      sprite.position.y += LABEL_LIFT
      sprite.layers.set(1)
      sprite.userData.needsClamp = true
      this.root.add(sprite)
      this.unclamped.push(sprite)
    }
    console.log(`[labels] placed ${pois.length} OSM labels`)
  }

  /** Per-frame: distance culling + lazy height clamping as tiles stream in. */
  update(camera: PerspectiveCamera): void {
    if (!this.visible) return

    const now = performance.now()
    if (this.unclamped.length > 0 && now - this.lastClampAt > 800) {
      this.lastClampAt = now
      // clamp a few per cycle — raycasts against the tileset aren't free
      const batch = this.unclamped.splice(0, 12)
      for (const sprite of batch) {
        const origin = sprite.position.clone()
        origin.y += 600
        this.raycaster.set(origin, new Vector3(0, -1, 0))
        this.raycaster.far = 1500
        const hits = this.raycaster.intersectObject(this.tiles.group, true)
        if (hits.length > 0) {
          sprite.position.y = hits[0].point.y + LABEL_LIFT
        } else {
          this.unclamped.push(sprite) // tile not streamed yet — retry later
        }
      }
    }

    for (const child of this.root.children) {
      child.visible = child.position.distanceTo(camera.position) < VISIBLE_RANGE
    }
  }

  setVisible(v: boolean): void {
    this.visible = v
    this.root.visible = v
  }
}

// ---------- OSM fetch ----------

async function fetchPOIs(lat: number, lon: number): Promise<POI[]> {
  const cached = localStorage.getItem(CACHE_KEY)
  if (cached) {
    try { return JSON.parse(cached) as POI[] } catch { localStorage.removeItem(CACHE_KEY) }
  }

  const d = 0.014 // ≈ 1.5 km half-extent
  const bbox = `${lat - d},${lon - d},${lat + d},${lon + d}`
  const query = `
    [out:json][timeout:30];
    (
      node["name"]["place"~"suburb|neighbourhood|quarter"](${bbox});
      node["name"]["tourism"](${bbox});
      node["name"]["historic"](${bbox});
      nwr["name"]["leisure"~"park|stadium|garden|marina"](${bbox});
      nwr["name"]["amenity"~"theatre|arts_centre|place_of_worship|university|ferry_terminal|courthouse"](${bbox});
      nwr["name"]["tourism"~"attraction|museum|hotel|viewpoint"](${bbox});
      nwr["name"]["man_made"="bridge"](${bbox});
    );
    out center ${MAX_LABELS * 2};
  `

  const resp = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    body: `data=${encodeURIComponent(query)}`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  })
  if (!resp.ok) throw new Error(`Overpass ${resp.status}`)
  const json = await resp.json() as {
    elements: Array<{
      lat?: number; lon?: number
      center?: { lat: number; lon: number }
      tags?: Record<string, string>
    }>
  }

  const seen = new Set<string>()
  const pois: POI[] = []
  for (const el of json.elements) {
    const name = el.tags?.name
    const plat = el.lat ?? el.center?.lat
    const plon = el.lon ?? el.center?.lon
    if (!name || plat === undefined || plon === undefined || seen.has(name)) continue
    seen.add(name)

    const tags = el.tags!
    let kind = 'amenity'
    let priority = 4
    if (tags.place) { kind = 'place'; priority = 0 }
    else if (tags.tourism) { kind = 'tourism'; priority = 1 }
    else if (tags.historic) { kind = 'historic'; priority = 2 }
    else if (tags.man_made === 'bridge') { kind = 'bridge'; priority = 3 }
    else if (tags.leisure) { kind = 'leisure'; priority = 3 }

    pois.push({ name, lat: plat, lon: plon, kind, priority })
  }

  pois.sort((a, b) => a.priority - b.priority)
  const top = pois.slice(0, MAX_LABELS)
  localStorage.setItem(CACHE_KEY, JSON.stringify(top))
  return top
}

// ---------- sprite ----------

function makeLabelSprite(text: string): Sprite {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!
  ctx.font = '600 34px system-ui, sans-serif'
  const w = Math.min(Math.ceil(ctx.measureText(text).width) + 28, 640)
  canvas.width = w
  canvas.height = 56

  const c = canvas.getContext('2d')!
  c.font = '600 34px system-ui, sans-serif'
  c.textBaseline = 'middle'
  c.lineWidth = 7
  c.lineJoin = 'round'
  c.strokeStyle = 'rgba(10,14,18,0.95)'
  c.fillStyle = '#ffffff'
  c.strokeText(text, 14, 30)
  c.fillText(text, 14, 30)

  const sprite = new Sprite(new SpriteMaterial({
    map: new CanvasTexture(canvas),
    sizeAttenuation: false,   // constant screen size, like real map labels
    depthTest: false,
    transparent: true,
  }))
  // scale.y is roughly fraction of viewport height
  const h = 0.028
  sprite.scale.set(h * (canvas.width / canvas.height), h, 1)
  sprite.renderOrder = 950
  return sprite
}
