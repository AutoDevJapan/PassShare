"""Secrets API endpoints."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.domain.models import User
from app.domain.schemas import (
    AuditResponse,
    ConfigResponse,
    ConfigUpdate,
    GeneratePasswordRequest,
    GeneratePasswordResponse,
    HistoryEntry,
    MountCreate,
    MountResponse,
    RecipientAdd,
    RecipientResponse,
    SearchRequest,
    SearchResponse,
    SecretCreate,
    SecretDetailResponse,
    SecretListResponse,
    SecretUpdate,
    StandalonePasswordRequest,
    StandalonePasswordResponse,
    SyncRequest,
    SyncResponse,
)
from app.domain.services.password_service import PasswordService
from app.presentation.api.v1.auth import get_current_user

router = APIRouter()


def get_password_service(
    current_user: Annotated[User, Depends(get_current_user)],
) -> PasswordService:
    """Get password service for current user."""
    return PasswordService(current_user)


# =============================================================================
# Secret CRUD
# =============================================================================


@router.get("", response_model=SecretListResponse)
async def list_secrets(
    prefix: str = Query("", description="Filter by prefix"),
    password_service: PasswordService = Depends(get_password_service),
) -> SecretListResponse:
    """List all secrets."""
    secrets = password_service.list_secrets(prefix)
    return SecretListResponse(secrets=secrets, total=len(secrets))


@router.get("/{name:path}", response_model=SecretDetailResponse)
async def get_secret(
    name: str,
    password_service: PasswordService = Depends(get_password_service),
) -> SecretDetailResponse:
    """Get a secret by name."""
    try:
        return password_service.get_secret(name)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e)) from e


@router.post("", response_model=SecretDetailResponse, status_code=status.HTTP_201_CREATED)
async def create_secret(
    data: SecretCreate,
    password_service: PasswordService = Depends(get_password_service),
) -> SecretDetailResponse:
    """Create a new secret."""
    try:
        return password_service.create_secret(data)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e)) from e


@router.put("/{name:path}", response_model=SecretDetailResponse)
async def update_secret(
    name: str,
    data: SecretUpdate,
    password_service: PasswordService = Depends(get_password_service),
) -> SecretDetailResponse:
    """Update an existing secret."""
    try:
        return password_service.update_secret(name, data)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e)) from e


@router.delete("/{name:path}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_secret(
    name: str,
    password_service: PasswordService = Depends(get_password_service),
) -> None:
    """Delete a secret."""
    try:
        password_service.delete_secret(name)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e)) from e


# =============================================================================
# Password Generation
# =============================================================================


@router.post("/generate", response_model=GeneratePasswordResponse)
async def generate_password(
    request: GeneratePasswordRequest,
    password_service: PasswordService = Depends(get_password_service),
) -> GeneratePasswordResponse:
    """Generate and save a password."""
    try:
        name, password = password_service.generate_password(request)
        return GeneratePasswordResponse(name=name, password=password)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e)) from e


@router.post("/pwgen", response_model=StandalonePasswordResponse)
async def generate_standalone_password(
    request: StandalonePasswordRequest,
    password_service: PasswordService = Depends(get_password_service),
) -> StandalonePasswordResponse:
    """Generate passwords without saving."""
    passwords = password_service.generate_standalone(
        length=request.length,
        symbols=request.symbols,
        xkcd=request.xkcd,
        count=request.count,
    )
    return StandalonePasswordResponse(passwords=passwords)


# =============================================================================
# Search
# =============================================================================


@router.post("/search", response_model=SearchResponse)
async def search_secrets(
    request: SearchRequest,
    password_service: PasswordService = Depends(get_password_service),
) -> SearchResponse:
    """Search secrets."""
    if request.search_content:
        results = password_service.grep(request.query)
        matches = [f"{name}: {line}" for name, line in results]
    else:
        matches = password_service.search(request.query)

    return SearchResponse(matches=matches, total=len(matches))


# =============================================================================
# Copy / Move
# =============================================================================


@router.post("/copy")
async def copy_secret(
    from_name: str,
    to_name: str,
    force: bool = False,
    password_service: PasswordService = Depends(get_password_service),
) -> dict[str, str]:
    """Copy a secret."""
    try:
        password_service.copy_secret(from_name, to_name, force)
        return {"message": f"Copied {from_name} to {to_name}"}
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e)) from e


@router.post("/move")
async def move_secret(
    from_name: str,
    to_name: str,
    force: bool = False,
    password_service: PasswordService = Depends(get_password_service),
) -> dict[str, str]:
    """Move a secret."""
    try:
        password_service.move_secret(from_name, to_name, force)
        return {"message": f"Moved {from_name} to {to_name}"}
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e)) from e


# =============================================================================
# Sync
# =============================================================================


@router.post("/sync", response_model=SyncResponse)
async def sync_store(
    request: SyncRequest,
    password_service: PasswordService = Depends(get_password_service),
) -> SyncResponse:
    """Sync with remote."""
    try:
        password_service.sync(request.store)
        return SyncResponse(success=True, message="Sync complete")
    except Exception as e:
        return SyncResponse(success=False, message=str(e))


# =============================================================================
# OTP
# =============================================================================


@router.get("/{name:path}/otp")
async def get_otp(
    name: str,
    password_service: PasswordService = Depends(get_password_service),
) -> dict[str, str | None]:
    """Get OTP code for a secret."""
    otp = password_service.get_otp(name)
    if not otp:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No OTP configured for {name}",
        )
    return {"otp": otp}


# =============================================================================
# History
# =============================================================================


@router.get("/{name:path}/history", response_model=list[HistoryEntry])
async def get_history(
    name: str,
    count: int = Query(10, ge=1, le=100),
    password_service: PasswordService = Depends(get_password_service),
) -> list[HistoryEntry]:
    """Get secret history."""
    return password_service.get_history(name, count)


# =============================================================================
# Audit
# =============================================================================


@router.get("/audit", response_model=AuditResponse)
async def audit_passwords(
    folder: str = Query("", description="Folder to audit"),
    password_service: PasswordService = Depends(get_password_service),
) -> AuditResponse:
    """Audit password strength."""
    return password_service.audit(folder or None)


# =============================================================================
# Config
# =============================================================================


@router.get("/config", response_model=ConfigResponse)
async def get_config(
    password_service: PasswordService = Depends(get_password_service),
) -> ConfigResponse:
    """Get configuration."""
    return password_service.get_config()


@router.put("/config", response_model=ConfigResponse)
async def update_config(
    config: ConfigUpdate,
    password_service: PasswordService = Depends(get_password_service),
) -> ConfigResponse:
    """Update configuration."""
    return password_service.update_config(
        autoclip=config.autoclip,
        cliptimeout=config.cliptimeout,
        autosync=config.autosync,
        autopush=config.autopush,
    )


# =============================================================================
# Mounts
# =============================================================================


@router.get("/mounts", response_model=list[MountResponse])
async def get_mounts(
    password_service: PasswordService = Depends(get_password_service),
) -> list[MountResponse]:
    """Get mount points."""
    mounts = password_service.get_mounts()
    return [MountResponse(alias=alias, path=path) for alias, path in mounts.items()]


@router.post("/mounts", response_model=MountResponse, status_code=status.HTTP_201_CREATED)
async def add_mount(
    data: MountCreate,
    password_service: PasswordService = Depends(get_password_service),
) -> MountResponse:
    """Add a mount point."""
    password_service.add_mount(data.alias, data.path)
    return MountResponse(alias=data.alias, path=data.path)


@router.delete("/mounts/{alias}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_mount(
    alias: str,
    password_service: PasswordService = Depends(get_password_service),
) -> None:
    """Remove a mount point."""
    password_service.remove_mount(alias)


# =============================================================================
# Recipients
# =============================================================================


@router.get("/recipients", response_model=list[RecipientResponse])
async def get_recipients(
    store: str = Query(None, description="Store name"),
    password_service: PasswordService = Depends(get_password_service),
) -> list[RecipientResponse]:
    """Get recipients."""
    recipients = password_service.get_recipients(store)
    return [RecipientResponse(key_id=r) for r in recipients]


@router.post("/recipients", status_code=status.HTTP_201_CREATED)
async def add_recipient(
    data: RecipientAdd,
    password_service: PasswordService = Depends(get_password_service),
) -> dict[str, str]:
    """Add a recipient."""
    password_service.add_recipient(data.key_id, data.store)
    return {"message": f"Added recipient {data.key_id}"}


@router.delete("/recipients/{key_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_recipient(
    key_id: str,
    store: str = Query(None, description="Store name"),
    password_service: PasswordService = Depends(get_password_service),
) -> None:
    """Remove a recipient."""
    password_service.remove_recipient(key_id, store)
