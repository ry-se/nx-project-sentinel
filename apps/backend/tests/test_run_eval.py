"""W6 — direct unit coverage for run_eval.py's matching + geo-error logic (not just the
end-to-end smoke run against fixtures). Our own code — no mocking (.claude/rules/testing.md
3-Tier contract); DetectionBox is a real schema instance, not a stub of our own logic."""

import asyncio
import json
from pathlib import Path

import pytest

from eval.run_eval import (
    ClassStats,
    GroundTruthBox,
    estimate_geo_error_m,
    load_fixtures,
    match_predictions,
    run,
)
from app.config import Settings
from app.schemas import DetectionBox

SMOKE_FIXTURES_DIR = Path(__file__).resolve().parents[1] / "eval" / "fixtures" / "smoke_test"


def _box(cls: str, rear: tuple[float, float], front: tuple[float, float]) -> DetectionBox:
    return DetectionBox(
        id="t",
        cls=cls,
        rear=rear,
        front=front,
        half_width_px=10.0,
        confidence=0.9,
        heading_confidence="high",
    )


def test_exact_match_counts_as_true_positive_with_zero_pixel_error():
    gt = [GroundTruthBox(cls="armored_fighting_vehicle", rear=(100, 220), front=(140, 180))]
    preds = [_box("armored_fighting_vehicle", (100, 220), (140, 180))]

    stats: dict[str, ClassStats] = {}
    match_predictions(gt, preds, threshold_px=60, stats_by_class=stats)

    s = stats["armored_fighting_vehicle"]
    assert s.true_positives == 1
    assert s.false_positives == 0
    assert s.false_negatives == 0
    assert s.pixel_errors == [0.0]
    assert s.precision == 1.0
    assert s.recall == 1.0


def test_prediction_beyond_threshold_is_a_false_negative_plus_false_positive():
    gt = [GroundTruthBox(cls="aircraft", rear=(0, 0), front=(0, 10))]
    preds = [_box("aircraft", (500, 500), (500, 510))]  # far outside any reasonable threshold

    stats: dict[str, ClassStats] = {}
    match_predictions(gt, preds, threshold_px=60, stats_by_class=stats)

    s = stats["aircraft"]
    assert s.true_positives == 0
    assert s.false_negatives == 1  # the real target was missed
    assert s.false_positives == 1  # the prediction didn't correspond to any real target
    assert s.recall == 0.0


def test_class_mismatch_never_matches_even_at_zero_distance():
    gt = [GroundTruthBox(cls="aircraft", rear=(100, 100), front=(100, 110))]
    preds = [_box("light_military_vehicle", (100, 100), (100, 110))]  # same pixels, wrong class

    stats: dict[str, ClassStats] = {}
    match_predictions(gt, preds, threshold_px=60, stats_by_class=stats)

    assert stats["aircraft"].false_negatives == 1
    assert stats["aircraft"].true_positives == 0
    assert stats["light_military_vehicle"].false_positives == 1


def test_missing_prediction_entirely_is_false_negative_no_false_positive():
    gt = [GroundTruthBox(cls="aircraft", rear=(0, 0), front=(0, 10))]

    stats: dict[str, ClassStats] = {}
    match_predictions(gt, [], threshold_px=60, stats_by_class=stats)

    s = stats["aircraft"]
    assert s.false_negatives == 1
    assert s.false_positives == 0
    assert s.recall == 0.0
    assert s.precision is None  # no predictions at all — precision is undefined, not 0


def test_class_stats_precision_recall_none_when_no_denominator():
    s = ClassStats()
    assert s.precision is None
    assert s.recall is None
    assert s.mean_pixel_error is None


def test_estimate_geo_error_m_scales_with_pixel_error():
    small = estimate_geo_error_m(pixel_error=1, alt_m=300, fov_deg=60, image_height_px=1000)
    large = estimate_geo_error_m(pixel_error=10, alt_m=300, fov_deg=60, image_height_px=1000)
    assert large == small * 10


def test_estimate_geo_error_m_zero_pixel_error_is_zero_ground_error():
    assert estimate_geo_error_m(pixel_error=0, alt_m=300, fov_deg=60, image_height_px=1000) == 0.0


# ---- load_fixtures + end-to-end run() coverage (the harness paths the unit tests above
# don't reach: fixture loading, validation guards, the geo-error attribution loop, exit code) ----


def test_load_fixtures_reads_the_smoke_fixtures():
    fixtures = load_fixtures(SMOKE_FIXTURES_DIR)
    by_name = {f.name: f for f in fixtures}
    assert set(by_name) == {"afv_present", "no_aircraft_present"}
    # afv_present carries a pose (alt_m/fov_deg) → geo-error is computable for it
    assert by_name["afv_present"].fov_deg == 60
    assert by_name["afv_present"].alt_m == 300
    assert by_name["afv_present"].pose is not None
    # no_aircraft_present omits pose → geo-error column skipped for it
    assert by_name["no_aircraft_present"].pose is None
    assert by_name["afv_present"].ground_truth[0].cls == "armored_fighting_vehicle"


def test_load_fixtures_rejects_unknown_class(tmp_path):
    (tmp_path / "bad.png").write_bytes(b"\x89PNG\r\n")  # bytes never decoded — load fails first
    (tmp_path / "bad.json").write_text(
        json.dumps(
            {"image": "bad.png", "ground_truth": [{"cls": "aircrat", "rear": [0, 0], "front": [0, 1]}]}
        )
    )
    with pytest.raises(ValueError, match="not a DetectionClass"):
        load_fixtures(tmp_path)


def test_load_fixtures_rejects_image_path_escaping_fixtures_dir(tmp_path):
    (tmp_path / "escape.json").write_text(
        json.dumps(
            {
                "image": "../../../etc/passwd",
                "ground_truth": [{"cls": "aircraft", "rear": [0, 0], "front": [0, 1]}],
            }
        )
    )
    with pytest.raises(ValueError, match="escapes the fixtures dir"):
        load_fixtures(tmp_path)


@pytest.mark.regression
def test_run_end_to_end_against_stub_detector(monkeypatch):
    """Proves the whole harness runs (load → detect via the real get_detector seam →
    match → report → exit code) against the deterministic stub, not just the unit-level
    helpers. Regression guard for the commit-body claim that the smoke fixtures prove the
    harness runs end-to-end.

    run() calls get_settings() directly (not via FastAPI Depends), and it's lru_cached, so
    patch the symbol run_eval imported into its own namespace rather than
    app.dependency_overrides (which only affects request-time injection)."""
    import eval.run_eval as run_eval_mod

    monkeypatch.setattr(run_eval_mod, "get_settings", lambda: Settings(detector_provider="stub"))
    exit_code = asyncio.run(run(SMOKE_FIXTURES_DIR, match_threshold_px=60))

    # No fixture errored (both decode + the stub always returns a box) → clean exit.
    assert exit_code == 0
