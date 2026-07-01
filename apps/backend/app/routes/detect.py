import base64
import time

import structlog
from fastapi import APIRouter, HTTPException, Request
from slowapi import Limiter
from slowapi.util import get_remote_address

from app.config import get_settings
from app.schemas import DetectionBox, DetectRequest, DetectResponse, ErrorResponse

logger = structlog.get_logger(__name__)

router = APIRouter(prefix="/api/v1", tags=["detect"])

# Matches app.main's limiter key strategy — slowapi resolves the shared
# app.state.limiter at call time, this instance only carries the key_func.
limiter = Limiter(key_func=get_remote_address)


def _stub_detection() -> DetectionBox:
    """One fixed oriented box so the contract is exercisable before W2's real adapter."""
    return DetectionBox(
        id="stub-0",
        cls="armored_fighting_vehicle",
        rear=(100.0, 220.0),
        front=(140.0, 180.0),
        half_width_px=18.0,
        confidence=0.5,
        heading_confidence="low",
    )


@router.post("/detect", response_model=DetectResponse, responses={400: {"model": ErrorResponse}})
@limiter.limit("20/minute")
async def detect(payload: DetectRequest, request: Request) -> DetectResponse:
    request_id = request.state.request_id
    settings = get_settings()
    log = logger.bind(request_id=request_id, endpoint="detect")

    log.info("detect.start", provider=settings.detector_provider, model=settings.detector_model)
    start = time.perf_counter()

    try:
        base64.b64decode(payload.image_b64, validate=True)
    except (ValueError, base64.binascii.Error) as exc:
        log.warning("detect.bad_request", error=str(exc))
        raise HTTPException(
            status_code=400,
            detail=ErrorResponse(
                error="invalid_image", detail="image_b64 is not valid base64", request_id=request_id
            ).model_dump(),
        ) from exc

    # Stub detector — W2 replaces this with the real (VLM) adapter.
    annotations = [_stub_detection()]
    latency_ms = (time.perf_counter() - start) * 1000

    log.info("detect.ok", annotation_count=len(annotations), latency_ms=latency_ms)

    return DetectResponse(
        annotations=annotations,
        model=settings.detector_model or "stub-detector",
        latency_ms=latency_ms,
    )
