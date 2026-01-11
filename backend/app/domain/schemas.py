"""API Schemas for PassShare Vault."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field

# =============================================================================
# Auth Schemas
# =============================================================================


class UserCreate(BaseModel):
    """User registration schema."""

    username: str = Field(..., min_length=3, max_length=50)
    password: str = Field(..., min_length=8)
    gpg_key_id: str | None = Field(None, description="GPG Key ID for encryption")


class UserLogin(BaseModel):
    """User login schema."""

    username: str
    password: str


class Token(BaseModel):
    """JWT Token response."""

    access_token: str
    token_type: str = "bearer"
    expires_in: int = 3600


class UserResponse(BaseModel):
    """User response schema."""

    id: int
    username: str
    gpg_key_id: str | None
    created_at: datetime


# =============================================================================
# Secret Schemas
# =============================================================================


class SecretBase(BaseModel):
    """Base secret schema."""

    name: str = Field(..., description="Secret path (e.g., email/gmail)")


class SecretCreate(SecretBase):
    """Create secret schema."""

    password: str = Field(..., description="The password")
    data: dict[str, str] = Field(default_factory=dict, description="Key-value metadata")
    notes: str | None = Field(None, description="Additional notes")


class SecretUpdate(BaseModel):
    """Update secret schema."""

    password: str | None = Field(None, description="New password")
    data: dict[str, str] | None = Field(None, description="Updated metadata")
    notes: str | None = Field(None, description="Updated notes")


class SecretResponse(SecretBase):
    """Secret response schema (without password for list view)."""

    has_otp: bool = False
    has_notes: bool = False
    keys: list[str] = Field(default_factory=list, description="Available metadata keys")
    modified_at: datetime | None = None


class SecretDetailResponse(SecretBase):
    """Secret detail response (with password)."""

    password: str
    data: dict[str, str]
    notes: str | None
    has_otp: bool = False
    otp_code: str | None = None
    modified_at: datetime | None = None


class SecretListResponse(BaseModel):
    """List of secrets response."""

    secrets: list[SecretResponse]
    total: int


# =============================================================================
# Password Generation Schemas
# =============================================================================


class GeneratePasswordRequest(BaseModel):
    """Password generation request."""

    name: str = Field(..., description="Secret path to save password")
    length: int = Field(24, ge=8, le=128, description="Password length")
    symbols: bool = Field(True, description="Include symbols")
    xkcd: bool = Field(False, description="Generate XKCD-style passphrase")
    force: bool = Field(False, description="Overwrite existing secret")


class GeneratePasswordResponse(BaseModel):
    """Password generation response."""

    name: str
    password: str


class StandalonePasswordRequest(BaseModel):
    """Generate password without saving."""

    length: int = Field(24, ge=8, le=128)
    symbols: bool = True
    xkcd: bool = False
    count: int = Field(1, ge=1, le=10)


class StandalonePasswordResponse(BaseModel):
    """Standalone password response."""

    passwords: list[str]


# =============================================================================
# Config Schemas
# =============================================================================


class ConfigResponse(BaseModel):
    """Configuration response."""

    path: str
    autoclip: bool
    cliptimeout: int
    autosync: bool
    autopush: bool
    mounts: dict[str, str]


class ConfigUpdate(BaseModel):
    """Configuration update."""

    autoclip: bool | None = None
    cliptimeout: int | None = None
    autosync: bool | None = None
    autopush: bool | None = None


# =============================================================================
# Mount Schemas
# =============================================================================


class MountCreate(BaseModel):
    """Create mount point."""

    alias: str = Field(..., min_length=1, max_length=50)
    path: str


class MountResponse(BaseModel):
    """Mount point response."""

    alias: str
    path: str


# =============================================================================
# Recipient Schemas
# =============================================================================


class RecipientAdd(BaseModel):
    """Add recipient."""

    key_id: str
    store: str | None = None


class RecipientResponse(BaseModel):
    """Recipient response."""

    key_id: str
    name: str | None = None
    email: str | None = None


# =============================================================================
# Audit Schemas
# =============================================================================


class AuditResult(BaseModel):
    """Single audit result."""

    name: str
    strength: str  # weak, fair, good, strong
    entropy: float
    issues: list[str] = Field(default_factory=list)


class AuditResponse(BaseModel):
    """Audit response."""

    total_secrets: int
    weak_passwords: list[AuditResult]
    duplicates: list[list[str]]  # Groups of secrets with same password


# =============================================================================
# History Schemas
# =============================================================================


class HistoryEntry(BaseModel):
    """History entry."""

    revision: str
    date: datetime
    message: str
    author: str | None = None


class HistoryResponse(BaseModel):
    """History response."""

    name: str
    entries: list[HistoryEntry]


# =============================================================================
# Sync Schemas
# =============================================================================


class SyncRequest(BaseModel):
    """Sync request."""

    store: str | None = None


class SyncResponse(BaseModel):
    """Sync response."""

    success: bool
    message: str


# =============================================================================
# Search Schemas
# =============================================================================


class SearchRequest(BaseModel):
    """Search request."""

    query: str = Field(..., min_length=1)
    search_content: bool = Field(False, description="Search in secret contents (grep)")


class SearchResponse(BaseModel):
    """Search response."""

    matches: list[str]
    total: int
