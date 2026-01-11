"""Release information endpoints."""

from typing import List, Optional

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.config import settings

router = APIRouter()


class ReleaseAsset(BaseModel):
    """Release asset model."""

    name: str
    browser_download_url: str
    size: int
    download_count: int


class Release(BaseModel):
    """Release model."""

    tag_name: str
    name: str
    published_at: str
    html_url: str
    body: Optional[str] = None
    assets: List[ReleaseAsset] = []


class LatestVersions(BaseModel):
    """Latest versions for all platforms."""

    python: str
    typescript: str
    nodejs: str


@router.get("/latest", response_model=Release)
async def get_latest_release() -> Release:
    """Get the latest release from GitHub."""
    try:
        async with httpx.AsyncClient() as client:
            headers = {}
            if settings.github_token:
                headers["Authorization"] = f"token {settings.github_token}"

            response = await client.get(
                f"https://api.github.com/repos/{settings.github_repo}/releases/latest",
                headers=headers,
                timeout=10.0,
            )

            if response.status_code == 404:
                # No releases yet, return mock data
                return Release(
                    tag_name="v1.0.0",
                    name="PassShare v1.0.0",
                    published_at="2026-01-11T00:00:00Z",
                    html_url=f"https://github.com/{settings.github_repo}",
                    body="Initial release",
                    assets=[],
                )

            response.raise_for_status()
            data = response.json()

            return Release(
                tag_name=data["tag_name"],
                name=data["name"],
                published_at=data["published_at"],
                html_url=data["html_url"],
                body=data.get("body"),
                assets=[
                    ReleaseAsset(
                        name=asset["name"],
                        browser_download_url=asset["browser_download_url"],
                        size=asset["size"],
                        download_count=asset["download_count"],
                    )
                    for asset in data.get("assets", [])
                ],
            )

    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Failed to fetch release: {e}")


@router.get("/versions", response_model=LatestVersions)
async def get_latest_versions() -> LatestVersions:
    """Get the latest versions from package registries."""
    python_version = "1.0.0"
    ts_version = "1.0.0"
    node_version = "1.0.0"

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
                    python_version = data["info"]["version"]
            except Exception:
                pass

            # npm (CLI)
            try:
                response = await client.get(
                    f"https://registry.npmjs.org/{settings.npm_package_cli}/latest",
                    timeout=5.0,
                )
                if response.status_code == 200:
                    data = response.json()
                    node_version = data["version"]
            except Exception:
                pass

            # npm (Core)
            try:
                response = await client.get(
                    f"https://registry.npmjs.org/{settings.npm_package_core}/latest",
                    timeout=5.0,
                )
                if response.status_code == 200:
                    data = response.json()
                    ts_version = data["version"]
            except Exception:
                pass

    except Exception:
        pass

    return LatestVersions(
        python=python_version,
        typescript=ts_version,
        nodejs=node_version,
    )


@router.get("/", response_model=List[Release])
async def get_releases(limit: int = 10) -> List[Release]:
    """Get recent releases from GitHub."""
    try:
        async with httpx.AsyncClient() as client:
            headers = {}
            if settings.github_token:
                headers["Authorization"] = f"token {settings.github_token}"

            response = await client.get(
                f"https://api.github.com/repos/{settings.github_repo}/releases",
                headers=headers,
                params={"per_page": limit},
                timeout=10.0,
            )

            if response.status_code == 404:
                return []

            response.raise_for_status()
            data = response.json()

            return [
                Release(
                    tag_name=release["tag_name"],
                    name=release["name"],
                    published_at=release["published_at"],
                    html_url=release["html_url"],
                    body=release.get("body"),
                    assets=[
                        ReleaseAsset(
                            name=asset["name"],
                            browser_download_url=asset["browser_download_url"],
                            size=asset["size"],
                            download_count=asset["download_count"],
                        )
                        for asset in release.get("assets", [])
                    ],
                )
                for release in data
            ]

    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Failed to fetch releases: {e}")
