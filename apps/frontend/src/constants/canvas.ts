interface Canvas {
    DASH: number
    GAP: number
    ASPECT_MIN: number
    AXIS_MULT: number
    POS_MULT: number
    X_OFFSET: number
    Y_OFFSET: number
}

export const CANVAS: Canvas = {
    DASH: 6,
    GAP: 4,
    ASPECT_MIN: 0.05,
    AXIS_MULT: 12,
    POS_MULT: 7,
    X_OFFSET: 4,
    Y_OFFSET: 6
} as const