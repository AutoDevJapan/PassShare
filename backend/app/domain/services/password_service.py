"""Password management service."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING

from passshare import Gopass, Secret
from passshare.errors import NotFoundError
from passshare.password import check_password_strength, generate_password

if TYPE_CHECKING:
    from app.domain.models import User
    from app.domain.schemas import (
        AuditResponse,
        ConfigResponse,
        GeneratePasswordRequest,
        HistoryEntry,
        SecretCreate,
        SecretDetailResponse,
        SecretResponse,
        SecretUpdate,
    )


class PasswordService:
    """Service for password management operations."""

    def __init__(self, user: User) -> None:
        """Initialize password service for a user."""
        self.user = user
        self._gopass: Gopass | None = None

    @property
    def gopass(self) -> Gopass:
        """Get or create Gopass instance for user."""
        if self._gopass is None:
            # Use user-specific store path if configured
            if self.user.store_path:
                config_path = Path(self.user.store_path) / ".gopass.yml"
                self._gopass = Gopass(str(config_path) if config_path.exists() else None)
            else:
                self._gopass = Gopass()
        return self._gopass

    def list_secrets(self, prefix: str = "") -> list[SecretResponse]:
        """List all secrets."""
        from app.domain.schemas import SecretResponse

        secrets = self.gopass.list(prefix)
        result = []

        for name in secrets:
            try:
                secret = self.gopass.get(name)
                result.append(
                    SecretResponse(
                        name=name,
                        has_otp=secret.get("otp") is not None,
                        has_notes=bool(secret.notes),
                        keys=list(secret.data.keys()) if secret.data else [],
                    )
                )
            except Exception:
                # Include even if we can't read details
                result.append(SecretResponse(name=name))

        return result

    def get_secret(self, name: str) -> SecretDetailResponse:
        """Get a secret by name."""
        from app.domain.schemas import SecretDetailResponse

        try:
            secret = self.gopass.get(name)

            # Generate OTP if available
            otp_code = None
            if secret.get("otp"):
                try:
                    otp_code = secret.otp()
                except Exception:
                    pass

            return SecretDetailResponse(
                name=name,
                password=secret.password,
                data=dict(secret.data) if secret.data else {},
                notes=secret.notes,
                has_otp=secret.get("otp") is not None,
                otp_code=otp_code,
            )
        except NotFoundError as e:
            raise ValueError(f"Secret not found: {name}") from e

    def create_secret(self, data: SecretCreate) -> SecretDetailResponse:
        """Create a new secret."""
        if self.gopass.exists(data.name):
            raise ValueError(f"Secret already exists: {data.name}")

        secret = Secret(
            password=data.password,
            data=data.data or {},
            notes=data.notes,
        )
        self.gopass.set(data.name, secret)
        return self.get_secret(data.name)

    def update_secret(self, name: str, data: SecretUpdate) -> SecretDetailResponse:
        """Update an existing secret."""
        if not self.gopass.exists(name):
            raise ValueError(f"Secret not found: {name}")

        secret = self.gopass.get(name)

        if data.password is not None:
            secret.password = data.password
        if data.data is not None:
            secret.data = data.data
        if data.notes is not None:
            secret.notes = data.notes

        self.gopass.set(name, secret)
        return self.get_secret(name)

    def delete_secret(self, name: str) -> None:
        """Delete a secret."""
        if not self.gopass.exists(name):
            raise ValueError(f"Secret not found: {name}")
        self.gopass.delete(name)

    def generate_password(self, request: GeneratePasswordRequest) -> tuple[str, str]:
        """Generate and save a password."""
        if self.gopass.exists(request.name) and not request.force:
            raise ValueError(f"Secret already exists: {request.name}")

        password = self.gopass.generate(
            request.name,
            length=request.length,
            symbols=request.symbols,
            xkcd=request.xkcd,
            force=request.force,
        )
        return request.name, password

    def generate_standalone(
        self,
        length: int = 24,
        symbols: bool = True,
        xkcd: bool = False,
        count: int = 1,
    ) -> list[str]:
        """Generate passwords without saving."""
        return [
            generate_password(length=length, symbols=symbols, xkcd=xkcd)
            for _ in range(count)
        ]

    def search(self, query: str) -> list[str]:
        """Search secrets by name."""
        return self.gopass.find(query)

    def grep(self, pattern: str) -> list[tuple[str, str]]:
        """Search secret contents."""
        return self.gopass.grep(pattern)

    def copy_secret(self, from_name: str, to_name: str, force: bool = False) -> None:
        """Copy a secret."""
        self.gopass.copy(from_name, to_name, force)

    def move_secret(self, from_name: str, to_name: str, force: bool = False) -> None:
        """Move a secret."""
        self.gopass.move(from_name, to_name, force)

    def sync(self, store: str | None = None) -> None:
        """Sync with remote."""
        self.gopass.sync(store)

    def get_config(self) -> ConfigResponse:
        """Get configuration."""
        from app.domain.schemas import ConfigResponse

        config = self.gopass.config
        return ConfigResponse(
            path=str(config.store_path),
            autoclip=config.get("autoclip", True),
            cliptimeout=config.get("cliptimeout", 45),
            autosync=config.get("autosync", True),
            autopush=config.get("autopush", True),
            mounts=self.gopass.mounts,
        )

    def update_config(self, **kwargs: bool | int | str) -> ConfigResponse:
        """Update configuration."""
        config = self.gopass.config
        for key, value in kwargs.items():
            if value is not None:
                config.set(key, value)
        config.save()
        return self.get_config()

    def get_mounts(self) -> dict[str, str]:
        """Get mount points."""
        return self.gopass.mounts

    def add_mount(self, alias: str, path: str) -> None:
        """Add a mount point."""
        self.gopass.mount(alias, path)

    def remove_mount(self, alias: str) -> None:
        """Remove a mount point."""
        self.gopass.unmount(alias)

    def get_recipients(self, store: str | None = None) -> list[str]:
        """Get recipients."""
        return self.gopass.recipients(store)

    def add_recipient(self, key_id: str, store: str | None = None) -> None:
        """Add a recipient."""
        self.gopass.add_recipient(key_id, store)

    def remove_recipient(self, key_id: str, store: str | None = None) -> None:
        """Remove a recipient."""
        self.gopass.remove_recipient(key_id, store)

    def audit(self, folder: str | None = None) -> AuditResponse:
        """Audit password strength."""
        from app.domain.schemas import AuditResponse, AuditResult

        secrets = self.gopass.list(folder or "")
        weak_passwords = []
        duplicates: dict[str, list[str]] = {}

        for name in secrets:
            try:
                secret = self.gopass.get(name)
                password = secret.password

                # Check strength
                strength = check_password_strength(password)
                if strength["strength"] in ("weak", "fair"):
                    issues = []
                    if strength.get("too_short"):
                        issues.append("Too short")
                    if strength.get("no_uppercase"):
                        issues.append("No uppercase")
                    if strength.get("no_lowercase"):
                        issues.append("No lowercase")
                    if strength.get("no_digits"):
                        issues.append("No digits")
                    if strength.get("no_symbols"):
                        issues.append("No symbols")

                    weak_passwords.append(
                        AuditResult(
                            name=name,
                            strength=strength["strength"],
                            entropy=strength["entropy"],
                            issues=issues,
                        )
                    )

                # Track duplicates
                if password not in duplicates:
                    duplicates[password] = []
                duplicates[password].append(name)

            except Exception:
                pass

        # Filter to only actual duplicates
        dup_groups = [names for names in duplicates.values() if len(names) > 1]

        return AuditResponse(
            total_secrets=len(secrets),
            weak_passwords=weak_passwords,
            duplicates=dup_groups,
        )

    def get_history(self, name: str, count: int = 10) -> list[HistoryEntry]:
        """Get secret history."""
        from app.domain.schemas import HistoryEntry

        history = self.gopass.history(name, count)
        return [
            HistoryEntry(
                revision=entry.get("revision", ""),
                date=datetime.fromisoformat(entry.get("date", "")),
                message=entry.get("message", ""),
                author=entry.get("author"),
            )
            for entry in history
        ]

    def get_otp(self, name: str) -> str | None:
        """Get OTP code for a secret."""
        try:
            secret = self.gopass.get(name)
            return secret.otp()
        except Exception:
            return None
