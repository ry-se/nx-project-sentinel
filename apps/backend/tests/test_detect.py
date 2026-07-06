import base64

from fastapi.testclient import TestClient

from app.config import Settings, get_settings
from app.main import app
from app.schemas import DetectResponse

SAMPLE_IMAGE_B64 = base64.b64encode(b"not-a-real-image-just-bytes").decode()


def test_detect_returns_valid_response_contract(stub_client):
    resp = stub_client.post("/api/v1/detect", json={"image_b64": SAMPLE_IMAGE_B64})

    assert resp.status_code == 200
    body = DetectResponse.model_validate(resp.json())
    assert len(body.annotations) >= 1
    assert body.latency_ms >= 0


def test_detect_annotation_wire_shape_matches_frontend_contract(stub_client):
    resp = stub_client.post("/api/v1/detect", json={"image_b64": SAMPLE_IMAGE_B64})
    box = resp.json()["annotations"][0]

    # Byte-match: apps/frontend .../detections.ts::DetectionClass
    assert box["cls"] in {
        "armored_fighting_vehicle",
        "light_military_vehicle",
        "aircraft",
    }
    assert len(box["rear"]) == 2
    assert len(box["front"]) == 2
    # Wire key is camelCase (aliased in DetectionBox) to match ImageAnnotation.halfWidthPx
    # in createSandbox.ts, which reads it directly (`ann.halfWidthPx * 2`) — not snake_case.
    assert "halfWidthPx" in box
    assert "half_width_px" not in box
    assert 0.0 <= box["confidence"] <= 1.0
    # heading_confidence stays snake_case — matches the separate locked SentinelDetection
    # contract in detections.ts, not ImageAnnotation.
    assert box["heading_confidence"] in {"high", "medium", "low"}


def test_detect_rejects_missing_image_b64(stub_client):
    resp = stub_client.post("/api/v1/detect", json={})
    assert resp.status_code == 422


def test_detect_rejects_oversized_image_b64(stub_client):
    from app.schemas import MAX_IMAGE_B64_CHARS

    oversized = "a" * (MAX_IMAGE_B64_CHARS + 1)
    resp = stub_client.post("/api/v1/detect", json={"image_b64": oversized})
    assert resp.status_code == 422


def test_detect_rejects_invalid_base64(stub_client):
    resp = stub_client.post("/api/v1/detect", json={"image_b64": "not-valid-base64!!"})

    assert resp.status_code == 400
    body = resp.json()
    assert body["error"] == "invalid_image"
    assert "request_id" in body


def test_detect_response_carries_request_id_header(stub_client):
    resp = stub_client.post("/api/v1/detect", json={"image_b64": SAMPLE_IMAGE_B64})
    assert "x-request-id" in resp.headers


def test_detect_provider_unreachable_returns_typed_502():
    """End-to-end wiring proof (no mocking): points the real VisionLanguageModelAdapter at
    an unreachable port so the actual network-failure -> DetectorError -> HTTPException(502)
    path runs for real, not a fixture."""
    app.dependency_overrides[get_settings] = lambda: Settings(
        detector_provider="vlm-api",
        detector_base_url="http://127.0.0.1:1",  # port 1 — nothing listens there
        detector_model="qwen2.5-vl",
    )
    try:
        with TestClient(app) as client:
            resp = client.post("/api/v1/detect", json={"image_b64": SAMPLE_IMAGE_B64})
    finally:
        app.dependency_overrides.pop(get_settings, None)

    assert resp.status_code == 502
    assert resp.json()["error"] == "detector_unavailable"


def test_cors_is_explicit_origin_not_wildcard():
    from app.config import get_settings

    settings = get_settings()
    assert "*" not in settings.cors_origins


def test_cors_wildcard_origin_fails_closed():
    import pytest

    from app.config import Settings

    with pytest.raises(ValueError, match="allow_credentials=True"):
        _ = Settings(cors_allowed_origins="*").cors_origins
