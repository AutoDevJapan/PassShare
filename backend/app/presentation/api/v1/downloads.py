"""Download statistics endpoints."""

from typing import Dict

import httpx
from fastapi import APIRouter
from pydantic import BaseModel

from app.config import settings

router = APIRouter()


class DownloadStats(BaseModel):
    """Download statistics model."""

    python_total: int
    npm_weekly: int
    github_total: int


class PackageInfo(BaseModel):
    """Package information model."""

    name: str
    version: str
    downloads: int
    description: str
    homepage: str


@router.get("/stats", response_model=DownloadStats)
async def get_download_stats() -> DownloadStats:
    """Get download statistics from package registries."""
    python_total = 0
    npm_weekly = 0
    github_total = 0

    try:
        async with httpx.AsyncClient() as client:
            # PyPI downloads (using pypistats API)
            try:
                response = await client.get(
                    f"https://pypistats.org/api/packages/{settings.pypi_package}/overall",
                    timeout=5.0,
                )
                if response.status_code == 200:
                    data = response.json()
                    python_total = sum(item["downloads"] for item in data.get("data", []))
            except Exception:
                pass

            # npm downloads
            try:
                response = await client.get(
                    f"https://api.npmjs.org/downloads/point/last-week/{settings.npm_package_cli}",
                    timeout=5.0,
                )
                if response.status_code == 200:
                    data = response.json()
                    npm_weekly = data.get("downloads", 0)
            except Exception:
                pass

            # GitHub release downloads
            try:
                headers = {}
                if settings.github_token:
                    headers["Authorization"] = f"token {settings.github_token}"

                response = await client.get(
                    f"https://api.github.com/repos/{settings.github_repo}/releases",
                    headers=headers,
                    timeout=5.0,
                )
                if response.status_code == 200:
                    data = response.json()
                    for release in data:
                        for asset in release.get("assets", []):
                            github_total += asset.get("download_count", 0)
            except Exception:
                pass

    except Exception:
        pass

    return DownloadStats(
        python_total=python_total,
        npm_weekly=npm_weekly,
        github_total=github_total,
    )


@router.get("/packages", response_model=Dict[str, PackageInfo])
async def get_package_info() -> Dict[str, PackageInfo]:
    """Get package information from registries."""
    packages: Dict[str, PackageInfo] = {}

    try:
        async with httpx.AsyncClient() as client:
            # PyPI
            try:
                response = await client.get(
                    f"https://pypi.org/pypi/{settings.pypi_package}/json",
                    timeout=5.0,
                )
                if response.status_code == 200:
                    data = response.json()
                    info = data["info"]
                    packages["python"] = PackageInfo(
                        name=info["name"],
                        version=info["version"],
                        downloads=0,  # PyPI doesn't provide this directly
                        description=info.get("summary", ""),
                        homepage=info.get("home_page", ""),
                    )
            except Exception:
                packages["python"] = PackageInfo(
                    name=settings.pypi_package,
                    version="1.0.0",
                    downloads=0,
                    description="A gopass-compatible password manager",
                    homepage="https://passshare.dev",
                )

            # npm CLI
            try:
                response = await client.get(
                    f"https://registry.npmjs.org/{settings.npm_package_cli}",
                    timeout=5.0,
                )
                if response.status_code == 200:
                    data = response.json()
                    latest = data.get("dist-tags", {}).get("latest", "1.0.0")
                    version_data = data.get("versions", {}).get(latest, {})
                    packages["nodejs"] = PackageInfo(
                        name=data["name"],
                        version=latest,
                        downloads=0,
                        description=version_data.get("description", ""),
                        homepage=version_data.get("homepage", ""),
                    )
            except Exception:
                packages["nodejs"] = PackageInfo(
                    name=settings.npm_package_cli,
                    version="1.0.0",
                    downloads=0,
                    description="A gopass-compatible password manager CLI",
                    homepage="https://passshare.dev",
                )

            # npm Core
            try:
                response = await client.get(
                    f"https://registry.npmjs.org/{settings.npm_package_core}",
                    timeout=5.0,
                )
                if response.status_code == 200:
                    data = response.json()
                    latest = data.get("dist-tags", {}).get("latest", "1.0.0")
                    version_data = data.get("versions", {}).get(latest, {})
                    packages["typescript"] = PackageInfo(
                        name=data["name"],
                        version=latest,
                        downloads=0,
                        description=version_data.get("description", ""),
                        homepage=version_data.get("homepage", ""),
                    )
            except Exception:
                packages["typescript"] = PackageInfo(
                    name=settings.npm_package_core,
                    version="1.0.0",
                    downloads=0,
                    description="A gopass-compatible password manager library",
                    homepage="https://passshare.dev",
                )

    except Exception:
        pass

    return packages
