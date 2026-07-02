import base64
import json
import math

import httpx2 as httpx
import structlog

from app.detector.base import Detector, DetectorError
from app.detector.class_map import map_class
from app.schemas import DetectionBox, ImagePose

logger = structlog.get_logger(__name__)

# Caps on the third-party (model-controlled) response — defense against a hostile or
# misbehaving provider, not just malformed-but-honest output.
MAX_PROVIDER_RESPONSE_CHARS = 2_000_000
MAX_DETECTIONS_PER_RESPONSE = 200

_PROMPT = """Find every combat vehicle or aircraft in this image. For each object return
one JSON entry with:
- cls: one of "AFV" (armored fighting vehicle / tank), "LMV" (light military vehicle / \
truck / car), "aircraft"
- rear: [x, y] pixel coordinates of the object's rear point
- front: [x, y] pixel coordinates of the object's front point (the direction it faces)
- box: [x, y, w, h] the object's bounding box in absolute pixel coordinates
- confidence: a number from 0.0 to 1.0

Respond with ONLY a JSON array of these objects, absolute pixel coordinates, no markdown
fences, no prose. If no objects are found, respond with []."""


class VisionLanguageModelAdapter(Detector):
    """Prompts a grounding VLM (Qwen2.5-VL-class) for oriented per-object detections.
    Works identically against a local (Ollama, OpenAI-compatible) or hosted API endpoint —
    the wire protocol (OpenAI chat completions + a vision content block) is the same;
    only base_url/api_key/model differ (W2 invariant 2: provider-agnostic, .env-selected).
    See workspaces/sentinel/01-analysis/03-product-strategy/05-detector-orientation-research.md.
    """

    def __init__(self, base_url: str, model: str, api_key: str | None):
        if not base_url or not model:
            raise DetectorError(
                "vision adapter requires both a base_url and a model — check "
                "DETECTOR_BASE_URL / DETECTOR_MODEL in .env"
            )
        self._base_url = base_url.rstrip("/")
        self._model = model
        self._api_key = api_key

    async def detect(self, image_bytes: bytes, pose: ImagePose | None = None) -> list[DetectionBox]:
        raw_text = await self._call_provider(image_bytes, pose)
        raw_detections = self._parse_response(raw_text)
        return self._to_detection_boxes(raw_detections)

    async def _call_provider(self, image_bytes: bytes, pose: ImagePose | None = None) -> str:
        """The third-party HTTP boundary — the seam tests monkeypatch to inject
        recorded/fixture responses (W2 acceptance criterion)."""
        image_b64 = base64.b64encode(image_bytes).decode()
        headers = {"Authorization": f"Bearer {self._api_key}"} if self._api_key else {}
        prompt_text = _PROMPT
        if pose is not None:
            # Context only — the model still MUST answer in image pixel coordinates;
            # pose helps it reason about scale/perspective, never a coordinate system swap.
            prompt_text += (
                f"\n\nCamera context (for scale/perspective reasoning only — still respond "
                f"in image pixel coordinates): heading {pose.heading_deg:.1f} deg, "
                f"pitch {pose.pitch_deg:.1f} deg, altitude {pose.alt_m:.0f}m."
            )
        payload = {
            "model": self._model,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt_text},
                        {
                            "type": "image_url",
                            "image_url": {"url": f"data:image/png;base64,{image_b64}"},
                        },
                    ],
                }
            ],
            "temperature": 0.0,
        }
        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
                resp = await client.post(
                    f"{self._base_url}/chat/completions", json=payload, headers=headers
                )
                resp.raise_for_status()
                data = resp.json()
        except httpx.HTTPError as exc:
            # str(exc) can embed the internal base_url (host/port/path) — log it, but
            # never return it to the API client (detect.py surfaces DetectorError's
            # message verbatim in the 502 body).
            logger.warning("vision_adapter.provider_error", error=str(exc))
            raise DetectorError("detector provider request failed") from exc

        try:
            return data["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as exc:
            logger.warning("vision_adapter.unexpected_response_shape", error=str(exc))
            raise DetectorError("detector provider returned an unexpected response shape") from exc

    def _parse_response(self, raw_text: str) -> list[dict]:
        if len(raw_text) > MAX_PROVIDER_RESPONSE_CHARS:
            logger.warning("vision_adapter.response_too_large", chars=len(raw_text))
            raise DetectorError("detector provider response exceeded the size limit")

        text = raw_text.strip()
        # Models sometimes wrap JSON in markdown fences despite the prompt — strip them.
        if text.startswith("```"):
            text = text.strip("`")
            if text[:4].lower() == "json":
                text = text[4:]
            text = text.strip()
        try:
            parsed = json.loads(text)
        except (json.JSONDecodeError, RecursionError, ValueError) as exc:
            # RecursionError covers pathologically deeply-nested JSON from a hostile or
            # misbehaving provider — the whole-response contract failure, per invariant 6.
            logger.warning("vision_adapter.invalid_json", error=str(exc))
            raise DetectorError("detector provider did not return valid JSON") from exc
        if not isinstance(parsed, list):
            logger.warning("vision_adapter.not_a_list", type_seen=type(parsed).__name__)
            raise DetectorError("detector provider response must be a JSON array")
        if len(parsed) > MAX_DETECTIONS_PER_RESPONSE:
            logger.warning("vision_adapter.too_many_detections", count=len(parsed))
            raise DetectorError("detector provider returned too many detections")
        return parsed

    def _to_detection_boxes(self, raw_detections: list[dict]) -> list[DetectionBox]:
        boxes: list[DetectionBox] = []
        for i, raw in enumerate(raw_detections):
            try:
                cls = map_class(str(raw["cls"]))
                if cls is None:
                    continue  # unmappable — dropped + logged by map_class, never coerced

                rear = (float(raw["rear"][0]), float(raw["rear"][1]))
                front = (float(raw["front"][0]), float(raw["front"][1]))
                half_width_px = float(raw["box"][2]) / 2.0
                confidence = float(raw["confidence"])
                if not all(math.isfinite(v) for v in (*rear, *front, half_width_px, confidence)):
                    logger.warning("vision_adapter.non_finite_value", index=i)
                    continue
                if not (0.0 <= confidence <= 1.0):
                    logger.warning(
                        "vision_adapter.confidence_out_of_range", confidence=confidence
                    )
                    continue

                boxes.append(
                    DetectionBox(
                        id=f"vlm-{i}",
                        cls=cls,
                        rear=rear,
                        front=front,
                        half_width_px=half_width_px,
                        confidence=confidence,
                        heading_confidence=_heading_confidence_from_geometry(rear, front),
                    )
                )
            except (KeyError, IndexError, TypeError, ValueError) as exc:
                # One malformed entry doesn't fail the whole response — same posture as
                # an unmappable class (invariant 3); the whole-response contract (JSON
                # shape, HTTP success) is what raises DetectorError, not a single entry.
                logger.warning("vision_adapter.malformed_detection", index=i, error=str(exc))
                continue
        return boxes


def _heading_confidence_from_geometry(rear: tuple[float, float], front: tuple[float, float]) -> str:
    """heading_confidence reflects how well-separated rear/front are — a near-identical
    pair gives the heading pipeline (front - rear) an unreliable axis to derive from."""
    dx, dy = front[0] - rear[0], front[1] - rear[1]
    separation = (dx * dx + dy * dy) ** 0.5
    if separation >= 10.0:
        return "high"
    if separation >= 3.0:
        return "medium"
    return "low"
