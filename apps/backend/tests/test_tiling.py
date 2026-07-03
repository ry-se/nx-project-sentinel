import asyncio
import io
import time

import pytest
from PIL import Image

from app.detector.base import Detector, DetectorError
from app.detector.tiling import (
    TilingDetector,
    compute_tiles,
    is_within_image_bounds,
    merge_detections,
    remap_box_to_full_image,
)
from app.schemas import DetectionBox


def _box(rear, front, half_width_px=10.0, confidence=0.9, id_="vlm-0") -> DetectionBox:
    return DetectionBox(
        id=id_,
        cls="armored_fighting_vehicle",
        rear=rear,
        front=front,
        halfWidthPx=half_width_px,
        confidence=confidence,
        heading_confidence="high",
    )


def _png_bytes(width: int, height: int) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (width, height), color=(80, 110, 70)).save(buf, format="PNG")
    return buf.getvalue()


# ---------- compute_tiles: known-offset grid math ----------


def test_compute_tiles_2x2_grid():
    # tile_size=100, overlap=20 -> stride=80. image 150x150: x=0 (w=100), x=80 (w=70,
    # reaches 150) -> 2 columns; same for rows -> 2x2 = 4 tiles.
    tiles = compute_tiles(150, 150, tile_size=100, overlap=20)
    assert len(tiles) == 4
    coords = {(t.x, t.y) for t in tiles}
    assert coords == {(0, 0), (80, 0), (0, 80), (80, 80)}
    # every tile reaches the image edge — no gap
    for t in tiles:
        assert t.x + t.width in (100, 150)
        assert t.y + t.height in (100, 150)


def test_compute_tiles_3x3_grid():
    # tile_size=100, overlap=50 -> stride=50. image 200x200: x=0,50,100 (w=100 each,
    # reaches 200) -> 3 columns; same rows -> 3x3 = 9 tiles.
    tiles = compute_tiles(200, 200, tile_size=100, overlap=50)
    assert len(tiles) == 9
    xs = sorted({t.x for t in tiles})
    ys = sorted({t.y for t in tiles})
    assert xs == [0, 50, 100]
    assert ys == [0, 50, 100]


def test_compute_tiles_covers_full_image_no_gaps():
    tiles = compute_tiles(1677, 938, tile_size=700, overlap=150)
    max_x = max(t.x + t.width for t in tiles)
    max_y = max(t.y + t.height for t in tiles)
    assert max_x == 1677
    assert max_y == 938
    assert min(t.x for t in tiles) == 0
    assert min(t.y for t in tiles) == 0


def test_compute_tiles_single_tile_when_image_smaller_than_tile_size():
    tiles = compute_tiles(400, 300, tile_size=700, overlap=150)
    assert len(tiles) == 1
    assert tiles[0].x == 0 and tiles[0].y == 0
    assert tiles[0].width == 400 and tiles[0].height == 300


def test_compute_tiles_rejects_invalid_dimensions():
    with pytest.raises(ValueError):
        compute_tiles(0, 100)
    with pytest.raises(ValueError):
        compute_tiles(100, -1)


def test_compute_tiles_rejects_overlap_not_smaller_than_tile_size():
    with pytest.raises(ValueError):
        compute_tiles(500, 500, tile_size=100, overlap=100)
    with pytest.raises(ValueError):
        compute_tiles(500, 500, tile_size=100, overlap=150)


# ---------- remap_box_to_full_image: known offsets ----------


def test_remap_box_to_full_image_adds_tile_offset():
    from app.detector.tiling import TileSpec

    box = _box(rear=(10.0, 20.0), front=(10.0, 40.0))
    tile = TileSpec(x=500, y=300, width=700, height=700)

    remapped = remap_box_to_full_image(box, tile)

    assert remapped.rear == (510.0, 320.0)
    assert remapped.front == (510.0, 340.0)
    # half_width_px is unchanged — tiles are cropped, never resized, so pixel scale
    # is identical between tile-local and full-image space.
    assert remapped.half_width_px == box.half_width_px


def test_remap_box_to_full_image_zero_offset_is_identity():
    from app.detector.tiling import TileSpec

    box = _box(rear=(5.0, 5.0), front=(5.0, 15.0))
    remapped = remap_box_to_full_image(box, TileSpec(x=0, y=0, width=700, height=700))
    assert remapped.rear == box.rear
    assert remapped.front == box.front


# ---------- is_within_image_bounds: catches the real bottom-right overshoot found in
# manual verification (journal/0017) — a model reporting a tile-local point beyond its own
# crop's edge, which remaps to somewhere outside the true captured image ----------


def test_is_within_image_bounds_true_for_a_point_inside():
    box = _box(rear=(100.0, 100.0), front=(100.0, 120.0))
    assert is_within_image_bounds(box, image_width=1677, image_height=938) is True


def test_is_within_image_bounds_false_when_center_exceeds_height():
    # Reproduces the real observed case: tile-local y overshoots the tile's own crop,
    # remaps to y=1050 against a 938-tall image.
    box = _box(rear=(1550.0, 1040.0), front=(1580.0, 1060.0))
    assert is_within_image_bounds(box, image_width=1677, image_height=938) is False


def test_is_within_image_bounds_false_when_center_is_negative():
    box = _box(rear=(-20.0, 50.0), front=(-10.0, 70.0))
    assert is_within_image_bounds(box, image_width=1677, image_height=938) is False


def test_is_within_image_bounds_true_exactly_at_the_edge():
    box = _box(rear=(1677.0, 938.0), front=(1677.0, 938.0))
    assert is_within_image_bounds(box, image_width=1677, image_height=938) is True


# ---------- merge_detections: dedup + id reassignment ----------


def test_merge_detections_dedupes_overlapping_centers_keeps_higher_confidence():
    low_conf = _box(rear=(100.0, 100.0), front=(100.0, 120.0), confidence=0.6, id_="vlm-0")
    high_conf = _box(rear=(105.0, 102.0), front=(105.0, 122.0), confidence=0.95, id_="vlm-0")

    merged = merge_detections([low_conf, high_conf])

    assert len(merged) == 1
    assert merged[0].confidence == 0.95


def test_merge_detections_keeps_distinct_far_apart_detections():
    a = _box(rear=(0.0, 0.0), front=(0.0, 20.0), id_="vlm-0")
    b = _box(rear=(1000.0, 1000.0), front=(1000.0, 1020.0), id_="vlm-0")

    merged = merge_detections([a, b])

    assert len(merged) == 2


def test_merge_detections_reassigns_sequential_ids_avoiding_cross_tile_collisions():
    # Two boxes from different tiles both carrying the adapter's own "vlm-0" id — a real
    # collision the frontend's React key would choke on if left unresolved.
    a = _box(rear=(0.0, 0.0), front=(0.0, 20.0), id_="vlm-0")
    b = _box(rear=(1000.0, 1000.0), front=(1000.0, 1020.0), id_="vlm-0")

    merged = merge_detections([a, b])

    ids = [m.id for m in merged]
    assert len(ids) == len(set(ids))  # unique


def test_merge_detections_empty_input():
    assert merge_detections([]) == []


# ---------- TilingDetector: end-to-end with a fake inner detector ----------


class _FakeInnerDetector(Detector):
    """Returns one detection per tile, at a fixed tile-local point, with a configurable
    per-call delay (to test concurrency) and configurable failures (to test resilience)."""

    def __init__(self, delay_s: float = 0.0, fail_calls: int = 0):
        self.delay_s = delay_s
        self.fail_calls = fail_calls
        self.call_count = 0

    async def detect(self, image_bytes: bytes, pose=None) -> list[DetectionBox]:
        self.call_count += 1
        if self.delay_s:
            await asyncio.sleep(self.delay_s)
        if self.call_count <= self.fail_calls:
            raise DetectorError("simulated tile failure")
        return [_box(rear=(10.0, 10.0), front=(10.0, 30.0), id_="vlm-0")]


async def test_tiling_detector_calls_inner_per_tile_and_remaps():
    inner = _FakeInnerDetector()
    detector = TilingDetector(inner, tile_size=100, overlap=20)

    boxes = await detector.detect(_png_bytes(150, 150))

    # 2x2 grid (per test_compute_tiles_2x2_grid) -> 4 tile calls, but the fake detections
    # all land at local (10,10)-(10,30) inside overlapping tiles, so some get merged.
    assert inner.call_count == 4
    assert len(boxes) >= 1
    # every returned box is remapped away from raw tile-local coordinates for at least
    # the non-origin tiles
    assert any(b.rear != (10.0, 10.0) for b in boxes)


async def test_tiling_detector_drops_out_of_bounds_detection_end_to_end():
    """Reproduces the real bottom-right overshoot found in manual verification
    (journal/0017): a tile-local coordinate beyond that tile's own crop remaps to
    somewhere outside the true image — must be dropped, not silently kept."""

    class _OutOfBoundsInner(Detector):
        async def detect(self, image_bytes: bytes, pose=None) -> list[DetectionBox]:
            # local y=90 in a 100-tall tile is already suspicious, but well past the
            # tile's own 100px height (150) definitely overshoots once remapped from the
            # bottom tile (offset y=50 for a 150-tall image, tile_size=100, overlap=20).
            return [_box(rear=(10.0, 10.0), front=(10.0, 150.0), id_="vlm-0")]

    detector = TilingDetector(_OutOfBoundsInner(), tile_size=100, overlap=20)
    boxes = await detector.detect(_png_bytes(150, 150))

    # front.y=150 remapped from the y=50 tile -> 200, which exceeds the 150-tall image —
    # every returned box must be within [0, 150] on both axes.
    for b in boxes:
        assert 0.0 <= b.rear[1] <= 150.0
        assert 0.0 <= b.front[1] <= 150.0


async def test_tiling_detector_runs_tiles_concurrently_not_sequentially():
    # 4 tiles, each taking 0.2s if run sequentially -> 0.8s total. Concurrently, total
    # should be close to 0.2s (invariant 6: N tiles must cost ~1 tile's latency).
    inner = _FakeInnerDetector(delay_s=0.2)
    detector = TilingDetector(inner, tile_size=100, overlap=20)

    start = time.monotonic()
    await detector.detect(_png_bytes(150, 150))
    elapsed = time.monotonic() - start

    assert inner.call_count == 4
    assert elapsed < 0.6  # well under the 0.8s sequential bound; concurrent stays ~0.2-0.3s


async def test_tiling_detector_partial_tile_failure_still_returns_others():
    inner = _FakeInnerDetector(fail_calls=1)
    detector = TilingDetector(inner, tile_size=100, overlap=20)

    boxes = await detector.detect(_png_bytes(150, 150))

    assert inner.call_count == 4
    assert len(boxes) >= 1  # the 3 succeeding tiles still contribute


async def test_tiling_detector_all_tiles_failing_raises_detector_error():
    inner = _FakeInnerDetector(fail_calls=4)
    detector = TilingDetector(inner, tile_size=100, overlap=20)

    with pytest.raises(DetectorError):
        await detector.detect(_png_bytes(150, 150))


async def test_tiling_detector_rejects_undecodable_image():
    detector = TilingDetector(_FakeInnerDetector())
    with pytest.raises(DetectorError):
        await detector.detect(b"not a real image")
