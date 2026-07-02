import pytest

from app.config import Settings
from app.detector.base import DetectorError, get_detector
from app.detector.stub_adapter import StubDetector
from app.detector.vision_adapter import VisionLanguageModelAdapter

VALID_FIXTURE_RESPONSE = """[
  {"cls": "tank", "rear": [10, 20], "front": [10, 40], "box": [0, 0, 30, 30], "confidence": 0.9},
  {"cls": "submarine", "rear": [1, 1], "front": [2, 2], "box": [0, 0, 4, 4], "confidence": 0.5}
]"""

FENCED_FIXTURE_RESPONSE = "```json\n" + VALID_FIXTURE_RESPONSE + "\n```"


def _adapter() -> VisionLanguageModelAdapter:
    return VisionLanguageModelAdapter(
        base_url="http://localhost:11434/v1", model="qwen2.5vl:3b", api_key=None
    )


def _fixture(text: str):
    """Wraps a fixture string as the async _call_provider seam expects."""

    async def _fake(image_bytes: bytes, pose=None) -> str:
        return text

    return _fake


async def test_valid_response_maps_and_drops_unmappable(monkeypatch):
    adapter = _adapter()
    monkeypatch.setattr(adapter, "_call_provider", _fixture(VALID_FIXTURE_RESPONSE))

    boxes = await adapter.detect(b"fake-image-bytes")

    assert len(boxes) == 1  # the "submarine" entry is unmappable, dropped
    assert boxes[0].cls == "armored_fighting_vehicle"
    assert boxes[0].confidence == 0.9
    assert boxes[0].half_width_px == 15.0  # box width 30 / 2


async def test_markdown_fenced_response_is_stripped(monkeypatch):
    adapter = _adapter()
    monkeypatch.setattr(adapter, "_call_provider", _fixture(FENCED_FIXTURE_RESPONSE))

    boxes = await adapter.detect(b"fake-image-bytes")
    assert len(boxes) == 1


async def test_malformed_json_raises_detector_error(monkeypatch):
    adapter = _adapter()
    monkeypatch.setattr(adapter, "_call_provider", _fixture("not json at all {"))

    with pytest.raises(DetectorError):
        await adapter.detect(b"fake-image-bytes")


async def test_non_list_json_raises_detector_error(monkeypatch):
    adapter = _adapter()
    monkeypatch.setattr(adapter, "_call_provider", _fixture('{"not": "a list"}'))

    with pytest.raises(DetectorError):
        await adapter.detect(b"fake-image-bytes")


async def test_provider_connection_error_raises_detector_error():
    # Real (unmocked) network failure — port 1 has nothing listening — exercises
    # _call_provider's own try/except, not a stand-in for it.
    adapter = VisionLanguageModelAdapter(
        base_url="http://127.0.0.1:1", model="qwen2.5vl:3b", api_key=None
    )

    with pytest.raises(DetectorError):
        await adapter.detect(b"fake-image-bytes")


async def test_out_of_range_confidence_dropped(monkeypatch):
    adapter = _adapter()
    bad_confidence = (
        '[{"cls": "tank", "rear": [0,0], "front": [0,5], "box": [0,0,10,10], "confidence": 1.5}]'
    )
    monkeypatch.setattr(adapter, "_call_provider", _fixture(bad_confidence))

    boxes = await adapter.detect(b"fake-image-bytes")
    assert boxes == []


async def test_malformed_single_entry_does_not_fail_whole_response(monkeypatch):
    adapter = _adapter()
    mixed = (
        '[{"cls": "tank", "rear": [0,0], "front": [0,5], "box": [0,0,10,10], "confidence": 0.8},'
        '{"cls": "tank", "rear": "not-a-point", "front": [0,5], "box": [0,0,10,10], "confidence": 0.8}]'
    )
    monkeypatch.setattr(adapter, "_call_provider", _fixture(mixed))

    boxes = await adapter.detect(b"fake-image-bytes")
    assert len(boxes) == 1


async def test_heading_confidence_reflects_point_separation(monkeypatch):
    adapter = _adapter()

    near_identical = (
        '[{"cls": "tank", "rear": [0,0], "front": [0,1], "box": [0,0,10,10], "confidence": 0.8}]'
    )
    monkeypatch.setattr(adapter, "_call_provider", _fixture(near_identical))
    boxes = await adapter.detect(b"fake-image-bytes")
    assert boxes[0].heading_confidence == "low"

    well_separated = (
        '[{"cls": "tank", "rear": [0,0], "front": [0,50], "box": [0,0,10,10], "confidence": 0.8}]'
    )
    monkeypatch.setattr(adapter, "_call_provider", _fixture(well_separated))
    boxes = await adapter.detect(b"fake-image-bytes")
    assert boxes[0].heading_confidence == "high"


async def test_heading_confidence_medium_band(monkeypatch):
    adapter = _adapter()
    mid_separation = (
        '[{"cls": "tank", "rear": [0,0], "front": [0,5], "box": [0,0,10,10], "confidence": 0.8}]'
    )
    monkeypatch.setattr(adapter, "_call_provider", _fixture(mid_separation))
    boxes = await adapter.detect(b"fake-image-bytes")
    assert boxes[0].heading_confidence == "medium"


async def test_empty_detection_list_is_valid():
    adapter = _adapter()
    adapter._call_provider = _fixture("[]")
    boxes = await adapter.detect(b"fake-image-bytes")
    assert boxes == []


async def test_uppercase_json_fence_label_is_stripped():
    adapter = _adapter()
    adapter._call_provider = _fixture("```JSON\n" + VALID_FIXTURE_RESPONSE + "\n```")
    boxes = await adapter.detect(b"fake-image-bytes")
    assert len(boxes) == 1


async def test_unexpected_response_shape_raises_detector_error(monkeypatch):
    import httpx2 as httpx

    adapter = _adapter()

    class _FakeResponse:
        def raise_for_status(self):
            pass

        def json(self):
            return {"choices": []}  # missing [0].message.content

    class _FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, *a, **kw):
            return _FakeResponse()

    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: _FakeClient())

    with pytest.raises(DetectorError):
        await adapter.detect(b"fake-image-bytes")


async def test_response_too_large_raises_detector_error(monkeypatch):
    from app.detector.vision_adapter import MAX_PROVIDER_RESPONSE_CHARS

    adapter = _adapter()
    oversized = "[" + "1" * MAX_PROVIDER_RESPONSE_CHARS
    monkeypatch.setattr(adapter, "_call_provider", _fixture(oversized))

    with pytest.raises(DetectorError):
        await adapter.detect(b"fake-image-bytes")


async def test_too_many_detections_raises_detector_error(monkeypatch):
    import json as jsonlib

    from app.detector.vision_adapter import MAX_DETECTIONS_PER_RESPONSE

    adapter = _adapter()
    entry = {"cls": "tank", "rear": [0, 0], "front": [0, 5], "box": [0, 0, 10, 10], "confidence": 0.8}
    huge = jsonlib.dumps([entry] * (MAX_DETECTIONS_PER_RESPONSE + 1))
    monkeypatch.setattr(adapter, "_call_provider", _fixture(huge))

    with pytest.raises(DetectorError):
        await adapter.detect(b"fake-image-bytes")


async def test_non_finite_coordinates_dropped(monkeypatch):
    adapter = _adapter()
    non_finite = (
        '[{"cls": "tank", "rear": [NaN, 0], "front": [0, 5], "box": [0,0,10,10], "confidence": 0.8}]'
    )
    monkeypatch.setattr(adapter, "_call_provider", _fixture(non_finite))

    boxes = await adapter.detect(b"fake-image-bytes")
    assert boxes == []


async def test_provider_error_detail_does_not_leak_base_url():
    """The connection-refused message returned to the API client must not embed the
    internal base_url (host/port) — only the WARN log may carry it."""
    adapter = VisionLanguageModelAdapter(
        base_url="http://127.0.0.1:1", model="qwen2.5vl:3b", api_key=None
    )
    with pytest.raises(DetectorError) as exc_info:
        await adapter.detect(b"fake-image-bytes")
    assert "127.0.0.1" not in str(exc_info.value)


async def test_pose_is_included_in_prompt_context():
    from app.schemas import ImagePose

    adapter = _adapter()
    captured_payloads = []

    class _FakeResponse:
        def raise_for_status(self):
            pass

        def json(self):
            return {"choices": [{"message": {"content": "[]"}}]}

    class _FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, json, headers):
            captured_payloads.append(json)
            return _FakeResponse()

    import httpx2 as httpx

    original_async_client = httpx.AsyncClient
    httpx.AsyncClient = lambda *a, **kw: _FakeClient()
    try:
        pose = ImagePose(lat=1.0, lon=2.0, alt_m=500.0, heading_deg=90.0, pitch_deg=-10.0)
        await adapter.detect(b"fake-image-bytes", pose)
    finally:
        httpx.AsyncClient = original_async_client

    prompt_text = captured_payloads[0]["messages"][0]["content"][0]["text"]
    assert "heading 90.0" in prompt_text
    assert "altitude 500m" in prompt_text


def test_constructor_requires_base_url_and_model():
    with pytest.raises(DetectorError):
        VisionLanguageModelAdapter(base_url="", model="qwen2.5vl:3b", api_key=None)
    with pytest.raises(DetectorError):
        VisionLanguageModelAdapter(base_url="http://localhost:11434/v1", model="", api_key=None)


def test_get_detector_selects_stub():
    settings = Settings(detector_provider="stub")
    assert isinstance(get_detector(settings), StubDetector)


def test_get_detector_selects_vlm_local_with_resolved_defaults():
    settings = Settings(detector_provider="vlm-local")
    detector = get_detector(settings)
    assert isinstance(detector, VisionLanguageModelAdapter)
    assert detector._base_url == "http://localhost:11434/v1"
    assert detector._model == "qwen2.5vl:3b"


def test_get_detector_selects_vlm_api_with_explicit_config():
    settings = Settings(
        detector_provider="vlm-api",
        detector_base_url="https://api.example.com/v1",
        detector_model="qwen2.5-vl-72b",
        detector_api_key="secret",
    )
    detector = get_detector(settings)
    assert isinstance(detector, VisionLanguageModelAdapter)
    assert detector._base_url == "https://api.example.com/v1"
    assert detector._model == "qwen2.5-vl-72b"
