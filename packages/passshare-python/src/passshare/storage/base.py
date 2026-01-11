"""Base storage backend interface."""

from abc import ABC, abstractmethod
from pathlib import Path
from typing import Optional


class StorageBackend(ABC):
    """Abstract base class for storage backends."""

    @abstractmethod
    def init(self, path: Path) -> None:
        """Initialize a new store.

        Args:
            path: The store path.

        Raises:
            StorageError: If initialization fails.
        """
        pass

    @abstractmethod
    def initialized(self) -> bool:
        """Check if the store is initialized.

        Returns:
            True if initialized.
        """
        pass

    @abstractmethod
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
        pass

    @abstractmethod
    def set(self, name: str, value: bytes) -> None:
        """Set a secret's content.

        Args:
            name: The secret name/path.
            value: The encrypted content.

        Raises:
            StorageError: If writing fails.
        """
        pass

    @abstractmethod
    def delete(self, name: str) -> None:
        """Delete a secret.

        Args:
            name: The secret name/path.

        Raises:
            NotFoundError: If the secret doesn't exist.
            StorageError: If deletion fails.
        """
        pass

    @abstractmethod
    def exists(self, name: str) -> bool:
        """Check if a secret exists.

        Args:
            name: The secret name/path.

        Returns:
            True if the secret exists.
        """
        pass

    @abstractmethod
    def list(self, prefix: str = "") -> list[str]:
        """List secrets.

        Args:
            prefix: Optional prefix to filter by.

        Returns:
            List of secret names.
        """
        pass

    @abstractmethod
    def is_dir(self, name: str) -> bool:
        """Check if a path is a directory.

        Args:
            name: The path to check.

        Returns:
            True if it's a directory.
        """
        pass

    def prune(self, prefix: str) -> None:
        """Remove empty directories.

        Args:
            prefix: The prefix to prune under.
        """
        pass

    @property
    @abstractmethod
    def name(self) -> str:
        """Get the backend name."""
        pass

    @property
    @abstractmethod
    def path(self) -> Path:
        """Get the store path."""
        pass

    def version(self) -> Optional[str]:
        """Get the backend version.

        Returns:
            Version string or None.
        """
        return None
