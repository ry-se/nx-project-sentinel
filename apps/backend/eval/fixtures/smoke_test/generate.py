"""Regenerates the smoke_test/*.png images. Not a Tier-2/3 test itself — a one-off
generator, re-run only if the smoke fixtures need to change shape. See ../README.md."""

from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).parent


def make_afv_image() -> None:
    """A single dark rectangle roughly where StubDetector's fixed box (rear=(100,220),
    front=(140,180)) points — matches match_hit.json's ground truth."""
    img = Image.new("RGB", (400, 300), color=(120, 150, 90))
    draw = ImageDraw.Draw(img)
    draw.rectangle([90, 175, 150, 225], fill=(40, 40, 45))
    img.save(HERE / "afv_present.png")


def make_empty_image() -> None:
    """No target at all — ground truth expects an aircraft that never appears, so the
    stub's fixed AFV box becomes an unmatched (false-positive) prediction."""
    img = Image.new("RGB", (400, 300), color=(180, 200, 220))
    img.save(HERE / "no_aircraft_present.png")


if __name__ == "__main__":
    make_afv_image()
    make_empty_image()
    print(f"Wrote smoke fixtures to {HERE}")
