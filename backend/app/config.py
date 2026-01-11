"""Application configuration."""

from typing import List

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
    )

    # Application
    debug: bool = False
    secret_key: str = "your-secret-key-change-in-production"

    # CORS
    cors_origins: List[str] = [
        "http://localhost:5173",
        "http://localhost:3000",
        "https://passshare.dev",
    ]

    # GitHub API (for release info)
    github_token: str = ""
    github_repo: str = "bm1314/passshare"

    # PyPI package names
    pypi_package: str = "passshare"

    # npm package names
    npm_package_cli: str = "passshare"
    npm_package_core: str = "@passshare/core"


settings = Settings()
