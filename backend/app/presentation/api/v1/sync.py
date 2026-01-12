"""Cloud Sync API endpoints (E2E encrypted).

All data is encrypted on the client side before being sent to the server.
The server never has access to unencrypted secrets.

© 2026 株式会社BM1314. All rights reserved.
"""

from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, and_
from sqlalchemy.ext.asyncio import AsyncSession

from app.infrastructure.database import get_db
from app.domain.models import CloudVault, CloudSecret, SyncState, SyncConflict

router = APIRouter(prefix="/sync", tags=["sync"])


# === Schemas ===


class CreateVaultRequest(BaseModel):
    """Create cloud vault request."""

    name: str
    encrypted_key: str
    key_derivation_salt: str
    key_derivation_iterations: int = 100000


class VaultResponse(BaseModel):
    """Vault response."""

    id: int
    name: str
    encrypted_key: str
    key_derivation_salt: str
    key_derivation_iterations: int
    version: int
    updated_at: datetime | None


class SecretChange(BaseModel):
    """A single secret change."""

    name_hash: str
    encrypted_name: str
    encrypted_content: str
    version: int
    is_deleted: bool = False


class PushChangesRequest(BaseModel):
    """Push changes request."""

    device_id: str
    base_version: int
    changes: list[SecretChange]


class PullChangesResponse(BaseModel):
    """Pull changes response."""

    current_version: int
    changes: list[SecretChange]
    has_more: bool


class ConflictResponse(BaseModel):
    """Conflict response."""

    id: int
    secret_id: int
    local_version: int
    remote_version: int
    local_content: str
    remote_content: str


class ResolveConflictRequest(BaseModel):
    """Resolve conflict request."""

    resolution: str  # local, remote, merge
    merged_content: str | None = None


# === Vault Endpoints ===


@router.get("/vaults", response_model=list[VaultResponse])
async def list_vaults(
    user_id: int,  # In production, get from JWT
    db: Annotated[AsyncSession, Depends(get_db)],
) -> list[VaultResponse]:
    """List user's cloud vaults."""
    query = select(CloudVault).where(CloudVault.user_id == user_id)
    result = await db.execute(query)
    vaults = result.scalars().all()

    return [
        VaultResponse(
            id=v.id,
            name=v.name,
            encrypted_key=v.encrypted_key,
            key_derivation_salt=v.key_derivation_salt,
            key_derivation_iterations=v.key_derivation_iterations,
            version=v.version,
            updated_at=v.updated_at,
        )
        for v in vaults
    ]


@router.post("/vaults", response_model=VaultResponse)
async def create_vault(
    user_id: int,  # In production, get from JWT
    body: CreateVaultRequest,
    db: Annotated[AsyncSession, Depends(get_db)],
) -> VaultResponse:
    """Create a new cloud vault."""
    vault = CloudVault(
        user_id=user_id,
        name=body.name,
        encrypted_key=body.encrypted_key,
        key_derivation_salt=body.key_derivation_salt,
        key_derivation_iterations=body.key_derivation_iterations,
    )

    db.add(vault)
    await db.commit()
    await db.refresh(vault)

    return VaultResponse(
        id=vault.id,
        name=vault.name,
        encrypted_key=vault.encrypted_key,
        key_derivation_salt=vault.key_derivation_salt,
        key_derivation_iterations=vault.key_derivation_iterations,
        version=vault.version,
        updated_at=vault.updated_at,
    )


@router.get("/vaults/{vault_id}", response_model=VaultResponse)
async def get_vault(
    vault_id: int,
    user_id: int,  # In production, get from JWT
    db: Annotated[AsyncSession, Depends(get_db)],
) -> VaultResponse:
    """Get a specific vault."""
    query = select(CloudVault).where(
        CloudVault.id == vault_id,
        CloudVault.user_id == user_id,
    )
    result = await db.execute(query)
    vault = result.scalar_one_or_none()

    if not vault:
        raise HTTPException(status_code=404, detail="Vault not found")

    return VaultResponse(
        id=vault.id,
        name=vault.name,
        encrypted_key=vault.encrypted_key,
        key_derivation_salt=vault.key_derivation_salt,
        key_derivation_iterations=vault.key_derivation_iterations,
        version=vault.version,
        updated_at=vault.updated_at,
    )


# === Sync Endpoints ===


@router.post("/vaults/{vault_id}/push")
async def push_changes(
    vault_id: int,
    user_id: int,  # In production, get from JWT
    body: PushChangesRequest,
    db: Annotated[AsyncSession, Depends(get_db)],
) -> dict[str, int | bool | list[ConflictResponse]]:
    """Push local changes to cloud.

    Uses optimistic locking - if base_version doesn't match,
    returns conflicts for resolution.
    """
    # Verify vault ownership
    vault_query = select(CloudVault).where(
        CloudVault.id == vault_id,
        CloudVault.user_id == user_id,
    )
    result = await db.execute(vault_query)
    vault = result.scalar_one_or_none()

    if not vault:
        raise HTTPException(status_code=404, detail="Vault not found")

    # Check for version conflicts
    if body.base_version != vault.version:
        # Detect conflicts
        conflicts: list[ConflictResponse] = []

        for change in body.changes:
            # Check if secret was modified since base_version
            secret_query = select(CloudSecret).where(
                CloudSecret.vault_id == vault_id,
                CloudSecret.name_hash == change.name_hash,
                CloudSecret.version > body.base_version,
            )
            result = await db.execute(secret_query)
            remote_secret = result.scalar_one_or_none()

            if remote_secret:
                # Create conflict record
                conflict = SyncConflict(
                    vault_id=vault_id,
                    secret_id=remote_secret.id,
                    local_version=change.version,
                    remote_version=remote_secret.version,
                    local_content=change.encrypted_content,
                    remote_content=remote_secret.encrypted_content,
                )
                db.add(conflict)
                await db.flush()

                conflicts.append(
                    ConflictResponse(
                        id=conflict.id,
                        secret_id=remote_secret.id,
                        local_version=change.version,
                        remote_version=remote_secret.version,
                        local_content=change.encrypted_content,
                        remote_content=remote_secret.encrypted_content,
                    )
                )

        if conflicts:
            await db.commit()
            return {
                "success": False,
                "current_version": vault.version,
                "conflicts": conflicts,
            }

    # Apply changes
    new_version = vault.version + 1

    for change in body.changes:
        # Find existing secret
        secret_query = select(CloudSecret).where(
            CloudSecret.vault_id == vault_id,
            CloudSecret.name_hash == change.name_hash,
        )
        result = await db.execute(secret_query)
        secret = result.scalar_one_or_none()

        if secret:
            # Update existing
            secret.encrypted_name = change.encrypted_name
            secret.encrypted_content = change.encrypted_content
            secret.version = new_version
            secret.is_deleted = change.is_deleted
            secret.updated_at = datetime.now(timezone.utc)
        else:
            # Create new
            secret = CloudSecret(
                vault_id=vault_id,
                name_hash=change.name_hash,
                encrypted_name=change.encrypted_name,
                encrypted_content=change.encrypted_content,
                version=new_version,
                is_deleted=change.is_deleted,
            )
            db.add(secret)

    # Update vault version
    vault.version = new_version
    vault.updated_at = datetime.now(timezone.utc)

    # Update sync state
    sync_query = select(SyncState).where(
        SyncState.vault_id == vault_id,
        SyncState.device_id == body.device_id,
    )
    result = await db.execute(sync_query)
    sync_state = result.scalar_one_or_none()

    if sync_state:
        sync_state.last_sync_version = new_version
        sync_state.last_sync_at = datetime.now(timezone.utc)
    else:
        sync_state = SyncState(
            user_id=user_id,
            vault_id=vault_id,
            device_id=body.device_id,
            last_sync_version=new_version,
            last_sync_at=datetime.now(timezone.utc),
        )
        db.add(sync_state)

    await db.commit()

    return {
        "success": True,
        "new_version": new_version,
        "conflicts": [],
    }


@router.get("/vaults/{vault_id}/pull", response_model=PullChangesResponse)
async def pull_changes(
    vault_id: int,
    user_id: int,  # In production, get from JWT
    since_version: int = Query(default=0),
    device_id: str = Query(...),
    limit: int = Query(default=100, le=500),
    db: Annotated[AsyncSession, Depends(get_db)] = None,
) -> PullChangesResponse:
    """Pull changes from cloud since a specific version."""
    # Verify vault ownership
    vault_query = select(CloudVault).where(
        CloudVault.id == vault_id,
        CloudVault.user_id == user_id,
    )
    result = await db.execute(vault_query)
    vault = result.scalar_one_or_none()

    if not vault:
        raise HTTPException(status_code=404, detail="Vault not found")

    # Get changes since version
    secrets_query = (
        select(CloudSecret)
        .where(
            CloudSecret.vault_id == vault_id,
            CloudSecret.version > since_version,
        )
        .order_by(CloudSecret.version)
        .limit(limit + 1)  # Get one extra to check for more
    )
    result = await db.execute(secrets_query)
    secrets = result.scalars().all()

    has_more = len(secrets) > limit
    if has_more:
        secrets = secrets[:limit]

    changes = [
        SecretChange(
            name_hash=s.name_hash,
            encrypted_name=s.encrypted_name,
            encrypted_content=s.encrypted_content,
            version=s.version,
            is_deleted=s.is_deleted,
        )
        for s in secrets
    ]

    # Update sync state
    if changes:
        max_version = max(c.version for c in changes)
        sync_query = select(SyncState).where(
            SyncState.vault_id == vault_id,
            SyncState.device_id == device_id,
        )
        result = await db.execute(sync_query)
        sync_state = result.scalar_one_or_none()

        if sync_state:
            sync_state.last_sync_version = max_version
            sync_state.last_sync_at = datetime.now(timezone.utc)
        else:
            sync_state = SyncState(
                user_id=user_id,
                vault_id=vault_id,
                device_id=device_id,
                last_sync_version=max_version,
                last_sync_at=datetime.now(timezone.utc),
            )
            db.add(sync_state)

        await db.commit()

    return PullChangesResponse(
        current_version=vault.version,
        changes=changes,
        has_more=has_more,
    )


# === Conflict Resolution ===


@router.get("/vaults/{vault_id}/conflicts", response_model=list[ConflictResponse])
async def list_conflicts(
    vault_id: int,
    user_id: int,  # In production, get from JWT
    db: Annotated[AsyncSession, Depends(get_db)],
) -> list[ConflictResponse]:
    """List unresolved conflicts for a vault."""
    # Verify vault ownership
    vault_query = select(CloudVault).where(
        CloudVault.id == vault_id,
        CloudVault.user_id == user_id,
    )
    result = await db.execute(vault_query)
    vault = result.scalar_one_or_none()

    if not vault:
        raise HTTPException(status_code=404, detail="Vault not found")

    conflict_query = select(SyncConflict).where(
        SyncConflict.vault_id == vault_id,
        SyncConflict.resolved == False,
    )
    result = await db.execute(conflict_query)
    conflicts = result.scalars().all()

    return [
        ConflictResponse(
            id=c.id,
            secret_id=c.secret_id,
            local_version=c.local_version,
            remote_version=c.remote_version,
            local_content=c.local_content,
            remote_content=c.remote_content,
        )
        for c in conflicts
    ]


@router.post("/conflicts/{conflict_id}/resolve")
async def resolve_conflict(
    conflict_id: int,
    body: ResolveConflictRequest,
    db: Annotated[AsyncSession, Depends(get_db)],
) -> dict[str, bool]:
    """Resolve a sync conflict."""
    conflict_query = select(SyncConflict).where(SyncConflict.id == conflict_id)
    result = await db.execute(conflict_query)
    conflict = result.scalar_one_or_none()

    if not conflict:
        raise HTTPException(status_code=404, detail="Conflict not found")

    if conflict.resolved:
        raise HTTPException(status_code=400, detail="Conflict already resolved")

    # Get the secret
    secret_query = select(CloudSecret).where(CloudSecret.id == conflict.secret_id)
    result = await db.execute(secret_query)
    secret = result.scalar_one_or_none()

    if not secret:
        raise HTTPException(status_code=404, detail="Secret not found")

    # Apply resolution
    if body.resolution == "local":
        secret.encrypted_content = conflict.local_content
    elif body.resolution == "remote":
        # Keep remote content (already in place)
        pass
    elif body.resolution == "merge" and body.merged_content:
        secret.encrypted_content = body.merged_content
    else:
        raise HTTPException(status_code=400, detail="Invalid resolution")

    secret.version += 1
    secret.updated_at = datetime.now(timezone.utc)

    conflict.resolved = True
    conflict.resolution = body.resolution
    conflict.resolved_at = datetime.now(timezone.utc)

    # Update vault version
    vault_query = select(CloudVault).where(CloudVault.id == secret.vault_id)
    result = await db.execute(vault_query)
    vault = result.scalar_one_or_none()
    if vault:
        vault.version += 1
        vault.updated_at = datetime.now(timezone.utc)

    await db.commit()

    return {"success": True}


# === Sync Status ===


@router.get("/vaults/{vault_id}/status")
async def get_sync_status(
    vault_id: int,
    device_id: str,
    user_id: int,  # In production, get from JWT
    db: Annotated[AsyncSession, Depends(get_db)],
) -> dict[str, int | datetime | None | bool]:
    """Get sync status for a vault and device."""
    # Get vault
    vault_query = select(CloudVault).where(
        CloudVault.id == vault_id,
        CloudVault.user_id == user_id,
    )
    result = await db.execute(vault_query)
    vault = result.scalar_one_or_none()

    if not vault:
        raise HTTPException(status_code=404, detail="Vault not found")

    # Get sync state
    sync_query = select(SyncState).where(
        SyncState.vault_id == vault_id,
        SyncState.device_id == device_id,
    )
    result = await db.execute(sync_query)
    sync_state = result.scalar_one_or_none()

    # Check for unresolved conflicts
    conflict_query = select(SyncConflict).where(
        SyncConflict.vault_id == vault_id,
        SyncConflict.resolved == False,
    )
    result = await db.execute(conflict_query)
    has_conflicts = len(result.all()) > 0

    return {
        "current_version": vault.version,
        "synced_version": sync_state.last_sync_version if sync_state else 0,
        "last_sync_at": sync_state.last_sync_at if sync_state else None,
        "needs_sync": (sync_state.last_sync_version if sync_state else 0) < vault.version,
        "has_conflicts": has_conflicts,
    }
