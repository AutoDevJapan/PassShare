"""Enterprise API endpoints (SSO, Audit Logs, Policies).

© 2026 株式会社BM1314. All rights reserved.
"""

from datetime import datetime, timedelta, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.infrastructure.database import get_db
from app.domain.models import AuditLog, Organization, SecurityPolicy, SSOSession

router = APIRouter(prefix="/enterprise", tags=["enterprise"])


# === Schemas ===


class AuditLogResponse(BaseModel):
    """Audit log response."""

    id: int
    action: str
    resource_type: str | None
    resource_id: str | None
    details: str | None
    ip_address: str | None
    created_at: datetime


class AuditLogListResponse(BaseModel):
    """Audit log list response."""

    logs: list[AuditLogResponse]
    total: int
    page: int
    page_size: int


class CreateAuditLogRequest(BaseModel):
    """Create audit log request."""

    action: str
    resource_type: str | None = None
    resource_id: str | None = None
    details: str | None = None


class PolicyResponse(BaseModel):
    """Security policy response."""

    id: int
    name: str
    description: str | None
    is_active: bool
    min_password_length: int
    require_uppercase: bool
    require_lowercase: bool
    require_numbers: bool
    require_symbols: bool
    password_expiry_days: int | None
    max_failed_attempts: int
    lockout_duration_minutes: int
    require_2fa: bool
    session_timeout_minutes: int


class CreatePolicyRequest(BaseModel):
    """Create/update policy request."""

    name: str
    description: str | None = None
    min_password_length: int = 12
    require_uppercase: bool = True
    require_lowercase: bool = True
    require_numbers: bool = True
    require_symbols: bool = True
    password_expiry_days: int | None = None
    max_failed_attempts: int = 5
    lockout_duration_minutes: int = 30
    require_2fa: bool = False
    session_timeout_minutes: int = 60


class OrganizationResponse(BaseModel):
    """Organization response."""

    id: int
    name: str
    slug: str
    sso_enabled: bool
    sso_provider: str | None
    created_at: datetime


class CreateOrganizationRequest(BaseModel):
    """Create organization request."""

    name: str
    slug: str


class SSOConfigRequest(BaseModel):
    """SSO configuration request."""

    provider: str  # saml, oidc
    entity_id: str | None = None
    sso_url: str | None = None
    certificate: str | None = None
    client_id: str | None = None
    client_secret: str | None = None
    discovery_url: str | None = None


# === Helper Functions ===


async def log_audit_event(
    db: AsyncSession,
    action: str,
    request: Request,
    organization_id: int | None = None,
    user_id: int | None = None,
    resource_type: str | None = None,
    resource_id: str | None = None,
    details: str | None = None,
) -> None:
    """Log an audit event."""
    log = AuditLog(
        organization_id=organization_id,
        user_id=user_id,
        action=action,
        resource_type=resource_type,
        resource_id=resource_id,
        details=details,
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
    )
    db.add(log)
    await db.commit()


# === Audit Log Endpoints ===


@router.get("/audit-logs", response_model=AuditLogListResponse)
async def list_audit_logs(
    db: Annotated[AsyncSession, Depends(get_db)],
    organization_id: int | None = None,
    user_id: int | None = None,
    action: str | None = None,
    resource_type: str | None = None,
    start_date: datetime | None = None,
    end_date: datetime | None = None,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=100),
) -> AuditLogListResponse:
    """List audit logs with filtering."""
    query = select(AuditLog)

    if organization_id:
        query = query.where(AuditLog.organization_id == organization_id)
    if user_id:
        query = query.where(AuditLog.user_id == user_id)
    if action:
        query = query.where(AuditLog.action == action)
    if resource_type:
        query = query.where(AuditLog.resource_type == resource_type)
    if start_date:
        query = query.where(AuditLog.created_at >= start_date)
    if end_date:
        query = query.where(AuditLog.created_at <= end_date)

    # Get total count
    total_query = select(AuditLog.id)
    if organization_id:
        total_query = total_query.where(AuditLog.organization_id == organization_id)
    result = await db.execute(total_query)
    total = len(result.all())

    # Get paginated results
    query = query.order_by(AuditLog.created_at.desc())
    query = query.offset((page - 1) * page_size).limit(page_size)

    result = await db.execute(query)
    logs = result.scalars().all()

    return AuditLogListResponse(
        logs=[
            AuditLogResponse(
                id=log.id,
                action=log.action,
                resource_type=log.resource_type,
                resource_id=log.resource_id,
                details=log.details,
                ip_address=log.ip_address,
                created_at=log.created_at,
            )
            for log in logs
        ],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.post("/audit-logs")
async def create_audit_log(
    request: Request,
    body: CreateAuditLogRequest,
    db: Annotated[AsyncSession, Depends(get_db)],
) -> dict[str, bool]:
    """Create an audit log entry."""
    await log_audit_event(
        db=db,
        action=body.action,
        request=request,
        resource_type=body.resource_type,
        resource_id=body.resource_id,
        details=body.details,
    )
    return {"success": True}


# === Security Policy Endpoints ===


@router.get("/organizations/{org_id}/policies", response_model=list[PolicyResponse])
async def list_policies(
    org_id: int,
    db: Annotated[AsyncSession, Depends(get_db)],
) -> list[PolicyResponse]:
    """List security policies for an organization."""
    query = select(SecurityPolicy).where(SecurityPolicy.organization_id == org_id)
    result = await db.execute(query)
    policies = result.scalars().all()

    return [
        PolicyResponse(
            id=p.id,
            name=p.name,
            description=p.description,
            is_active=p.is_active,
            min_password_length=p.min_password_length,
            require_uppercase=p.require_uppercase,
            require_lowercase=p.require_lowercase,
            require_numbers=p.require_numbers,
            require_symbols=p.require_symbols,
            password_expiry_days=p.password_expiry_days,
            max_failed_attempts=p.max_failed_attempts,
            lockout_duration_minutes=p.lockout_duration_minutes,
            require_2fa=p.require_2fa,
            session_timeout_minutes=p.session_timeout_minutes,
        )
        for p in policies
    ]


@router.post("/organizations/{org_id}/policies", response_model=PolicyResponse)
async def create_policy(
    org_id: int,
    body: CreatePolicyRequest,
    db: Annotated[AsyncSession, Depends(get_db)],
    request: Request,
) -> PolicyResponse:
    """Create a security policy."""
    policy = SecurityPolicy(
        organization_id=org_id,
        name=body.name,
        description=body.description,
        min_password_length=body.min_password_length,
        require_uppercase=body.require_uppercase,
        require_lowercase=body.require_lowercase,
        require_numbers=body.require_numbers,
        require_symbols=body.require_symbols,
        password_expiry_days=body.password_expiry_days,
        max_failed_attempts=body.max_failed_attempts,
        lockout_duration_minutes=body.lockout_duration_minutes,
        require_2fa=body.require_2fa,
        session_timeout_minutes=body.session_timeout_minutes,
    )

    db.add(policy)
    await db.commit()
    await db.refresh(policy)

    await log_audit_event(
        db=db,
        action="policy.created",
        request=request,
        organization_id=org_id,
        resource_type="policy",
        resource_id=str(policy.id),
    )

    return PolicyResponse(
        id=policy.id,
        name=policy.name,
        description=policy.description,
        is_active=policy.is_active,
        min_password_length=policy.min_password_length,
        require_uppercase=policy.require_uppercase,
        require_lowercase=policy.require_lowercase,
        require_numbers=policy.require_numbers,
        require_symbols=policy.require_symbols,
        password_expiry_days=policy.password_expiry_days,
        max_failed_attempts=policy.max_failed_attempts,
        lockout_duration_minutes=policy.lockout_duration_minutes,
        require_2fa=policy.require_2fa,
        session_timeout_minutes=policy.session_timeout_minutes,
    )


@router.put("/organizations/{org_id}/policies/{policy_id}", response_model=PolicyResponse)
async def update_policy(
    org_id: int,
    policy_id: int,
    body: CreatePolicyRequest,
    db: Annotated[AsyncSession, Depends(get_db)],
    request: Request,
) -> PolicyResponse:
    """Update a security policy."""
    query = select(SecurityPolicy).where(
        SecurityPolicy.id == policy_id,
        SecurityPolicy.organization_id == org_id,
    )
    result = await db.execute(query)
    policy = result.scalar_one_or_none()

    if not policy:
        raise HTTPException(status_code=404, detail="Policy not found")

    policy.name = body.name
    policy.description = body.description
    policy.min_password_length = body.min_password_length
    policy.require_uppercase = body.require_uppercase
    policy.require_lowercase = body.require_lowercase
    policy.require_numbers = body.require_numbers
    policy.require_symbols = body.require_symbols
    policy.password_expiry_days = body.password_expiry_days
    policy.max_failed_attempts = body.max_failed_attempts
    policy.lockout_duration_minutes = body.lockout_duration_minutes
    policy.require_2fa = body.require_2fa
    policy.session_timeout_minutes = body.session_timeout_minutes
    policy.updated_at = datetime.now(timezone.utc)

    await db.commit()
    await db.refresh(policy)

    await log_audit_event(
        db=db,
        action="policy.updated",
        request=request,
        organization_id=org_id,
        resource_type="policy",
        resource_id=str(policy.id),
    )

    return PolicyResponse(
        id=policy.id,
        name=policy.name,
        description=policy.description,
        is_active=policy.is_active,
        min_password_length=policy.min_password_length,
        require_uppercase=policy.require_uppercase,
        require_lowercase=policy.require_lowercase,
        require_numbers=policy.require_numbers,
        require_symbols=policy.require_symbols,
        password_expiry_days=policy.password_expiry_days,
        max_failed_attempts=policy.max_failed_attempts,
        lockout_duration_minutes=policy.lockout_duration_minutes,
        require_2fa=policy.require_2fa,
        session_timeout_minutes=policy.session_timeout_minutes,
    )


# === Organization Endpoints ===


@router.get("/organizations", response_model=list[OrganizationResponse])
async def list_organizations(
    db: Annotated[AsyncSession, Depends(get_db)],
) -> list[OrganizationResponse]:
    """List all organizations."""
    query = select(Organization)
    result = await db.execute(query)
    orgs = result.scalars().all()

    return [
        OrganizationResponse(
            id=org.id,
            name=org.name,
            slug=org.slug,
            sso_enabled=org.sso_enabled,
            sso_provider=org.sso_provider,
            created_at=org.created_at,
        )
        for org in orgs
    ]


@router.post("/organizations", response_model=OrganizationResponse)
async def create_organization(
    body: CreateOrganizationRequest,
    db: Annotated[AsyncSession, Depends(get_db)],
    request: Request,
) -> OrganizationResponse:
    """Create an organization."""
    org = Organization(
        name=body.name,
        slug=body.slug,
    )

    db.add(org)
    await db.commit()
    await db.refresh(org)

    await log_audit_event(
        db=db,
        action="organization.created",
        request=request,
        organization_id=org.id,
        resource_type="organization",
        resource_id=str(org.id),
    )

    return OrganizationResponse(
        id=org.id,
        name=org.name,
        slug=org.slug,
        sso_enabled=org.sso_enabled,
        sso_provider=org.sso_provider,
        created_at=org.created_at,
    )


# === SSO Endpoints ===


@router.post("/organizations/{org_id}/sso/configure")
async def configure_sso(
    org_id: int,
    body: SSOConfigRequest,
    db: Annotated[AsyncSession, Depends(get_db)],
    request: Request,
) -> dict[str, bool]:
    """Configure SSO for an organization."""
    query = select(Organization).where(Organization.id == org_id)
    result = await db.execute(query)
    org = result.scalar_one_or_none()

    if not org:
        raise HTTPException(status_code=404, detail="Organization not found")

    import json

    config = {
        "entity_id": body.entity_id,
        "sso_url": body.sso_url,
        "certificate": body.certificate,
        "client_id": body.client_id,
        "client_secret": body.client_secret,
        "discovery_url": body.discovery_url,
    }

    org.sso_enabled = True
    org.sso_provider = body.provider
    org.sso_config = json.dumps(config)

    await db.commit()

    await log_audit_event(
        db=db,
        action="sso.configured",
        request=request,
        organization_id=org_id,
        resource_type="organization",
        resource_id=str(org.id),
    )

    return {"success": True}


@router.delete("/organizations/{org_id}/sso")
async def disable_sso(
    org_id: int,
    db: Annotated[AsyncSession, Depends(get_db)],
    request: Request,
) -> dict[str, bool]:
    """Disable SSO for an organization."""
    query = select(Organization).where(Organization.id == org_id)
    result = await db.execute(query)
    org = result.scalar_one_or_none()

    if not org:
        raise HTTPException(status_code=404, detail="Organization not found")

    org.sso_enabled = False
    org.sso_provider = None
    org.sso_config = None

    await db.commit()

    await log_audit_event(
        db=db,
        action="sso.disabled",
        request=request,
        organization_id=org_id,
        resource_type="organization",
        resource_id=str(org.id),
    )

    return {"success": True}


@router.get("/organizations/{org_id}/sso/status")
async def get_sso_status(
    org_id: int,
    db: Annotated[AsyncSession, Depends(get_db)],
) -> dict[str, bool | str | None]:
    """Get SSO status for an organization."""
    query = select(Organization).where(Organization.id == org_id)
    result = await db.execute(query)
    org = result.scalar_one_or_none()

    if not org:
        raise HTTPException(status_code=404, detail="Organization not found")

    return {
        "enabled": org.sso_enabled,
        "provider": org.sso_provider,
    }
