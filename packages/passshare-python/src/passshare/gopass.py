"""Gopass - Main API class for PassShare.

Provides a gopass-compatible API for password management.
"""

from __future__ import annotations

import fnmatch
import re
from pathlib import Path

from passshare.config import Config
from passshare.crypto.age import AgeBackend
from passshare.crypto.gpg import GPGBackend
from passshare.errors import NotInitializedError, StorageError
from passshare.password import generate_password
from passshare.secret import Secret
from passshare.store import Store


class Gopass:
    """Main PassShare API class.

    Compatible with gopass pkg/gopass interface.

    Example:
        >>> from passshare import Gopass, Secret
        >>> gopass = Gopass()
        >>> secret = gopass.get("email/gmail")
        >>> print(secret.password)
    """

    def __init__(self, config_path: str | None = None) -> None:
        """Initialize Gopass.

        Args:
            config_path: Path to config file. Uses default if not specified.
        """
        self._config = Config(Path(config_path) if config_path else None)
        self._config.load()

        self._root_store: Store | None = None
        self._mount_stores: dict[str, Store] = {}

        # Initialize stores
        self._init_stores()

    def _init_stores(self) -> None:
        """Initialize root and mounted stores."""
        # Root store
        root_path = self._config.store_path
        if root_path.exists():
            self._root_store = Store(root_path)

        # Mounted stores
        for alias, mount_path in self._config.mounts.items():
            path = Path(mount_path)
            if path.exists():
                self._mount_stores[alias] = Store(path)

    def _resolve_store(self, name: str) -> tuple[Store, str]:
        """Resolve a secret name to a store and relative path.

        Args:
            name: The secret name (may include mount prefix).

        Returns:
            Tuple of (store, relative_name).

        Raises:
            NotInitializedError: If no store is available.
        """
        name = name.strip("/")

        # Check if name starts with a mount prefix
        for alias, store in self._mount_stores.items():
            if name == alias or name.startswith(f"{alias}/"):
                relative_name = name[len(alias):].lstrip("/")
                return (store, relative_name or "")

        # Use root store
        if not self._root_store:
            raise NotInitializedError()

        return (self._root_store, name)

    @property
    def initialized(self) -> bool:
        """Check if any store is initialized.

        Returns:
            True if at least one store is usable.
        """
        if self._root_store and self._root_store.initialized():
            return True

        for store in self._mount_stores.values():
            if store.initialized():
                return True

        return False

    def init(
        self,
        recipients: list[str],
        path: Path | None = None,
        crypto: str = "gpg",
        storage: str = "gitfs",
    ) -> None:
        """Initialize a new store.

        Args:
            recipients: Recipient key IDs.
            path: Store path. Uses default if not specified.
            crypto: Crypto backend ('gpg' or 'age').
            storage: Storage backend ('gitfs' or 'fs').
        """
        store_path = path or self._config.store_path

        # Create crypto backend
        if crypto == "age":
            crypto_backend = AgeBackend()
        else:
            crypto_backend = GPGBackend()

        # Create store
        store = Store(store_path, crypto=crypto_backend)
        store.init(recipients, storage_type=storage)

        # Update config
        if path is None:
            self._root_store = store
        else:
            self._config.store_path = store_path
            self._config.save()

    def get(self, name: str) -> Secret:
        """Get a secret.

        Args:
            name: The secret path (e.g., "email/gmail").

        Returns:
            The decrypted secret.

        Raises:
            NotFoundError: If the secret doesn't exist.
            DecryptError: If decryption fails.
        """
        store, relative_name = self._resolve_store(name)
        return store.get(relative_name)

    def set(self, name: str, secret: Secret) -> None:
        """Set a secret.

        Args:
            name: The secret path.
            secret: The secret to save.

        Raises:
            EncryptError: If encryption fails.
            StorageError: If storage fails.
        """
        store, relative_name = self._resolve_store(name)
        store.set(relative_name, secret)

    def delete(self, name: str) -> None:
        """Delete a secret.

        Args:
            name: The secret path.

        Raises:
            NotFoundError: If the secret doesn't exist.
        """
        store, relative_name = self._resolve_store(name)
        store.delete(relative_name)

    def exists(self, name: str) -> bool:
        """Check if a secret exists.

        Args:
            name: The secret path.

        Returns:
            True if the secret exists.
        """
        try:
            store, relative_name = self._resolve_store(name)
            return store.exists(relative_name)
        except NotInitializedError:
            return False

    def list(self, prefix: str = "") -> list[str]:
        """List secrets.

        Args:
            prefix: Optional prefix to filter by.

        Returns:
            List of secret paths.
        """
        secrets = []

        # Check if prefix is for a mounted store
        prefix = prefix.strip("/")

        for alias, store in self._mount_stores.items():
            if not prefix or prefix == alias or prefix.startswith(f"{alias}/"):
                # List from this mount
                mount_prefix = prefix[len(alias):].lstrip("/") if prefix.startswith(alias) else ""
                for name in store.list(mount_prefix):
                    secrets.append(f"{alias}/{name}")
            elif not prefix:
                # List all from mount
                for name in store.list():
                    secrets.append(f"{alias}/{name}")

        # List from root store
        if self._root_store:
            # Don't list root if prefix matches a mount
            should_list_root = True
            for alias in self._mount_stores:
                if prefix == alias or prefix.startswith(f"{alias}/"):
                    should_list_root = False
                    break

            if should_list_root:
                secrets.extend(self._root_store.list(prefix))

        return sorted(secrets)

    def find(self, pattern: str) -> list[str]:
        """Find secrets by name pattern.

        Args:
            pattern: The search pattern (supports glob).

        Returns:
            List of matching secret paths.
        """
        all_secrets = self.list()
        pattern_lower = pattern.lower()

        matches = []
        for name in all_secrets:
            name_lower = name.lower()
            # Check for substring match or glob match
            if pattern_lower in name_lower or fnmatch.fnmatch(name_lower, f"*{pattern_lower}*"):
                matches.append(name)

        return matches

    def grep(self, pattern: str) -> list[tuple[str, str]]:
        """Search secret contents.

        Args:
            pattern: The regex pattern to search for.

        Returns:
            List of (secret_name, matching_line) tuples.
        """
        results = []
        regex = re.compile(pattern, re.IGNORECASE)

        for name in self.list():
            try:
                secret = self.get(name)
                content = str(secret)

                for line in content.split("\n"):
                    if regex.search(line):
                        results.append((name, line))

            except Exception:
                # Skip secrets that can't be read
                pass

        return results

    def generate(
        self,
        name: str,
        length: int = 24,
        symbols: bool = True,
        xkcd: bool = False,
        force: bool = False,
    ) -> str:
        """Generate a password and save it.

        Args:
            name: The secret path.
            length: Password length.
            symbols: Include symbols.
            xkcd: Generate XKCD-style password.
            force: Overwrite existing secret.

        Returns:
            The generated password.

        Raises:
            StorageError: If the secret exists and not force.
        """
        if self.exists(name) and not force:
            raise StorageError(f"Secret already exists: {name}")

        password = generate_password(
            length=length,
            symbols=symbols,
            xkcd=xkcd,
        )

        # Try to preserve existing data if updating
        if self.exists(name) and force:
            secret = self.get(name)
            secret.password = password
        else:
            secret = Secret(password=password)

        self.set(name, secret)
        return password

    def copy(self, from_name: str, to_name: str, force: bool = False) -> None:
        """Copy a secret.

        Args:
            from_name: Source path.
            to_name: Destination path.
            force: Overwrite if exists.
        """
        secret = self.get(from_name)
        if self.exists(to_name) and not force:
            raise StorageError(f"Destination already exists: {to_name}")
        self.set(to_name, secret)

    def move(self, from_name: str, to_name: str, force: bool = False) -> None:
        """Move a secret.

        Args:
            from_name: Source path.
            to_name: Destination path.
            force: Overwrite if exists.
        """
        self.copy(from_name, to_name, force)
        self.delete(from_name)

    def sync(self, store: str | None = None) -> None:
        """Sync with remote.

        Args:
            store: Store name to sync. Syncs all if not specified.
        """
        if store:
            if store in self._mount_stores:
                self._mount_stores[store].sync()
            elif self._root_store and store == "root":
                self._root_store.sync()
        else:
            # Sync all
            if self._root_store:
                try:
                    self._root_store.sync()
                except Exception:
                    pass

            for mount_store in self._mount_stores.values():
                try:
                    mount_store.sync()
                except Exception:
                    pass

    @property
    def mounts(self) -> dict[str, str]:
        """Get mount points.

        Returns:
            Dict of alias -> path.
        """
        return self._config.mounts

    def mount(self, alias: str, path: str) -> None:
        """Add a mount point.

        Args:
            alias: The mount alias.
            path: The store path.
        """
        self._config.add_mount(alias, path)
        self._config.save()

        # Initialize the store
        store_path = Path(path)
        if store_path.exists():
            self._mount_stores[alias] = Store(store_path)

    def unmount(self, alias: str) -> None:
        """Remove a mount point.

        Args:
            alias: The mount alias.
        """
        self._config.remove_mount(alias)
        self._config.save()

        if alias in self._mount_stores:
            del self._mount_stores[alias]

    def recipients(self, store: str | None = None) -> list[str]:
        """Get recipients for a store.

        Args:
            store: Store name. Uses root if not specified.

        Returns:
            List of recipient key IDs.
        """
        if store and store in self._mount_stores:
            return self._mount_stores[store].recipients

        if self._root_store:
            return self._root_store.recipients

        return []

    def add_recipient(self, key_id: str, store: str | None = None) -> None:
        """Add a recipient to a store.

        Args:
            key_id: The recipient key ID.
            store: Store name. Uses root if not specified.
        """
        if store and store in self._mount_stores:
            self._mount_stores[store].add_recipient(key_id)
        elif self._root_store:
            self._root_store.add_recipient(key_id)

    def remove_recipient(self, key_id: str, store: str | None = None) -> None:
        """Remove a recipient from a store.

        Args:
            key_id: The recipient key ID.
            store: Store name. Uses root if not specified.
        """
        if store and store in self._mount_stores:
            self._mount_stores[store].remove_recipient(key_id)
        elif self._root_store:
            self._root_store.remove_recipient(key_id)

    def history(self, name: str, count: int = 10) -> list[dict[str, str]]:
        """Get history for a secret.

        Args:
            name: The secret path.
            count: Number of entries.

        Returns:
            List of history entries.
        """
        store, relative_name = self._resolve_store(name)
        return store.history(relative_name, count)

    def show_revision(self, name: str, revision: str) -> Secret:
        """Get a specific revision of a secret.

        Args:
            name: The secret path.
            revision: The revision (commit hash).

        Returns:
            The secret at that revision.
        """
        store, relative_name = self._resolve_store(name)
        return store.show_revision(relative_name, revision)

    @property
    def config(self) -> Config:
        """Get the config object."""
        return self._config

    def __repr__(self) -> str:
        """Get string representation."""
        return f"Gopass(stores={1 + len(self._mount_stores)})"
