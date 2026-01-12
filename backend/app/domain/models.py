"""Database models."""

from datetime import datetime

from sqlalchemy import Boolean, DateTime, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.infrastructure.database import Base


class User(Base):
    """User account for vault access."""

    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    username: Mapped[str] = mapped_column(String(50), unique=True, nullable=False, index=True)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    gpg_key_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    store_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    last_login: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )


class DownloadEvent(Base):
    """Track download events."""

    __tablename__ = "download_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    package: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    version: Mapped[str] = mapped_column(String(50), nullable=False)
    platform: Mapped[str] = mapped_column(String(50), nullable=False)
    ip_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    user_agent: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )


class ContactMessage(Base):
    """Store contact form messages."""

    __tablename__ = "contact_messages"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    email: Mapped[str] = mapped_column(String(255), nullable=False)
    subject: Mapped[str] = mapped_column(String(255), nullable=False)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    is_read: Mapped[bool] = mapped_column(default=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )


class Newsletter(Base):
    """Newsletter subscriptions."""

    __tablename__ = "newsletter_subscriptions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    is_active: Mapped[bool] = mapped_column(default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    unsubscribed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )


# Enterprise Features


class Organization(Base):
    """Organization for team management."""

    __tablename__ = "organizations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    slug: Mapped[str] = mapped_column(String(100), unique=True, nullable=False, index=True)
    sso_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    sso_provider: Mapped[str | None] = mapped_column(String(50), nullable=True)  # saml, oidc
    sso_config: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON config
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )


class OrganizationMember(Base):
    """Organization membership."""

    __tablename__ = "organization_members"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    organization_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    user_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    role: Mapped[str] = mapped_column(String(50), nullable=False, default="member")  # admin, member
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )


class AuditLog(Base):
    """Audit log for security events."""

    __tablename__ = "audit_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    organization_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    user_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    action: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    resource_type: Mapped[str | None] = mapped_column(String(50), nullable=True)  # secret, user, policy
    resource_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    details: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON details
    ip_address: Mapped[str | None] = mapped_column(String(45), nullable=True)
    user_agent: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
        index=True,
    )


class SecurityPolicy(Base):
    """Security policies for organizations."""

    __tablename__ = "security_policies"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    organization_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    # Password requirements
    min_password_length: Mapped[int] = mapped_column(Integer, default=12)
    require_uppercase: Mapped[bool] = mapped_column(Boolean, default=True)
    require_lowercase: Mapped[bool] = mapped_column(Boolean, default=True)
    require_numbers: Mapped[bool] = mapped_column(Boolean, default=True)
    require_symbols: Mapped[bool] = mapped_column(Boolean, default=True)

    # Security settings
    password_expiry_days: Mapped[int | None] = mapped_column(Integer, nullable=True)  # null = never
    max_failed_attempts: Mapped[int] = mapped_column(Integer, default=5)
    lockout_duration_minutes: Mapped[int] = mapped_column(Integer, default=30)
    require_2fa: Mapped[bool] = mapped_column(Boolean, default=False)
    session_timeout_minutes: Mapped[int] = mapped_column(Integer, default=60)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    updated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )


class SSOSession(Base):
    """SSO session for federated authentication."""

    __tablename__ = "sso_sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    organization_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    user_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    session_id: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    idp_session_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )


# Cloud Sync Models


class CloudVault(Base):
    """Cloud-stored encrypted vault."""

    __tablename__ = "cloud_vaults"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    encrypted_key: Mapped[str] = mapped_column(Text, nullable=False)  # E2E encrypted vault key
    key_derivation_salt: Mapped[str] = mapped_column(String(64), nullable=False)
    key_derivation_iterations: Mapped[int] = mapped_column(Integer, default=100000)
    version: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    updated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )


class CloudSecret(Base):
    """Cloud-stored encrypted secret."""

    __tablename__ = "cloud_secrets"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    vault_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    name_hash: Mapped[str] = mapped_column(String(64), nullable=False, index=True)  # HMAC of name for lookup
    encrypted_name: Mapped[str] = mapped_column(Text, nullable=False)  # E2E encrypted name
    encrypted_content: Mapped[str] = mapped_column(Text, nullable=False)  # E2E encrypted content
    version: Mapped[int] = mapped_column(Integer, default=1)
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    updated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )


class SyncState(Base):
    """Track sync state between clients and cloud."""

    __tablename__ = "sync_states"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    vault_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    device_id: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    last_sync_version: Mapped[int] = mapped_column(Integer, default=0)
    last_sync_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )


class SyncConflict(Base):
    """Track sync conflicts for manual resolution."""

    __tablename__ = "sync_conflicts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    vault_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    secret_id: Mapped[int] = mapped_column(Integer, nullable=False)
    local_version: Mapped[int] = mapped_column(Integer, nullable=False)
    remote_version: Mapped[int] = mapped_column(Integer, nullable=False)
    local_content: Mapped[str] = mapped_column(Text, nullable=False)
    remote_content: Mapped[str] = mapped_column(Text, nullable=False)
    resolved: Mapped[bool] = mapped_column(Boolean, default=False)
    resolution: Mapped[str | None] = mapped_column(String(20), nullable=True)  # local, remote, merge
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    resolved_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
