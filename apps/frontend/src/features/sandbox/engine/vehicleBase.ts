import { Group, Object3D, Raycaster, Vector3 } from 'three'

import { SANDBOX_MISC } from '@/constants'

export type VehicleType = 'tank' | 'car' | 'jet' | 'spider'

export const DOWN = new Vector3(0, -1, 0)

export interface VehicleState {
  label: string
  speed: number
  heading: number
  altitude: number | null
  afterburner?: boolean
  rolling?: boolean
  /** Spider-Man: 'GROUND' | 'FALLING' | 'SWINGING' | 'ZIP' */
  mode?: string
  /** 0..1 hint for the camera to widen FOV + tighten follow at speed. */
  fovBoost?: number
  /**
   * Spider-Man wall-run only: the horizontal outward wall normal [x,y,z]
   * (y≈0). Present *only* while clung to a wall — the camera frames the face
   * from this. Absent in every other state.
   */
  wallNormal?: [number, number, number]
}

export interface BombDrop {
  pos: Vector3
  vel: Vector3
}

export abstract class Vehicle {
  public readonly object = new Group()
  /** Filled by update(); VehicleManager drains each frame. */
  public readonly bombDrops: BombDrop[] = []
  protected keys: Set<string>
  protected raycaster = new Raycaster()
  protected _speed = 0
  protected _heading = 0
  public abstract readonly label: string
  public abstract readonly cameraDist: number
  public readonly fireCooldown: number = 0 // 0 = unarmed

  constructor(keys: Set<string>) {
    this.keys = keys
    ;(this.raycaster as unknown as { firstHitOnly: boolean }).firstHitOnly = true
  }

  public abstract update(dt: number, terrain: Object3D): void

  /** Muzzle origin + direction, or null if unarmed. */
  public fireRay(): { origin: Vector3; direction: Vector3; speed: number } | null {
    return null
  }

  /**
   * vehicleFloorY: when provided, hits above this threshold (e.g. bridge decks)
   * are skipped so overhead structures don't block ground vehicles.
   */
  protected sampleGround(
    x: number, z: number, terrain: Object3D, fromHeight: number,
    vehicleFloorY?: number
  ): number | null {
    this.raycaster.set(new Vector3(x, fromHeight, z), DOWN)
    this.raycaster.far = 1200
    // Disable firstHitOnly so we can filter out elevated structures
    ;(this.raycaster as unknown as { firstHitOnly: boolean }).firstHitOnly = false
    const hits = this.raycaster.intersectObject(terrain, true)
    ;(this.raycaster as unknown as { firstHitOnly: boolean }).firstHitOnly = true
    if (hits.length === 0) return null
    if (vehicleFloorY === undefined) return hits[0].point.y
    // Skip hits that are clearly above the vehicle floor (bridges, overpasses)
    const ceiling = vehicleFloorY + SANDBOX_MISC.VEHICLE_BASE_CEILING_TOLERANCE_M // tolerance lets gentle slopes through
    const hit = hits.find(h => h.point.y <= ceiling)
    return hit ? hit.point.y : null
  }

  public get position(): Vector3 {
    return this.object.position
  }

  public get state(): VehicleState {
    return { label: this.label, speed: this._speed, heading: this._heading, altitude: null }
  }

  protected forwardXZ(): Vector3 {
    return new Vector3(Math.sin(this._heading), 0, Math.cos(this._heading))
  }
}
