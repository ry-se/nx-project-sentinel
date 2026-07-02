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
    nothing else in the app changes (proves the seam, W2 acceptance criterion)."""
    from app.detector.stub_adapter import StubDetector
    from app.detector.vision_adapter import VisionLanguageModelAdapter

    if settings.detector_provider == "stub":
        return StubDetector()
    if settings.detector_provider in ("vlm-local", "vlm-api"):
        return VisionLanguageModelAdapter(
            base_url=settings.resolved_detector_base_url,
            model=settings.resolved_detector_model,
            api_key=settings.detector_api_key,
        )
    raise DetectorError(f"unknown detector_provider: {settings.detector_provider!r}")
