"""Store management for PassShare.

A Store represents a single password store with:
- A storage backend (fs/gitfs)
- A crypto backend (gpg/age/plain)
- Recipients for encryption
"""

from __future__ import annotations

from pathlib import Path

from passshare.crypto.age import AgeBackend
from passshare.crypto.base import CryptoBackend
from passshare.crypto.gpg import GPGBackend
from passshare.errors import NotFoundError, NotInitializedError, StorageError
from passshare.secret import Secret
from passshare.storage.base import StorageBackend
from passshare.storage.fs import FSBackend
from passshare.storage.gitfs import GitFSBackend


class Store:
    """A password store."""

    def __init__(
        self,
        path: Path,
        crypto: CryptoBackend | None = None,
        storage: StorageBackend | None = None,
    ) -> None:
        """Initialize a store.

        Args:
            path: The store path.
            crypto: The crypto backend. Auto-detected if not specified.
            storage: The storage backend. Auto-detected if not specified.
        """
        self._path = path
        self._crypto = crypto
        self._storage = storage
        self._recipients: list[str] = []

        # Auto-detect backends if not specified
        if not self._crypto:
            self._crypto = self._detect_crypto()

        if not self._storage:
            self._storage = self._detect_storage()

        # Load recipients
        self._load_recipients()

    def _detect_crypto(self) -> CryptoBackend:
        """Detect the crypto backend from the store.

        Returns:
            The detected crypto backend.
        """
        age_recipients = self._path / ".age-recipients"

        if age_recipients.exists():
            return AgeBackend()
        else:
            # Default to GPG
            return GPGBackend()

    def _detect_storage(self) -> StorageBackend:
        """Detect the storage backend from the store.

        Returns:
            The detected storage backend.
        """
        git_dir = self._path / ".git"
        ext = self._crypto.ext if self._crypto else ".gpg"

        if git_dir.exists():
            return GitFSBackend(self._path, extension=ext)
        else:
            return FSBackend(self._path, extension=ext)

    def _load_recipients(self) -> None:
        """Load recipients from the ID file."""
        if not self._crypto:
            return

        id_file = self._path / self._crypto.id_file

        if not id_file.exists():
            return

        try:
            content = id_file.read_text(encoding="utf-8")
            self._recipients = []
            for line in content.split("\n"):
                line = line.strip()
                if line and not line.startswith("#"):
                    self._recipients.append(line)
        except OSError:
            pass

    def _save_recipients(self) -> None:
        """Save recipients to the ID file."""
        if not self._crypto:
            return

        id_file = self._path / self._crypto.id_file

        try:
            content = "\n".join(self._recipients) + "\n"
            id_file.write_text(content, encoding="utf-8")
        except OSError as e:
            raise StorageError(f"Failed to save recipients: {e}", str(id_file)) from e

    @property
    def path(self) -> Path:
        """Get the store path."""
        return self._path

    @property
    def crypto(self) -> CryptoBackend:
        """Get the crypto backend."""
        if not self._crypto:
            raise NotInitializedError(str(self._path))
        return self._crypto

    @property
    def storage(self) -> StorageBackend:
        """Get the storage backend."""
        if not self._storage:
            raise NotInitializedError(str(self._path))
        return self._storage

    @property
    def recipients(self) -> list[str]:
        """Get the recipients."""
        return self._recipients.copy()

    def initialized(self) -> bool:
        """Check if the store is initialized.

        Returns:
            True if the store is ready to use.
        """
        if not self._storage:
            return False

        if not self._storage.initialized():
            return False

        # Check for ID file
        if self._crypto:
            id_file = self._path / self._crypto.id_file
            if not id_file.exists():
                return False

        return True

    def init(self, recipients: list[str], storage_type: str = "gitfs") -> None:
        """Initialize the store.

        Args:
            recipients: Initial recipient key IDs.
            storage_type: Storage backend type ('gitfs' or 'fs').

        Raises:
            StorageError: If initialization fails.
        """
        if not recipients:
            raise StorageError("At least one recipient is required")

        # Set up storage backend
        ext = self._crypto.ext if self._crypto else ".gpg"

        if storage_type == "gitfs":
            self._storage = GitFSBackend(self._path, extension=ext)
        else:
            self._storage = FSBackend(self._path, extension=ext)

        # Initialize storage
        self._storage.init(self._path)

        # Save recipients
        self._recipients = recipients
        self._save_recipients()

        # Commit if using git
        if isinstance(self._storage, GitFSBackend):
            self._storage.add([self._crypto.id_file if self._crypto else ".gpg-id"])
            self._storage.commit("Initialize password store")

    def get(self, name: str) -> Secret:
        """Get a secret.

        Args:
            name: The secret name/path.

        Returns:
            The decrypted secret.

        Raises:
            NotFoundError: If the secret doesn't exist.
            DecryptError: If decryption fails.
        """
        if not self.initialized():
            raise NotInitializedError(str(self._path))

        # Get encrypted content
        ciphertext = self._storage.get(name)

        # Decrypt
        plaintext = self._crypto.decrypt(ciphertext)

        # Parse and return
        return Secret.from_bytes(plaintext)

    def set(self, name: str, secret: Secret) -> None:
        """Set a secret.

        Args:
            name: The secret name/path.
            secret: The secret to save.

        Raises:
            EncryptError: If encryption fails.
            StorageError: If storage fails.
        """
        if not self.initialized():
            raise NotInitializedError(str(self._path))

        # Serialize and encrypt
        plaintext = secret.to_bytes()
        ciphertext = self._crypto.encrypt(plaintext, self._recipients)

        # Store
        self._storage.set(name, ciphertext)

    def delete(self, name: str) -> None:
        """Delete a secret.

        Args:
            name: The secret name/path.

        Raises:
            NotFoundError: If the secret doesn't exist.
        """
        if not self.initialized():
            raise NotInitializedError(str(self._path))

        self._storage.delete(name)

    def exists(self, name: str) -> bool:
        """Check if a secret exists.

        Args:
            name: The secret name/path.

        Returns:
            True if the secret exists.
        """
        if not self.initialized():
            return False

        return self._storage.exists(name)

    def list(self, prefix: str = "") -> list[str]:
        """List secrets.

        Args:
            prefix: Optional prefix to filter by.

        Returns:
            List of secret names.
        """
        if not self.initialized():
            return []

        return self._storage.list(prefix)

    def is_dir(self, name: str) -> bool:
        """Check if a path is a directory.

        Args:
            name: The path to check.

        Returns:
            True if it's a directory.
        """
        if not self.initialized():
            return False

        return self._storage.is_dir(name)

    def copy(self, from_name: str, to_name: str, force: bool = False) -> None:
        """Copy a secret.

        Args:
            from_name: Source path.
            to_name: Destination path.
            force: Overwrite if exists.

        Raises:
            NotFoundError: If source doesn't exist.
            StorageError: If destination exists and not force.
        """
        if not self.exists(from_name):
            raise NotFoundError(from_name)

        if self.exists(to_name) and not force:
            raise StorageError(f"Destination already exists: {to_name}")

        secret = self.get(from_name)
        self.set(to_name, secret)

    def move(self, from_name: str, to_name: str, force: bool = False) -> None:
        """Move a secret.

        Args:
            from_name: Source path.
            to_name: Destination path.
            force: Overwrite if exists.

        Raises:
            NotFoundError: If source doesn't exist.
            StorageError: If destination exists and not force.
        """
        self.copy(from_name, to_name, force)
        self.delete(from_name)

    def add_recipient(self, key_id: str) -> None:
        """Add a recipient and re-encrypt all secrets.

        Args:
            key_id: The recipient key ID.
        """
        if key_id in self._recipients:
            return

        self._recipients.append(key_id)
        self._save_recipients()
        self._reencrypt_all()

    def remove_recipient(self, key_id: str) -> None:
        """Remove a recipient and re-encrypt all secrets.

        Args:
            key_id: The recipient key ID.
        """
        if key_id not in self._recipients:
            return

        self._recipients.remove(key_id)
        self._save_recipients()
        self._reencrypt_all()

    def _reencrypt_all(self) -> None:
        """Re-encrypt all secrets with current recipients."""
        for name in self.list():
            try:
                secret = self.get(name)
                self.set(name, secret)
            except Exception:
                # Skip secrets that can't be re-encrypted
                pass

    def sync(self) -> None:
        """Sync with remote (for git-backed stores)."""
        if isinstance(self._storage, GitFSBackend):
            self._storage.sync()

    def history(self, name: str, count: int = 10) -> list[dict[str, str]]:
        """Get history for a secret.

        Args:
            name: The secret name.
            count: Number of entries to return.

        Returns:
            List of history entries.
        """
        if isinstance(self._storage, GitFSBackend):
            return self._storage.history(name, count)
        return []

    def show_revision(self, name: str, revision: str) -> Secret:
        """Get a specific revision of a secret.

        Args:
            name: The secret name.
            revision: The revision (commit hash).

        Returns:
            The secret at that revision.
        """
        if not isinstance(self._storage, GitFSBackend):
            raise StorageError("History not available for non-git stores")

        ciphertext = self._storage.show_revision(name, revision)
        plaintext = self._crypto.decrypt(ciphertext)
        return Secret.from_bytes(plaintext)

    def __repr__(self) -> str:
        """Get string representation."""
        return f"Store(path={self._path}, crypto={self._crypto.name if self._crypto else None})"
