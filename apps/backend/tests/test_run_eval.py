"""W6 — direct unit coverage for run_eval.py's matching + geo-error logic (not just the
end-to-end smoke run against fixtures). Our own code — no mocking (.claude/rules/testing.md
3-Tier contract); DetectionBox is a real schema instance, not a stub of our own logic."""

from eval.run_eval import ClassStats, GroundTruthBox, estimate_geo_error_m, match_predictions
from app.schemas import DetectionBox


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
