from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

# Byte-match contract: apps/frontend/src/features/sandbox/engine/detections.ts::DetectionClass
DetectionClass = Literal[
    "armored_fighting_vehicle",
    "light_military_vehicle",
    "aircraft",
]

HeadingConfidence = Literal["high", "medium", "low"]

Point2D = tuple[float, float]


class ImagePose(BaseModel):
    """Camera pose captured alongside the image (see CameraPose in createSandbox.ts)."""

    lat: float
    lon: float
    alt_m: float
    heading_deg: float
    pitch_deg: float


class ImageMeta(BaseModel):
    width: int
    height: int
    name: str = ""


# ~15MB decoded image, base64-inflated (~4/3x) — caps in-memory decode allocation.
MAX_IMAGE_B64_CHARS = 20_000_000


class DetectRequest(BaseModel):
    image_b64: str = Field(
        ...,
        max_length=MAX_IMAGE_B64_CHARS,
        description="Base64-encoded image, no data-URL prefix",
    )
    pose: ImagePose | None = None
    image_meta: ImageMeta | None = None


class DetectionBox(BaseModel):
    """Geometry (rear/front/half-width/cls) mirrors apps/frontend ImageAnnotation on the
    wire — camelCase `halfWidthPx`, matching what createSandbox.ts::deployFromImage reads
    (`ann.halfWidthPx * 2`) so W3 can feed this straight into ImageAnnotation with no
    key-casing translation. `heading_confidence` stays snake_case, matching the separate
    locked SentinelDetection contract in detections.ts ("the AI service must emit this too").
    """

    model_config = ConfigDict(populate_by_name=True)

    id: str
    cls: DetectionClass
    rear: Point2D
    front: Point2D
    half_width_px: float = Field(alias="halfWidthPx")
    confidence: float = Field(ge=0.0, le=1.0)
    heading_confidence: HeadingConfidence


class DetectResponse(BaseModel):
    annotations: list[DetectionBox]
    model: str
    latency_ms: float


class ErrorResponse(BaseModel):
    """Typed error body — no bare/opaque 500s (.claude/rules/zero-tolerance.md Rule 3)."""

    error: str
    detail: str
    request_id: str
