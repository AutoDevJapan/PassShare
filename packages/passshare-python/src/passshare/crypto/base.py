"""Base crypto backend interface."""

from abc import ABC, abstractmethod


class CryptoBackend(ABC):
    """Abstract base class for crypto backends."""

    @abstractmethod
    def encrypt(self, plaintext: bytes, recipients: list[str]) -> bytes:
        """Encrypt plaintext for the given recipients.

        Args:
            plaintext: The data to encrypt.
            recipients: List of recipient key IDs.

        Returns:
            The encrypted data.

        Raises:
            EncryptError: If encryption fails.
        """
        pass

    @abstractmethod
    def decrypt(self, ciphertext: bytes) -> bytes:
        """Decrypt ciphertext.

        Args:
            ciphertext: The encrypted data.

        Returns:
            The decrypted data.

        Raises:
            DecryptError: If decryption fails.
        """
        pass

    @abstractmethod
    def recipient_ids(self, ciphertext: bytes) -> list[str]:
        """Get recipient IDs from ciphertext.

        Args:
            ciphertext: The encrypted data.

        Returns:
            List of recipient key IDs.
        """
        pass

    @abstractmethod
    def list_public_keys(self) -> list[str]:
        """List available public keys.

        Returns:
            List of public key IDs.
        """
        pass

    @abstractmethod
    def list_private_keys(self) -> list[str]:
        """List available private keys.

        Returns:
            List of private key IDs.
        """
        pass

    def find_public_keys(self, search: list[str]) -> list[str]:
        """Find public keys matching search terms.

        Args:
            search: Search terms (email, name, key ID).

        Returns:
            List of matching key IDs.
        """
        all_keys = self.list_public_keys()
        if not search:
            return all_keys
        return [k for k in all_keys if any(s.lower() in k.lower() for s in search)]

    def find_private_keys(self, search: list[str]) -> list[str]:
        """Find private keys matching search terms.

        Args:
            search: Search terms (email, name, key ID).

        Returns:
            List of matching key IDs.
        """
        all_keys = self.list_private_keys()
        if not search:
            return all_keys
        return [k for k in all_keys if any(s.lower() in k.lower() for s in search)]

    @property
    @abstractmethod
    def name(self) -> str:
        """Get the backend name."""
        pass

    @property
    @abstractmethod
    def ext(self) -> str:
        """Get the file extension (e.g., '.gpg')."""
        pass

    @property
    @abstractmethod
    def id_file(self) -> str:
        """Get the ID file name (e.g., '.gpg-id')."""
        pass

    def version(self) -> str | None:
        """Get the backend version.

        Returns:
            Version string or None.
        """
        return None
