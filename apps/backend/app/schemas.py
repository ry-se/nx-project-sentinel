from typing import Literal

from pydantic import BaseModel, Field

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


class DetectRequest(BaseModel):
    image_b64: str = Field(..., description="Base64-encoded image, no data-URL prefix")
    pose: ImagePose | None = None
    image_meta: ImageMeta | None = None


class DetectionBox(BaseModel):
    """Mirrors apps/frontend ImageAnnotation, plus model-reported confidence."""

    id: str
    cls: DetectionClass
    rear: Point2D
    front: Point2D
    half_width_px: float
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
