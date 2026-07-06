import logging
import sys
import time
import uuid

import structlog
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

from app.config import get_settings
from app.routes.detect import router as detect_router
from app.schemas import ErrorResponse

# Content-Length ceiling — belt-and-suspenders alongside DetectRequest.image_b64's
# max_length (Pydantic's cap only applies after the full body is already buffered).
MAX_BODY_BYTES = 25_000_000


def configure_logging() -> None:
    logging.basicConfig(format="%(message)s", stream=sys.stdout, level=logging.INFO)
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.JSONRenderer(),
        ],
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )


configure_logging()
logger = structlog.get_logger(__name__)
settings = get_settings()

limiter = Limiter(key_func=get_remote_address)

app = FastAPI(title="Project Sentinel Backend")
app.state.limiter = limiter

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(HTTPException)
async def typed_http_exception_handler(request: Request, exc: HTTPException) -> JSONResponse:
    """Renders ErrorResponse.model_dump() detail bodies flat, not nested under "detail"."""
    body = exc.detail if isinstance(exc.detail, dict) else {"error": "http_error", "detail": exc.detail}
    return JSONResponse(status_code=exc.status_code, content=body)


@app.exception_handler(RateLimitExceeded)
async def rate_limit_exception_handler(request: Request, exc: RateLimitExceeded) -> JSONResponse:
    request_id = getattr(request.state, "request_id", "unknown")
    return JSONResponse(
        status_code=429,
        content=ErrorResponse(
            error="rate_limited", detail=str(exc.detail), request_id=request_id
        ).model_dump(),
    )


@app.middleware("http")
async def request_context(request: Request, call_next):
    request_id = str(uuid.uuid4())
    request.state.request_id = request_id
    start = time.perf_counter()

    with structlog.contextvars.bound_contextvars(request_id=request_id):
        logger.info("request.start", method=request.method, path=request.url.path)

        content_length = request.headers.get("content-length")
        if content_length is not None and int(content_length) > MAX_BODY_BYTES:
            logger.warning("request.body_too_large", content_length=content_length)
            return JSONResponse(
                status_code=413,
                content=ErrorResponse(
                    error="payload_too_large",
                    detail=f"request body exceeds {MAX_BODY_BYTES} bytes",
                    request_id=request_id,
                ).model_dump(),
            )

        try:
            response = await call_next(request)
        except Exception as exc:  # noqa: BLE001 — logged then re-raised as typed 500
            logger.exception("request.error", error=str(exc))
            return JSONResponse(
                status_code=500,
                content=ErrorResponse(
                    error="internal_error",
                    detail="unexpected server error",
                    request_id=request_id,
                ).model_dump(),
            )
        latency_ms = (time.perf_counter() - start) * 1000
        logger.info(
            "request.ok",
            status_code=response.status_code,
            latency_ms=latency_ms,
        )
        response.headers["x-request-id"] = request_id
        return response


@app.get("/")
async def root():
    return {"message": "FastAPI is running!"}


app.include_router(detect_router)
