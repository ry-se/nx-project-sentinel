from abc import ABC, abstractmethod

from app.config import Settings
from app.schemas import DetectionBox, ImagePose


class DetectorError(Exception):
    """Typed failure for any detector/provider error — never silently return an empty or
    fabricated result (.claude/rules/zero-tolerance.md Rule 3)."""


class Detector(ABC):
    """Provider-agnostic oriented-detection seam. Any future/better model implements
    detect() and nothing downstream (routes, schemas, frontend) changes."""

    @abstractmethod
    async def detect(self, image_bytes: bytes, pose: ImagePose | None = None) -> list[DetectionBox]:
        """Returns oriented detections (rear/front keypoints, not just a box).

        Raises DetectorError on any provider failure, malformed response, or
        out-of-contract output — never a silent empty/fabricated success.
        """


def get_detector(settings: Settings) -> Detector:
    """Selects the active adapter via settings.detector_provider — the ONLY place a
    provider name is switched on; adding a new provider means adding a branch here,
    nothing else in the app changes (proves the seam, W2 acceptance criterion).

    Tiling (todo 03b) wraps whichever provider adapter was selected — it's a modifier on
    top of the provider choice, not a provider itself, so it applies uniformly regardless
    of which branch above fired. Stub is exempt: tiling a fixture response serves no
    purpose and would just multiply fixture calls.
    """
    from app.detector.stub_adapter import StubDetector
    from app.detector.tiling import TilingDetector
    from app.detector.vision_adapter import VisionLanguageModelAdapter

    if settings.detector_provider == "stub":
        return StubDetector()
    if settings.detector_provider in ("vlm-local", "vlm-api"):
        adapter: Detector = VisionLanguageModelAdapter(
            base_url=settings.resolved_detector_base_url,
            model=settings.resolved_detector_model,
            api_key=settings.detector_api_key,
            reasoning_effort=settings.detector_reasoning_effort or None,
            omit_temperature=settings.detector_omit_temperature,
        )
        if settings.detector_tiling_enabled:
            adapter = TilingDetector(adapter)
        return adapter
    raise DetectorError(f"unknown detector_provider: {settings.detector_provider!r}")
