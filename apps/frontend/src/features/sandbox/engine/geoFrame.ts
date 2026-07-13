import { MathUtils, Matrix4, Vector3 } from 'three';
import type { TilesRenderer } from '3d-tiles-renderer';

import { SANDBOX_COMMON } from '@/constants/sandbox';

export interface GeoPosition {
  lat: number;
  lon: number;
  altM: number;
}

/**
 * Converts between the tile set's local frame (metres, recentred at the
 * anchor) and WGS84, and provides true compass bearings — all derived from
 * the renderer's own ellipsoid math, so no hand-tuned axis conventions.
 */
export class GeoFrame {
  private inverse = new Matrix4();
  private east = new Vector3();
  private north = new Vector3();
  private ready = false;

  constructor(
    private tiles: TilesRenderer,
    private anchor: { lat: number; lon: number }
  ) {}

  private ensure(): void {
    if (this.ready) return;
    this.tiles.group.updateMatrixWorld(true);
    this.inverse.copy(this.tiles.group.matrixWorld).invert();

    const e = new Vector3();
    const n = new Vector3();
    const u = new Vector3();
    this.tiles.ellipsoid.getEastNorthUpAxes(
      MathUtils.DEG2RAD * this.anchor.lat,
      MathUtils.DEG2RAD * this.anchor.lon,
      e,
      n,
      u
    );
    this.east.copy(e).transformDirection(this.tiles.group.matrixWorld);
    this.north.copy(n).transformDirection(this.tiles.group.matrixWorld);
    this.ready = true;
  }

  /** Local-frame position → WGS84 lat/lon/alt (degrees, metres). */
  public localToGeo(local: Vector3): GeoPosition {
    this.ensure();
    const ecef = local.clone().applyMatrix4(this.inverse);
    const target = { lat: 0, lon: 0, height: 0 };
    this.tiles.ellipsoid.getPositionToCartographic(ecef, target);
    return {
      lat: MathUtils.RAD2DEG * target.lat,
      lon: MathUtils.RAD2DEG * target.lon,
      altM: target.height,
    };
  }

  /** WGS84 lat/lon/alt (degrees, metres) → the recentered local scene frame. */
  public geoToLocal(geo: GeoPosition): Vector3 {
    this.ensure();
    const local = new Vector3();
    this.tiles.ellipsoid.getCartographicToPosition(
      MathUtils.DEG2RAD * geo.lat,
      MathUtils.DEG2RAD * geo.lon,
      geo.altM,
      local
    );
    return local.applyMatrix4(this.tiles.group.matrixWorld);
  }

  /** True compass bearing (0–360°, 0 = north) of a local-frame direction. */
  public compassHeadingDeg(directionLocal: Vector3): number {
    this.ensure();
    const e = directionLocal.dot(this.east);
    const n = directionLocal.dot(this.north);
    return (
      ((Math.atan2(e, n) * SANDBOX_COMMON.DEGREES_HALF_TURN) / Math.PI +
        SANDBOX_COMMON.DEGREES_FULL_CIRCLE) %
      SANDBOX_COMMON.DEGREES_FULL_CIRCLE
    );
  }
}
