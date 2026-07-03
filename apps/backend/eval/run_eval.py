"""W6 evaluation harness — runs the configured detector (same seam production uses,
`get_detector(settings)`) over labelled fixtures and reports per-class precision/recall
plus mean localization error. Answers "is the accuracy good enough?" with a number, not a
claim (see workspaces/sentinel/todos/completed/00-overview... "Honest constraints" and
06-W6-tests-and-evaluation-harness.md "the honest gate").

Usage:
    uv run python eval/run_eval.py [--fixtures-dir eval/fixtures] [--match-threshold-px 60]

Swapping models is a config change, not a code change — set DETECTOR_PROVIDER /
DETECTOR_MODEL / DETECTOR_BASE_URL in .env (or the environment) before running, exactly as
production does via app.config.get_settings().
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import sys
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # apps/backend/ -> import app.*

from app.config import get_settings  # noqa: E402
from app.detector.base import Detector, DetectorError, get_detector  # noqa: E402
from app.schemas import DetectionBox, DetectionClass, ImagePose  # noqa: E402

DEFAULT_MATCH_THRESHOLD_PX = 60.0


@dataclass
class GroundTruthBox:
    cls: DetectionClass
    rear: tuple[float, float]
    front: tuple[float, float]

    @property
    def center(self) -> tuple[float, float]:
        return ((self.rear[0] + self.front[0]) / 2, (self.rear[1] + self.front[1]) / 2)


@dataclass
class Fixture:
    name: str
    image_path: Path
    ground_truth: list[GroundTruthBox]
    pose: ImagePose | None
    fov_deg: float | None
    alt_m: float | None


@dataclass
class ClassStats:
    true_positives: int = 0
    false_positives: int = 0
    false_negatives: int = 0
    pixel_errors: list[float] = field(default_factory=list)

    @property
    def precision(self) -> float | None:
        denom = self.true_positives + self.false_positives
        return self.true_positives / denom if denom else None

    @property
    def recall(self) -> float | None:
        denom = self.true_positives + self.false_negatives
        return self.true_positives / denom if denom else None

    @property
    def mean_pixel_error(self) -> float | None:
        return sum(self.pixel_errors) / len(self.pixel_errors) if self.pixel_errors else None


def _center(box: DetectionBox) -> tuple[float, float]:
    return ((box.rear[0] + box.front[0]) / 2, (box.rear[1] + box.front[1]) / 2)


def _dist(a: tuple[float, float], b: tuple[float, float]) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def load_fixtures(fixtures_dir: Path) -> list[Fixture]:
    fixtures: list[Fixture] = []
    for json_path in sorted(fixtures_dir.rglob("*.json")):
        data = json.loads(json_path.read_text())
        image_path = json_path.parent / data["image"]
        if not image_path.is_file():
            raise FileNotFoundError(f"{json_path}: image {image_path} does not exist")

        pose_data = data.get("pose")
        pose = None
        fov_deg = alt_m = None
        if pose_data:
            fov_deg = pose_data.get("fov_deg")
            alt_m = pose_data.get("alt_m")
            # ImagePose requires lat/lon/heading_deg too; eval fixtures only care about
            # geometry (alt_m/fov_deg), so synthetic zeros stand in — detectors that read
            # geographic context from the prompt are exercised against a real, plausible
            # pose in production and Tier-2 endpoint tests, not here.
            pose = ImagePose(
                lat=0.0, lon=0.0, alt_m=alt_m or 0.0, heading_deg=0.0, pitch_deg=-90.0
            )

        ground_truth = [
            GroundTruthBox(cls=gt["cls"], rear=tuple(gt["rear"]), front=tuple(gt["front"]))
            for gt in data["ground_truth"]
        ]
        fixtures.append(
            Fixture(
                name=json_path.stem,
                image_path=image_path,
                ground_truth=ground_truth,
                pose=pose,
                fov_deg=fov_deg,
                alt_m=alt_m,
            )
        )
    return fixtures


def estimate_geo_error_m(
    pixel_error: float, alt_m: float, fov_deg: float, image_height_px: int
) -> float:
    """Nadir-only ground-sample-distance estimate — the eval-harness sibling of the
    frontend's estimateGeoUncertaintyM, minus the obliquity correction (no raycast
    geometry available here, just a labelled straight-down capture assumption)."""
    fov_rad = math.radians(fov_deg)
    meters_per_pixel = (2 * alt_m * math.tan(fov_rad / 2)) / max(image_height_px, 1)
    return pixel_error * meters_per_pixel


def match_predictions(
    ground_truth: list[GroundTruthBox],
    predictions: list[DetectionBox],
    threshold_px: float,
    stats_by_class: dict[str, ClassStats],
) -> None:
    """Greedy nearest-neighbour matching, same-class only, within threshold_px. Simpler
    than oriented-box IoU (these are keypoint pairs, not axis-aligned boxes) — documented
    approximation, sufficient for a precision/recall signal."""
    unmatched_predictions = list(predictions)

    for gt in ground_truth:
        stats = stats_by_class.setdefault(gt.cls, ClassStats())
        candidates = [p for p in unmatched_predictions if p.cls == gt.cls]
        best: DetectionBox | None = None
        best_dist = math.inf
        for pred in candidates:
            d = _dist(gt.center, _center(pred))
            if d < best_dist:
                best, best_dist = pred, d
        if best is not None and best_dist <= threshold_px:
            stats.true_positives += 1
            stats.pixel_errors.append(best_dist)
            unmatched_predictions.remove(best)
        else:
            stats.false_negatives += 1

    for pred in unmatched_predictions:
        stats = stats_by_class.setdefault(pred.cls, ClassStats())
        stats.false_positives += 1


async def run(fixtures_dir: Path, match_threshold_px: float) -> int:
    settings = get_settings()
    detector: Detector = get_detector(settings)
    fixtures = load_fixtures(fixtures_dir)

    if not fixtures:
        print(f"No fixtures found under {fixtures_dir} — nothing to evaluate.")
        return 0

    stats_by_class: dict[str, ClassStats] = {}
    geo_errors_m: list[float] = []
    errored = 0

    print(f"Detector: provider={settings.detector_provider} model={settings.resolved_detector_model!r}")
    print(f"Fixtures: {len(fixtures)} ({fixtures_dir})\n")

    for fixture in fixtures:
        image_bytes = fixture.image_path.read_bytes()
        try:
            predictions = await detector.detect(image_bytes, fixture.pose)
        except DetectorError as exc:
            print(f"[{fixture.name}] detector error: {exc}")
            errored += 1
            continue

        before = {cls: (s.true_positives, len(s.pixel_errors)) for cls, s in stats_by_class.items()}
        match_predictions(fixture.ground_truth, predictions, match_threshold_px, stats_by_class)

        if fixture.fov_deg and fixture.alt_m:
            from PIL import Image

            with Image.open(fixture.image_path) as img:
                image_height_px = img.height
            for cls, stats in stats_by_class.items():
                prev_tp, prev_errs = before.get(cls, (0, 0))
                new_errors = stats.pixel_errors[prev_errs:]
                for px_err in new_errors:
                    geo_errors_m.append(
                        estimate_geo_error_m(
                            px_err, fixture.alt_m, fixture.fov_deg, image_height_px
                        )
                    )

    if errored:
        print(f"\n{errored}/{len(fixtures)} fixture(s) errored — see above.")

    print("\nPer-class precision/recall:")
    for cls in sorted(stats_by_class):
        s = stats_by_class[cls]
        p = f"{s.precision:.2f}" if s.precision is not None else "n/a"
        r = f"{s.recall:.2f}" if s.recall is not None else "n/a"
        mpe = f"{s.mean_pixel_error:.1f}px" if s.mean_pixel_error is not None else "n/a"
        print(
            f"  {cls:<28} precision={p:<6} recall={r:<6} "
            f"tp={s.true_positives} fp={s.false_positives} fn={s.false_negatives} "
            f"mean_pixel_error={mpe}"
        )

    if geo_errors_m:
        mean_geo = sum(geo_errors_m) / len(geo_errors_m)
        print(
            f"\nMean geolocation error (estimated, nadir-only GSD, n={len(geo_errors_m)}): "
            f"{mean_geo:.1f}m"
        )
    else:
        print("\nMean geolocation error: n/a (no fixture provided pose.alt_m + pose.fov_deg)")

    return 1 if errored == len(fixtures) and fixtures else 0


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--fixtures-dir",
        type=Path,
        default=Path(__file__).parent / "fixtures",
        help="Directory to search recursively for *.json fixtures (default: eval/fixtures)",
    )
    parser.add_argument(
        "--match-threshold-px",
        type=float,
        default=DEFAULT_MATCH_THRESHOLD_PX,
        help=f"Max pixel-center distance to count as a match (default: {DEFAULT_MATCH_THRESHOLD_PX})",
    )
    args = parser.parse_args()
    exit_code = asyncio.run(run(args.fixtures_dir, args.match_threshold_px))
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
