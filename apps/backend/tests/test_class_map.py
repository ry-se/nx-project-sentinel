from app.detector.class_map import map_class


def test_maps_known_afv_synonyms():
    assert map_class("tank") == "armored_fighting_vehicle"
    assert map_class("IFV") == "armored_fighting_vehicle"
    assert map_class("Armored Fighting Vehicle") == "armored_fighting_vehicle"


def test_maps_known_lmv_synonyms():
    assert map_class("technical") == "light_military_vehicle"
    assert map_class("truck") == "light_military_vehicle"


def test_maps_known_aircraft_synonyms():
    assert map_class("drone") == "aircraft"
    assert map_class("Helicopter") == "aircraft"


def test_case_and_whitespace_insensitive():
    assert map_class("  TANK  ") == "armored_fighting_vehicle"


def test_unmappable_label_returns_none_not_coerced():
    assert map_class("submarine") is None
    assert map_class("") is None
    assert map_class("banana") is None
