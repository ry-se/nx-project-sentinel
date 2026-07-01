from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict

# Provider -> which env var carries its API key (.claude/rules/env-models.md).
_PROVIDER_KEY_ENV = {
    "openai": "OPENAI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "google": "GOOGLE_API_KEY",
}


class Settings(BaseSettings):
    """Backend configuration — every value sourced from the environment, never hardcoded."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    detector_provider: str = "stub"
    detector_model: str = ""
    cors_allowed_origins: str = "http://localhost:4200"

    openai_api_key: str | None = None
    anthropic_api_key: str | None = None
    google_api_key: str | None = None

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
    def detector_api_key(self) -> str | None:
        env_field = _PROVIDER_KEY_ENV.get(self.detector_provider)
        if env_field is None:
            return None
        return getattr(self, env_field.lower(), None)


@lru_cache
def get_settings() -> Settings:
    return Settings()
