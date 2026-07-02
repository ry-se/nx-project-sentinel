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

    async def _fake(image_bytes: bytes) -> str:
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
