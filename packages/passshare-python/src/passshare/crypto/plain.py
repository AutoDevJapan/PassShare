"""Plain (no encryption) backend for PassShare.

WARNING: This backend is for testing only. Do NOT use in production.
"""

import warnings
from typing import Optional

from passshare.crypto.base import CryptoBackend


class PlainBackend(CryptoBackend):
    """Plain text (no encryption) backend.

    WARNING: This backend provides NO security and should only be used
    for testing purposes.
    """

    def __init__(self) -> None:
        """Initialize Plain backend.

        Emits a warning about the lack of security.
        """
        warnings.warn(
            "PlainBackend provides NO encryption. Do NOT use in production!",
            UserWarning,
            stacklevel=2,
        )

    def encrypt(self, plaintext: bytes, recipients: list[str]) -> bytes:
        """'Encrypt' plaintext (just returns the input).

        Args:
            plaintext: The data to 'encrypt'.
            recipients: Ignored.

        Returns:
            The input unchanged.
        """
        return plaintext

    def decrypt(self, ciphertext: bytes) -> bytes:
        """'Decrypt' ciphertext (just returns the input).

        Args:
            ciphertext: The 'encrypted' data.

        Returns:
            The input unchanged.
        """
        return ciphertext

    def recipient_ids(self, ciphertext: bytes) -> list[str]:
        """Get recipient IDs from ciphertext.

        Args:
            ciphertext: The 'encrypted' data.

        Returns:
            Empty list (no recipients for plain text).
        """
        return []

    def list_public_keys(self) -> list[str]:
        """List available public keys.

        Returns:
            A dummy key for testing.
        """
        return ["plain-test-key"]

    def list_private_keys(self) -> list[str]:
        """List available private keys.

        Returns:
            A dummy key for testing.
        """
        return ["plain-test-key"]

    @property
    def name(self) -> str:
        """Get the backend name."""
        return "plain"

    @property
    def ext(self) -> str:
        """Get the file extension."""
        return ".txt"

    @property
    def id_file(self) -> str:
        """Get the ID file name."""
        return ".plain-id"

    def version(self) -> Optional[str]:
        """Get the backend version.

        Returns:
            Version string.
        """
        return "1.0.0"
