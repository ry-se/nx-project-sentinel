import structlog

from app.schemas import DetectionClass

logger = structlog.get_logger(__name__)

# Generic VLM-emitted label -> Sentinel's locked DetectionClass. Zero-shot military-class
# precision (AFV vs LMV) is approximate until a military-trained model is swapped in
# (measured in W6's eval harness) — this table is deliberately generous on synonyms.
_CLASS_MAP: dict[str, DetectionClass] = {
    # armored_fighting_vehicle
    "afv": "armored_fighting_vehicle",
    "armored fighting vehicle": "armored_fighting_vehicle",
    "armoured fighting vehicle": "armored_fighting_vehicle",
    "tank": "armored_fighting_vehicle",
    "main battle tank": "armored_fighting_vehicle",
    "ifv": "armored_fighting_vehicle",
    "infantry fighting vehicle": "armored_fighting_vehicle",
    "apc": "armored_fighting_vehicle",
    "armored personnel carrier": "armored_fighting_vehicle",
    "armored vehicle": "armored_fighting_vehicle",
    "armoured vehicle": "armored_fighting_vehicle",
    "self-propelled artillery": "armored_fighting_vehicle",
    # light_military_vehicle
    "lmv": "light_military_vehicle",
    "light military vehicle": "light_military_vehicle",
    "technical": "light_military_vehicle",
    "jeep": "light_military_vehicle",
    "humvee": "light_military_vehicle",
    "truck": "light_military_vehicle",
    "military truck": "light_military_vehicle",
    "car": "light_military_vehicle",
    "light vehicle": "light_military_vehicle",
    "utility vehicle": "light_military_vehicle",
    # aircraft
    "aircraft": "aircraft",
    "plane": "aircraft",
    "airplane": "aircraft",
    "jet": "aircraft",
    "fighter jet": "aircraft",
    "helicopter": "aircraft",
    "chopper": "aircraft",
    "drone": "aircraft",
    "uav": "aircraft",
}


def map_class(raw_label: str) -> DetectionClass | None:
    """Maps a generic model-emitted label to Sentinel's DetectionClass. Unmappable
    labels are dropped (return None) with a logged reason — never silently coerced
    to a default class (.claude/rules/zero-tolerance.md Rule 3)."""
    normalized = raw_label.strip().lower()
    mapped = _CLASS_MAP.get(normalized)
    if mapped is None:
        logger.warning("class_map.unmappable_label", raw_label=raw_label)
    return mapped
