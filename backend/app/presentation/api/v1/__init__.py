"""API v1 routes."""

from fastapi import APIRouter

from app.presentation.api.v1.releases import router as releases_router
from app.presentation.api.v1.downloads import router as downloads_router
from app.presentation.api.v1.docs import router as docs_router

router = APIRouter()

router.include_router(releases_router, prefix="/releases", tags=["releases"])
router.include_router(downloads_router, prefix="/downloads", tags=["downloads"])
router.include_router(docs_router, prefix="/docs", tags=["docs"])
