import base64

from fastapi.testclient import TestClient

from app.main import app
from app.schemas import DetectResponse

client = TestClient(app)

SAMPLE_IMAGE_B64 = base64.b64encode(b"not-a-real-image-just-bytes").decode()


def test_detect_returns_valid_response_contract():
    resp = client.post("/api/v1/detect", json={"image_b64": SAMPLE_IMAGE_B64})

    assert resp.status_code == 200
    body = DetectResponse.model_validate(resp.json())
    assert len(body.annotations) >= 1
    assert body.latency_ms >= 0


def test_detect_annotation_shape_matches_frontend_contract():
    resp = client.post("/api/v1/detect", json={"image_b64": SAMPLE_IMAGE_B64})
    box = resp.json()["annotations"][0]

    # Byte-match: apps/frontend .../detections.ts::DetectionClass
    assert box["cls"] in {
        "armored_fighting_vehicle",
        "light_military_vehicle",
        "aircraft",
    }
    assert set(box["rear"]) or box["rear"] == [0, 0]
    assert len(box["rear"]) == 2
    assert len(box["front"]) == 2
    assert "half_width_px" in box
    assert 0.0 <= box["confidence"] <= 1.0
    assert box["heading_confidence"] in {"high", "medium", "low"}


def test_detect_rejects_invalid_base64():
    resp = client.post("/api/v1/detect", json={"image_b64": "not-valid-base64!!"})

    assert resp.status_code == 400
    body = resp.json()
    assert body["error"] == "invalid_image"
    assert "request_id" in body


def test_detect_response_carries_request_id_header():
    resp = client.post("/api/v1/detect", json={"image_b64": SAMPLE_IMAGE_B64})
    assert "x-request-id" in resp.headers


def test_cors_is_explicit_origin_not_wildcard():
    from app.config import get_settings

    settings = get_settings()
    assert "*" not in settings.cors_origins
