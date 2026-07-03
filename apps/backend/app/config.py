from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict

# Sensible per-provider defaults so DETECTOR_PROVIDER=vlm-local works with zero other
# config — Qwen2.5-VL-class model served locally via Ollama's OpenAI-compatible API
# (see workspaces/sentinel/01-analysis/03-product-strategy/05-detector-orientation-research.md).
_DEFAULT_MODEL_BY_PROVIDER = {"vlm-local": "qwen2.5vl:3b", "vlm-api": ""}
_DEFAULT_BASE_URL_BY_PROVIDER = {"vlm-local": "http://localhost:11434/v1", "vlm-api": ""}


class Settings(BaseSettings):
    """Backend configuration — every value sourced from the environment, never hardcoded."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    detector_provider: Literal["vlm-local", "vlm-api", "stub"] = "vlm-local"
    detector_model: str = ""
    detector_base_url: str = ""
    detector_api_key: str | None = None
    # Reasoning-model effort level ("low"/"medium"/"high") — empty (default) means the
    # configured model isn't a reasoning model; unset skips both this param AND
    # temperature=0.0 in the same request (reasoning models reject an explicit
    # temperature — see vision_adapter.py::_call_provider).
    detector_reasoning_effort: str = ""
    # Some models reject an explicit temperature regardless of reasoning_effort — verified
    # live against gpt-5.5 with reasoning_effort unset. Decoupled from
    # detector_reasoning_effort on purpose: don't guess this from a model-name pattern.
    detector_omit_temperature: bool = False
    # Splits the capture into overlapping tiles before detection — the fix for the
    # imprecise/inconsistent full-image coordinates traced in
    # workspaces/sentinel/journal/0008-0011. Defaults ON (it's the shipped fix); env-gated
    # so the untiled single-shot path stays available for comparison/debugging (todo 03b
    # invariant 2) without a code change.
    detector_tiling_enabled: bool = True
    cors_allowed_origins: str = "http://localhost:4200"

    @property
    def cors_origins(self) -> list[str]:
        origins = [origin.strip() for origin in self.cors_allowed_origins.split(",") if origin.strip()]
        if "*" in origins:
            # main.py always sets allow_credentials=True — a wildcard origin combined
            # with credentials lets any site read authenticated responses. Fail closed.
            raise ValueError(
                "CORS_ALLOWED_ORIGINS may not contain '*' — allow_credentials=True requires "
                "an explicit origin list"
            )
        return origins

    @property
    def resolved_detector_model(self) -> str:
        return self.detector_model or _DEFAULT_MODEL_BY_PROVIDER.get(self.detector_provider, "")

    @property
    def resolved_detector_base_url(self) -> str:
        return self.detector_base_url or _DEFAULT_BASE_URL_BY_PROVIDER.get(self.detector_provider, "")


@lru_cache
def get_settings() -> Settings:
    return Settings()
