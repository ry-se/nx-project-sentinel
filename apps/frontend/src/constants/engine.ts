import { Vector3 } from "three"

interface Viewshed {
    NEAR_PLANE: number
    FAR_PLANE: number
    DEPTH_RES: number
    H_FOV_DEG: number
    V_FOV_DEG: number
    EYE_HEIGHT: number
    DEPTH_MIN: number
    WHITE: string
    BALL_DEG: number
}

export const VIEWSHED: Viewshed = {
    NEAR_PLANE: 1,
    FAR_PLANE: 1000,
    DEPTH_RES: 2048,
    H_FOV_DEG: 100, 
    V_FOV_DEG: 55,
    EYE_HEIGHT: 2,
    DEPTH_MIN: 20,
    WHITE: "0xffffff",
    BALL_DEG: 360
} as const

interface Bomb {
    GRAVITY: number         // m/s² 
    BLAST_RADIUS: number    // metres for debris scatter   
    DOWN: Vector3
    CRATER_R: number        // radius of full depression (m)
    DAMAGE_R: number        // outer blast wave radius (m)
    CRATER_D: number        // max downward displacement at crater center (m)
    DAMAGE_RISE: number     // max outward + upward displacement in damage ring (m)
}

export const BOMB: Bomb = {
    GRAVITY: -28,
    BLAST_RADIUS: 120,
    DOWN: new Vector3(0, -1, 0),
    CRATER_R: 28,
    DAMAGE_R: 85,
    CRATER_D: 22,
    DAMAGE_RISE: 15,
}