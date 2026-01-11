"""Plain filesystem storage backend."""

import os
import stat
from pathlib import Path
from typing import Optional

from passshare.errors import NotFoundError, StorageError
from passshare.storage.base import StorageBackend


class FSBackend(StorageBackend):
    """Plain filesystem storage backend (no version control)."""

    def __init__(self, path: Path, extension: str = ".gpg") -> None:
        """Initialize the FS backend.

        Args:
            path: The store root path.
            extension: File extension for secrets (e.g., '.gpg', '.age').
        """
        self._path = path
        self._extension = extension

    def init(self, path: Path) -> None:
        """Initialize a new store.

        Args:
            path: The store path.

        Raises:
            StorageError: If initialization fails.
        """
        try:
            path.mkdir(parents=True, exist_ok=True)
            # Set directory permissions to 0700
            if os.name != "nt":  # Not Windows
                os.chmod(path, stat.S_IRWXU)
            self._path = path
        except OSError as e:
            raise StorageError(f"Failed to initialize store: {e}", str(path)) from e

    def initialized(self) -> bool:
        """Check if the store is initialized.

        Returns:
            True if the store directory exists.
        """
        return self._path.exists() and self._path.is_dir()

    def _resolve_path(self, name: str) -> Path:
        """Resolve a secret name to a file path.

        Args:
            name: The secret name.

        Returns:
            The full file path.
        """
        # Normalize the path
        name = name.strip("/")
        name = "/".join(p for p in name.split("/") if p and p not in (".", ".."))

        # Add extension if not present
        if not name.endswith(self._extension):
            name += self._extension

        return self._path / name

    def get(self, name: str) -> bytes:
        """Get a secret's content.

        Args:
            name: The secret name/path.

        Returns:
            The encrypted content.

        Raises:
            NotFoundError: If the secret doesn't exist.
            StorageError: If reading fails.
        """
        file_path = self._resolve_path(name)

        if not file_path.exists():
            raise NotFoundError(name)

        try:
            return file_path.read_bytes()
        except OSError as e:
            raise StorageError(f"Failed to read secret: {e}", str(file_path)) from e

    def set(self, name: str, value: bytes) -> None:
        """Set a secret's content.

        Args:
            name: The secret name/path.
            value: The encrypted content.

        Raises:
            StorageError: If writing fails.
        """
        file_path = self._resolve_path(name)

        try:
            # Create parent directories
            file_path.parent.mkdir(parents=True, exist_ok=True)

            # Set directory permissions
            if os.name != "nt":
                current = file_path.parent
                while current != self._path.parent:
                    try:
                        os.chmod(current, stat.S_IRWXU)
                    except OSError:
                        pass
                    current = current.parent

            # Write the file
            file_path.write_bytes(value)

            # Set file permissions to 0600
            if os.name != "nt":
                os.chmod(file_path, stat.S_IRUSR | stat.S_IWUSR)

        except OSError as e:
            raise StorageError(f"Failed to write secret: {e}", str(file_path)) from e

    def delete(self, name: str) -> None:
        """Delete a secret.

        Args:
            name: The secret name/path.

        Raises:
            NotFoundError: If the secret doesn't exist.
            StorageError: If deletion fails.
        """
        file_path = self._resolve_path(name)

        if not file_path.exists():
            raise NotFoundError(name)

        try:
            file_path.unlink()
        except OSError as e:
            raise StorageError(f"Failed to delete secret: {e}", str(file_path)) from e

    def exists(self, name: str) -> bool:
        """Check if a secret exists.

        Args:
            name: The secret name/path.

        Returns:
            True if the secret exists.
        """
        file_path = self._resolve_path(name)
        return file_path.exists() and file_path.is_file()

    def list(self, prefix: str = "") -> list[str]:
        """List secrets.

        Args:
            prefix: Optional prefix to filter by.

        Returns:
            List of secret names (without extension).
        """
        secrets = []
        search_path = self._path

        if prefix:
            prefix = prefix.strip("/")
            search_path = self._path / prefix

        if not search_path.exists():
            return []

        for file_path in search_path.rglob(f"*{self._extension}"):
            # Get relative path without extension
            rel_path = file_path.relative_to(self._path)
            name = str(rel_path).replace("\\", "/")
            if name.endswith(self._extension):
                name = name[: -len(self._extension)]
            secrets.append(name)

        return sorted(secrets)

    def is_dir(self, name: str) -> bool:
        """Check if a path is a directory.

        Args:
            name: The path to check.

        Returns:
            True if it's a directory.
        """
        dir_path = self._path / name.strip("/")
        return dir_path.exists() and dir_path.is_dir()

    def prune(self, prefix: str) -> None:
        """Remove empty directories.

        Args:
            prefix: The prefix to prune under.
        """
        if not prefix:
            return

        dir_path = self._path / prefix.strip("/")
        if not dir_path.exists():
            return

        # Walk from deepest to shallowest
        for root, dirs, files in os.walk(str(dir_path), topdown=False):
            root_path = Path(root)
            if root_path == self._path:
                continue

            # Remove empty directories
            if not any(root_path.iterdir()):
                try:
                    root_path.rmdir()
                except OSError:
                    pass

    @property
    def name(self) -> str:
        """Get the backend name."""
        return "fs"

    @property
    def path(self) -> Path:
        """Get the store path."""
        return self._path

    def version(self) -> Optional[str]:
        """Get the backend version.

        Returns:
            Version string.
        """
        return "1.0.0"
