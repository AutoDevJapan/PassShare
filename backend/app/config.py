"""Application configuration."""


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

    # Database (PostgreSQL - Railway)
    db_host: str = "localhost"
    db_port: int = 5432
    db_user: str = "passshare"
    db_password: str = "password"
    db_name: str = "passshare_db"
    database_url: str = ""

    @property
    def get_database_url(self) -> str:
        """Get the database URL.

        Railway provides DATABASE_URL directly.
        """
        if self.database_url:
            # Railway format: postgresql://user:pass@host:port/db
            # Convert to asyncpg format if needed
            url = self.database_url
            if url.startswith("postgresql://"):
                url = url.replace("postgresql://", "postgresql+asyncpg://", 1)
            elif url.startswith("postgres://"):
                url = url.replace("postgres://", "postgresql+asyncpg://", 1)
            return url
        return f"postgresql+asyncpg://{self.db_user}:{self.db_password}@{self.db_host}:{self.db_port}/{self.db_name}"

    # CORS (Vercel frontend URLs)
    cors_origins: list[str] = [
        "http://localhost:5173",
        "http://localhost:3000",
        "https://pass-share.bm1314.net",
        "https://*.vercel.app",
        # Capacitor
        "capacitor://localhost",
        "http://localhost",
    ]

    # GitHub API (for release info)
    github_token: str = ""
    github_repo: str = "bm1314/passshare"

    # PyPI package names
    pypi_package: str = "passshare"

    # npm package names
    npm_package_cli: str = "passshare"
    npm_package_core: str = "@passshare/core"

    # Downloads (Cloudflare R2)
    downloads_base_url: str = "https://downloads.pass-share.bm1314.net"


settings = Settings()
