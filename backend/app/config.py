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

    # Database (PostgreSQL)
    db_host: str = "localhost"
    db_port: int = 5432
    db_user: str = "passshare"
    db_password: str = "password"
    db_name: str = "passshare_db"
    database_url: str = ""

    @property
    def get_database_url(self) -> str:
        """Get the database URL."""
        if self.database_url:
            return self.database_url
        return f"postgresql+asyncpg://{self.db_user}:{self.db_password}@{self.db_host}:{self.db_port}/{self.db_name}"

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
