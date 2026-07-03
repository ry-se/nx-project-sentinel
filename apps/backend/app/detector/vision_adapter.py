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

_PROMPT = """Find every combat vehicle or aircraft in this image.

For EACH object, first briefly note (one short line) which visible feature tells you
which end is the front — e.g. turret/gun barrel direction, hull taper, track/wheel
orientation, nose vs tail. Do not assume every object faces the same way; look at each
one independently. (A terse "always answer the same direction" shortcut here produces
detections that are wrong every time — see workspaces/sentinel/journal/0013 for the
regression this closes.)

Then output a JSON array of objects, each with:
- cls: one of "AFV" (armored fighting vehicle / tank), "LMV" (light military vehicle / \
truck / car), "aircraft"
- rear: [x, y] pixel coordinates of the object's rear point
- front: [x, y] pixel coordinates of the object's front point, matching the reasoning above
- box: [x, y, w, h] the object's bounding box in absolute pixel coordinates
- confidence: a number from 0.0 to 1.0

End your response with the JSON array wrapped in a ```json code fence, and put NOTHING
after it. If no objects are found, the array is []."""


class VisionLanguageModelAdapter(Detector):
    """Prompts a grounding VLM (Qwen2.5-VL-class) for oriented per-object detections.
    Works identically against a local (Ollama, OpenAI-compatible) or hosted API endpoint —
    the wire protocol (OpenAI chat completions + a vision content block) is the same;
    only base_url/api_key/model differ (W2 invariant 2: provider-agnostic, .env-selected).
    See workspaces/sentinel/01-analysis/03-product-strategy/05-detector-orientation-research.md.
    """

    def __init__(
        self,
        base_url: str,
        model: str,
        api_key: str | None,
        reasoning_effort: str | None = None,
        omit_temperature: bool = False,
    ):
        if not base_url or not model:
            raise DetectorError(
                "vision adapter requires both a base_url and a model — check "
                "DETECTOR_BASE_URL / DETECTOR_MODEL in .env"
            )
        self._base_url = base_url.rstrip("/")
        self._model = model
        self._api_key = api_key
        self._reasoning_effort = reasoning_effort
        # Decoupled from reasoning_effort — verified live that gpt-5.5 rejects
        # temperature=0.0 even with NO reasoning_effort set (a model-level restriction,
        # not a reasoning-mode-specific one). DETECTOR_OMIT_TEMPERATURE covers that case
        # without changing default behavior for gpt-4o/qwen2.5vl.
        self._omit_temperature = omit_temperature

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
                            # detail="high" pins the provider's best-available image
                            # processing path explicitly rather than leaving it to an
                            # opaque "auto" heuristic — see
                            # workspaces/sentinel/journal/0012 for the analysis this
                            # closes (a plausible, previously-unpinned contributor to
                            # run-to-run detection inconsistency).
                            "image_url": {
                                "url": f"data:image/png;base64,{image_b64}",
                                "detail": "high",
                            },
                        },
                    ],
                }
            ],
        }
        if self._reasoning_effort:
            payload["reasoning_effort"] = self._reasoning_effort
        # Some models (verified live: gpt-5.5) reject an explicit temperature —
        # "'temperature' does not support 0.0 with this model. Only the default (1) value
        # is supported." — verified true BOTH with reasoning_effort active (journal/0018)
        # AND without it (journal/0019). Active reasoning_effort always implies omitting
        # temperature too (100% of tested cases so far); detector_omit_temperature covers
        # the non-reasoning case independently, without forcing callers to set both flags.
        if not (self._omit_temperature or self._reasoning_effort):
            payload["temperature"] = 0.0
        try:
            # 60s was tuned for non-reasoning models; reasoning-effort calls (o-series,
            # gpt-5.x) routinely take 40-60s+ per tile — verified live, 3 of 6 tiles hit
            # the old 60s ceiling and were silently discarded as failures, undercounting
            # real detections. 180s gives real headroom without changing non-reasoning
            # models' behavior (they still return well under this).
            timeout = 180.0 if self._reasoning_effort else 60.0
            async with httpx.AsyncClient(timeout=timeout) as client:
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
        # The prompt allows brief per-object reasoning before the final answer (see
        # workspaces/sentinel/journal/0013 — real per-object orientation needs reasoning
        # room; a terse JSON-only prompt made the model default to a fixed direction every
        # time). The prompt asks for the JSON array in a fence at the very end, so extract
        # the LAST fenced block rather than assuming the whole response is bare JSON.
        # A response with no fence at all (some providers ignore the instruction) falls
        # through unchanged to the json.loads() below, matching the prior behavior.
        last_fence = text.rfind("```")
        if last_fence != -1:
            opening_fence = text.rfind("```", 0, last_fence)
            if opening_fence != -1:
                fenced = text[opening_fence + 3 : last_fence]
                if fenced[:4].lower() == "json":
                    fenced = fenced[4:]
                text = fenced.strip()
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
