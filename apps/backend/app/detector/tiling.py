import asyncio
import io
import math
from dataclasses import dataclass

import structlog
from PIL import Image

from app.detector.base import Detector, DetectorError
from app.schemas import DetectionBox, ImagePose

logger = structlog.get_logger(__name__)

# Tile size tuned to stay under a provider's internal high-detail downscale threshold —
# OpenAI's gpt-4o scales an image's shortest side to 768px even with detail="high" (see
# workspaces/sentinel/01-analysis/03-product-strategy/06-detection-precision-root-cause.md).
# Keeping every tile's shortest side <= 768 means the provider never has to downscale a
# tile before reasoning about it, closing the coordinate-compression error that made
# full-size captures imprecise (workspaces/sentinel/journal/0008-0011: tight crops were
# accurate in every test this session; full captures were not).
TILE_SIZE = 700
TILE_OVERLAP = 150


@dataclass(frozen=True)
class TileSpec:
    """A tile's offset + size within the full captured image, in pixels."""

    x: int
    y: int
    width: int
    height: int


def compute_tiles(
    image_width: int, image_height: int, tile_size: int = TILE_SIZE, overlap: int = TILE_OVERLAP
) -> list[TileSpec]:
    """Overlapping grid covering the full image — the overlap means a vehicle sitting on
    a tile boundary is still fully visible in at least one tile, not split across two."""
    if image_width <= 0 or image_height <= 0:
        raise ValueError(f"invalid image dimensions: {image_width}x{image_height}")
    if tile_size <= 0:
        raise ValueError(f"tile_size must be positive, got {tile_size}")
    stride = tile_size - overlap
    if stride <= 0:
        raise ValueError(f"overlap ({overlap}) must be smaller than tile_size ({tile_size})")

    tiles: list[TileSpec] = []
    y = 0
    while True:
        tile_h = min(tile_size, image_height - y)
        x = 0
        while True:
            tile_w = min(tile_size, image_width - x)
            tiles.append(TileSpec(x=x, y=y, width=tile_w, height=tile_h))
            if x + tile_w >= image_width:
                break
            x += stride
        if y + tile_h >= image_height:
            break
        y += stride
    return tiles


def remap_box_to_full_image(box: DetectionBox, tile: TileSpec) -> DetectionBox:
    """Adds the tile's offset to rear/front — no scaling needed since tiles are cropped,
    never resized, so pixel units are identical between tile-local and full-image space."""
    return box.model_copy(
        update={
            "rear": (box.rear[0] + tile.x, box.rear[1] + tile.y),
            "front": (box.front[0] + tile.x, box.front[1] + tile.y),
        }
    )


def is_within_image_bounds(box: DetectionBox, image_width: int, image_height: int) -> bool:
    """A model occasionally reports a tile-local coordinate slightly beyond its own crop's
    edge (doesn't strictly respect the tile it was given) — once remapped, that lands
    outside the true captured image entirely, which is provably wrong: no real object can
    be there. Checked on the CENTER point (rear/front midpoint), not the individual
    keypoints, so a detection whose front/rear straddle a tile's own crop edge (a legitimate
    partially-visible vehicle) isn't penalized for a keypoint landing exactly on the seam."""
    cx, cy = _center(box)
    return 0.0 <= cx <= image_width and 0.0 <= cy <= image_height


def _center(box: DetectionBox) -> tuple[float, float]:
    return ((box.rear[0] + box.front[0]) / 2.0, (box.rear[1] + box.front[1]) / 2.0)


def merge_detections(detections: list[DetectionBox]) -> list[DetectionBox]:
    """Suppresses near-duplicate detections from overlapping tiles — the SAME vehicle
    sitting in the overlap region between two tiles can be detected twice. Two detections
    are treated as the same vehicle when their centers are closer than the sum of their
    half-widths (their boxes plausibly overlap); the higher-confidence one is kept. IDs are
    reassigned sequentially afterward — per-tile adapter IDs (`vlm-0`, `vlm-1`, ...) collide
    across tiles, which would break the frontend's use of `id` as a React list key."""
    kept: list[DetectionBox] = []
    for box in sorted(detections, key=lambda b: b.confidence, reverse=True):
        box_center = _center(box)
        is_duplicate = any(
            math.hypot(box_center[0] - _center(existing)[0], box_center[1] - _center(existing)[1])
            < (box.half_width_px + existing.half_width_px)
            for existing in kept
        )
        if not is_duplicate:
            kept.append(box)
    return [b.model_copy(update={"id": f"vlm-{i}"}) for i, b in enumerate(kept)]


class TilingDetector(Detector):
    """Wraps an inner Detector, splitting the capture into overlapping tiles before
    detection and merging the remapped results — trades N concurrent calls (latency ≈ the
    slowest single tile, not the sum) for materially better pixel-coordinate precision.
    Provider-agnostic: wraps whichever Detector `get_detector()` constructed, so it works
    identically for vlm-local and vlm-api (W2 invariant 2)."""

    def __init__(self, inner: Detector, tile_size: int = TILE_SIZE, overlap: int = TILE_OVERLAP):
        self._inner = inner
        self._tile_size = tile_size
        self._overlap = overlap

    async def detect(self, image_bytes: bytes, pose: ImagePose | None = None) -> list[DetectionBox]:
        try:
            image = Image.open(io.BytesIO(image_bytes))
            image.load()
        except Exception as exc:
            logger.warning("tiling.decode_failed", error=str(exc))
            raise DetectorError("tiling: could not decode image for tiling") from exc

        tiles = compute_tiles(image.width, image.height, self._tile_size, self._overlap)
        logger.info(
            "tiling.start", tile_count=len(tiles), image_width=image.width, image_height=image.height
        )

        async def detect_tile(tile: TileSpec) -> list[DetectionBox]:
            crop = image.crop((tile.x, tile.y, tile.x + tile.width, tile.y + tile.height))
            buf = io.BytesIO()
            crop.convert("RGB").save(buf, format="PNG")
            boxes = await self._inner.detect(buf.getvalue(), pose)
            remapped = [remap_box_to_full_image(b, tile) for b in boxes]
            in_bounds, out_of_bounds = [], 0
            for b in remapped:
                if is_within_image_bounds(b, image.width, image.height):
                    in_bounds.append(b)
                else:
                    out_of_bounds += 1
            if out_of_bounds:
                logger.warning(
                    "tiling.out_of_bounds_detection_dropped",
                    count=out_of_bounds,
                    tile_x=tile.x,
                    tile_y=tile.y,
                )
            return in_bounds

        # Concurrent, not sequential — N tiles must cost ~1 tile's latency, not N tiles'
        # (todo 03b invariant 6). return_exceptions so one bad tile doesn't sink the rest.
        results = await asyncio.gather(*(detect_tile(t) for t in tiles), return_exceptions=True)

        all_boxes: list[DetectionBox] = []
        failed_tiles = 0
        for result in results:
            if isinstance(result, BaseException):
                failed_tiles += 1
                logger.warning("tiling.tile_failed", error=str(result))
                continue
            all_boxes.extend(result)

        if failed_tiles == len(tiles):
            raise DetectorError("tiling: every tile failed")

        merged = merge_detections(all_boxes)
        logger.info(
            "tiling.ok", raw_count=len(all_boxes), merged_count=len(merged), failed_tiles=failed_tiles
        )
        return merged
