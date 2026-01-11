"""Download statistics endpoints."""

import hashlib

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import RedirectResponse
from pydantic import BaseModel

from app.config import settings
from app.domain.models import DownloadEvent
from app.infrastructure.database import async_session_factory

router = APIRouter()


# 利用可能なダウンロード
AVAILABLE_DOWNLOADS = {
    # デスクトップ
    "desktop/windows": {
        "filename": "PassShare-Setup.exe",
        "platform": "windows",
        "version": "1.0.0",
    },
    "desktop/macos": {
        "filename": "PassShare.dmg",
        "platform": "macos",
        "version": "1.0.0",
    },
    "desktop/linux": {
        "filename": "PassShare.AppImage",
        "platform": "linux",
        "version": "1.0.0",
    },
    # ブラウザ拡張
    "extension/chrome": {
        "filename": "passshare-chrome.zip",
        "platform": "chrome",
        "version": "1.0.0",
    },
    "extension/firefox": {
        "filename": "passshare-firefox.xpi",
        "platform": "firefox",
        "version": "1.0.0",
    },
    # モバイル（直接ダウンロードではなくストアへリダイレクト）
    "mobile/ios": {
        "redirect": "https://apps.apple.com/app/passshare",
        "platform": "ios",
    },
    "mobile/android": {
        "redirect": "https://play.google.com/store/apps/details?id=net.bm1314.passshare",
        "platform": "android",
    },
}


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


class DownloadInfo(BaseModel):
    """Download information."""

    platform: str
    filename: str | None = None
    version: str | None = None
    url: str


class DownloadListResponse(BaseModel):
    """List of available downloads."""

    desktop: list[DownloadInfo]
    extension: list[DownloadInfo]
    mobile: list[DownloadInfo]


@router.get("/list", response_model=DownloadListResponse)
async def list_downloads() -> DownloadListResponse:
    """List all available downloads."""
    desktop = []
    extension = []
    mobile = []

    for key, info in AVAILABLE_DOWNLOADS.items():
        category = key.split("/")[0]
        dl_info = DownloadInfo(
            platform=info["platform"],
            filename=info.get("filename"),
            version=info.get("version"),
            url=f"/api/v1/downloads/{key}",
        )

        if category == "desktop":
            desktop.append(dl_info)
        elif category == "extension":
            extension.append(dl_info)
        elif category == "mobile":
            mobile.append(dl_info)

    return DownloadListResponse(desktop=desktop, extension=extension, mobile=mobile)


@router.get("/{category}/{platform}")
async def download_file(category: str, platform: str, request: Request) -> RedirectResponse:
    """Download a file and record statistics."""
    key = f"{category}/{platform}"

    if key not in AVAILABLE_DOWNLOADS:
        from fastapi import HTTPException

        raise HTTPException(status_code=404, detail="Download not found")

    info = AVAILABLE_DOWNLOADS[key]

    # ダウンロード統計を記録
    try:
        # IPアドレスをハッシュ化（プライバシー保護）
        client_ip = request.client.host if request.client else "unknown"
        ip_hash = hashlib.sha256(client_ip.encode()).hexdigest()[:16]

        async with async_session_factory() as session:
            event = DownloadEvent(
                package=f"passshare-{category}",
                version=info.get("version", "1.0.0"),
                platform=info["platform"],
                ip_hash=ip_hash,
                user_agent=request.headers.get("user-agent"),
            )
            session.add(event)
            await session.commit()
    except Exception:
        pass  # 統計記録失敗しても続行

    # リダイレクト先を決定
    if "redirect" in info:
        # モバイルはストアへ直接リダイレクト
        return RedirectResponse(url=info["redirect"], status_code=302)
    else:
        # R2からファイルをダウンロード
        file_url = f"{settings.downloads_base_url}/{info['version']}/{info['filename']}"
        return RedirectResponse(url=file_url, status_code=302)


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


@router.get("/packages", response_model=dict[str, PackageInfo])
async def get_package_info() -> dict[str, PackageInfo]:
    """Get package information from registries."""
    packages: dict[str, PackageInfo] = {}

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
                    homepage="https://pass-share.bm1314.net",
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
                    homepage="https://pass-share.bm1314.net",
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
                    homepage="https://pass-share.bm1314.net",
                )

    except Exception:
        pass

    return packages
