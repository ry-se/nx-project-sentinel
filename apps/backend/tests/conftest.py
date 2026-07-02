import pytest
from fastapi.testclient import TestClient

from app.config import Settings, get_settings
from app.main import app


@pytest.fixture
def stub_client():
    """TestClient wired to the deterministic StubDetector — endpoint-contract tests
    should not depend on a real (network/local-model) detector provider being reachable."""
    app.dependency_overrides[get_settings] = lambda: Settings(detector_provider="stub")
    with TestClient(app) as client:
        yield client
    app.dependency_overrides.pop(get_settings, None)
