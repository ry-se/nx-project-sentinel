from app.detector.base import Detector
from app.schemas import DetectionBox, ImagePose


class StubDetector(Detector):
    """One fixed oriented box — explicit dev/test provider, no model call. Also proves
    the seam: swapping DETECTOR_PROVIDER to this adapter requires zero changes outside
    detector/ (W2 acceptance criterion)."""

    async def detect(self, image_bytes: bytes, pose: ImagePose | None = None) -> list[DetectionBox]:
        return [
            DetectionBox(
                id="stub-0",
                cls="armored_fighting_vehicle",
                rear=(100.0, 220.0),
                front=(140.0, 180.0),
                half_width_px=18.0,
                confidence=0.5,
                heading_confidence="low",
            )
        ]
