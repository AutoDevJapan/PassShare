"""API v1 routes."""

from fastapi import APIRouter

from app.presentation.api.v1.auth import router as auth_router
from app.presentation.api.v1.docs import router as docs_router
from app.presentation.api.v1.downloads import router as downloads_router
from app.presentation.api.v1.enterprise import router as enterprise_router
from app.presentation.api.v1.releases import router as releases_router
from app.presentation.api.v1.secrets import router as secrets_router
from app.presentation.api.v1.sync import router as sync_router

router = APIRouter()

router.include_router(auth_router, prefix="/auth", tags=["auth"])
router.include_router(secrets_router, prefix="/secrets", tags=["secrets"])
router.include_router(releases_router, prefix="/releases", tags=["releases"])
router.include_router(downloads_router, prefix="/downloads", tags=["downloads"])
router.include_router(docs_router, prefix="/docs", tags=["docs"])
router.include_router(enterprise_router)
router.include_router(sync_router)
