"""W6 schema-parity test — the backend's DetectionClass enum MUST byte-match the
frontend's DetectionClass union type. Detected via a live read + parse of the frontend
source (not a hand-copied literal here, which would itself drift silently) so a change on
either side fails this test immediately rather than at first live detection."""

import re
from pathlib import Path
from typing import get_args

from app.schemas import DetectionClass

# apps/backend/tests/test_schema_parity.py -> apps/backend/tests -> apps/backend -> apps -> repo root
REPO_ROOT = Path(__file__).resolve().parents[3]
FRONTEND_DETECTIONS_TS = (
    REPO_ROOT / "apps/frontend/src/features/sandbox/engine/detections.ts"
)

_TS_UNION_RE = re.compile(
    r"export type DetectionClass =\s*((?:\s*\|?\s*'[a-z_]+')+);", re.MULTILINE
)
_TS_LITERAL_RE = re.compile(r"'([a-z_]+)'")


def _extract_frontend_detection_classes() -> set[str]:
    """Parses `export type DetectionClass = 'a' | 'b' | 'c';` out of detections.ts.
    Raises loudly (not returns empty) if the source no longer matches the expected
    shape — a silently-empty extraction would make this test vacuously pass."""
    assert FRONTEND_DETECTIONS_TS.is_file(), (
        f"frontend source not found at {FRONTEND_DETECTIONS_TS} — schema-parity check "
        "cannot run against a moved/renamed file without updating this test"
    )
    source = FRONTEND_DETECTIONS_TS.read_text()
    match = _TS_UNION_RE.search(source)
    assert match is not None, (
        "could not find `export type DetectionClass = ...;` in detections.ts — "
        "the type declaration shape changed; update the regex in this test"
    )
    values = set(_TS_LITERAL_RE.findall(match.group(1)))
    assert values, "extracted zero DetectionClass values — extraction regex is broken"
    return values


def test_backend_detection_class_matches_frontend_detection_class():
    backend_classes = set(get_args(DetectionClass))
    frontend_classes = _extract_frontend_detection_classes()

    assert backend_classes == frontend_classes, (
        f"schema drift: backend DetectionClass={sorted(backend_classes)} != "
        f"frontend DetectionClass={sorted(frontend_classes)} "
        "(apps/backend/app/schemas.py vs "
        "apps/frontend/src/features/sandbox/engine/detections.ts)"
    )


def test_extraction_regex_is_sound_against_a_synthetic_fixture():
    """Proves the regex itself would catch a real drift — without this, a broken
    regex that always returns the backend's own values would make the parity test
    above vacuously pass no matter what the frontend actually says."""
    fixture = (
        "export type DetectionClass =\n"
        "  | 'one_thing'\n"
        "  | 'another_thing'\n"
        "  | 'third_thing';\n"
    )
    match = _TS_UNION_RE.search(fixture)
    assert match is not None
    values = set(_TS_LITERAL_RE.findall(match.group(1)))
    assert values == {"one_thing", "another_thing", "third_thing"}
