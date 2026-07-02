import base64
import time

import structlog
from fastapi import APIRouter, Depends, HTTPException, Request
from slowapi import Limiter
from slowapi.util import get_remote_address

from app.config import Settings, get_settings
from app.detector.base import DetectorError, get_detector
from app.schemas import DetectRequest, DetectResponse, ErrorResponse

logger = structlog.get_logger(__name__)

router = APIRouter(prefix="/api/v1", tags=["detect"])

# Matches app.main's limiter key strategy — slowapi resolves the shared
# app.state.limiter at call time, this instance only carries the key_func.
limiter = Limiter(key_func=get_remote_address)


@router.post(
    "/detect",
    response_model=DetectResponse,
    responses={400: {"model": ErrorResponse}, 502: {"model": ErrorResponse}},
)
@limiter.limit("20/minute")
async def detect(
    payload: DetectRequest, request: Request, settings: Settings = Depends(get_settings)
) -> DetectResponse:
    request_id = request.state.request_id
    log = logger.bind(request_id=request_id, endpoint="detect")

    log.info(
        "detect.start",
        provider=settings.detector_provider,
        model=settings.resolved_detector_model,
    )
    start = time.perf_counter()

    try:
        image_bytes = base64.b64decode(payload.image_b64, validate=True)
    except (ValueError, base64.binascii.Error) as exc:
        log.warning("detect.bad_request", error=str(exc))
        raise HTTPException(
            status_code=400,
            detail=ErrorResponse(
                error="invalid_image", detail="image_b64 is not valid base64", request_id=request_id
            ).model_dump(),
        ) from exc

    detector = get_detector(settings)
    try:
        annotations = await detector.detect(image_bytes, payload.pose)
    except DetectorError as exc:
        log.warning("detect.provider_error", error=str(exc))
        raise HTTPException(
            status_code=502,
            detail=ErrorResponse(
                error="detector_unavailable", detail=str(exc), request_id=request_id
            ).model_dump(),
        ) from exc

    latency_ms = (time.perf_counter() - start) * 1000
    log.info("detect.ok", annotation_count=len(annotations), latency_ms=latency_ms)

    return DetectResponse(
        annotations=annotations,
        model=settings.resolved_detector_model or settings.detector_provider,
        latency_ms=latency_ms,
    )
