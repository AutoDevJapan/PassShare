"""GPG crypto backend for PassShare."""

import os
import re
import subprocess

from passshare.crypto.base import CryptoBackend
from passshare.errors import DecryptError, EncryptError


class GPGBackend(CryptoBackend):
    """GnuPG crypto backend."""

    def __init__(self, gpg_binary: str | None = None) -> None:
        """Initialize GPG backend.

        Args:
            gpg_binary: Path to GPG binary. Uses GOPASS_GPG_BINARY env or 'gpg'.
        """
        self._gpg = gpg_binary or os.environ.get("GOPASS_GPG_BINARY", "gpg")
        self._version_cache: str | None = None

    def _run_gpg(
        self,
        args: list[str],
        input_data: bytes | None = None,
        check: bool = True,
    ) -> subprocess.CompletedProcess[bytes]:
        """Run a GPG command.

        Args:
            args: Command arguments.
            input_data: Data to pass to stdin.
            check: Whether to check return code.

        Returns:
            The completed process.

        Raises:
            EncryptError/DecryptError: On failure.
        """
        cmd = [self._gpg, "--batch", "--yes", "--quiet"] + args

        try:
            result = subprocess.run(
                cmd,
                input=input_data,
                capture_output=True,
                check=check,
            )
            return result
        except subprocess.CalledProcessError as e:
            stderr = e.stderr.decode("utf-8", errors="replace") if e.stderr else ""
            raise EncryptError(f"GPG command failed: {stderr}") from e
        except FileNotFoundError as e:
            raise EncryptError(f"GPG binary not found: {self._gpg}") from e

    def encrypt(self, plaintext: bytes, recipients: list[str]) -> bytes:
        """Encrypt plaintext for the given recipients.

        Args:
            plaintext: The data to encrypt.
            recipients: List of recipient key IDs.

        Returns:
            The encrypted data (ASCII armored).

        Raises:
            EncryptError: If encryption fails.
        """
        if not recipients:
            raise EncryptError("No recipients specified")

        args = ["--encrypt", "--armor"]
        for recipient in recipients:
            args.extend(["--recipient", recipient])

        try:
            result = self._run_gpg(args, input_data=plaintext)
            return result.stdout
        except EncryptError:
            raise
        except Exception as e:
            raise EncryptError(f"Encryption failed: {e}") from e

    def decrypt(self, ciphertext: bytes) -> bytes:
        """Decrypt ciphertext.

        Args:
            ciphertext: The encrypted data.

        Returns:
            The decrypted data.

        Raises:
            DecryptError: If decryption fails.
        """
        args = ["--decrypt"]

        try:
            result = self._run_gpg(args, input_data=ciphertext, check=False)
            if result.returncode != 0:
                stderr = result.stderr.decode("utf-8", errors="replace")
                raise DecryptError(f"Decryption failed: {stderr}")
            return result.stdout
        except DecryptError:
            raise
        except Exception as e:
            raise DecryptError(f"Decryption failed: {e}") from e

    def recipient_ids(self, ciphertext: bytes) -> list[str]:
        """Get recipient IDs from ciphertext.

        Args:
            ciphertext: The encrypted data.

        Returns:
            List of recipient key IDs.
        """
        args = ["--list-packets", "--list-only"]

        try:
            result = self._run_gpg(args, input_data=ciphertext, check=False)
            output = result.stdout.decode("utf-8", errors="replace")
            output += result.stderr.decode("utf-8", errors="replace")

            # Parse key IDs from output
            key_ids = []
            for line in output.split("\n"):
                # Look for lines like: ":pubkey enc packet: ... keyid FEEDBEEF"
                match = re.search(r"keyid\s+([A-F0-9]+)", line, re.IGNORECASE)
                if match:
                    key_ids.append("0x" + match.group(1))

            return key_ids
        except Exception:
            return []

    def list_public_keys(self) -> list[str]:
        """List available public keys.

        Returns:
            List of public key IDs with user info.
        """
        args = ["--list-keys", "--keyid-format", "long", "--with-colons"]

        try:
            result = self._run_gpg(args, check=False)
            output = result.stdout.decode("utf-8", errors="replace")
            return self._parse_key_list(output)
        except Exception:
            return []

    def list_private_keys(self) -> list[str]:
        """List available private keys.

        Returns:
            List of private key IDs with user info.
        """
        args = ["--list-secret-keys", "--keyid-format", "long", "--with-colons"]

        try:
            result = self._run_gpg(args, check=False)
            output = result.stdout.decode("utf-8", errors="replace")
            return self._parse_key_list(output)
        except Exception:
            return []

    def _parse_key_list(self, output: str) -> list[str]:
        """Parse GPG key list output.

        Args:
            output: The --with-colons output.

        Returns:
            List of formatted key entries.
        """
        keys = []
        current_key_id = ""
        current_uid = ""

        for line in output.split("\n"):
            fields = line.split(":")

            if len(fields) >= 5:
                record_type = fields[0]

                if record_type in ("pub", "sec"):
                    # Key ID is in field 4
                    current_key_id = "0x" + fields[4] if len(fields) > 4 else ""

                elif record_type == "uid" and current_key_id:
                    # UID is in field 9
                    current_uid = fields[9] if len(fields) > 9 else ""
                    if current_key_id and current_uid:
                        keys.append(f"{current_key_id} - {current_uid}")
                        current_key_id = ""
                        current_uid = ""

        return keys

    @property
    def name(self) -> str:
        """Get the backend name."""
        return "gpg"

    @property
    def ext(self) -> str:
        """Get the file extension."""
        return ".gpg"

    @property
    def id_file(self) -> str:
        """Get the ID file name."""
        return ".gpg-id"

    def version(self) -> str | None:
        """Get the GPG version.

        Returns:
            Version string or None.
        """
        if self._version_cache:
            return self._version_cache

        try:
            result = self._run_gpg(["--version"], check=False)
            output = result.stdout.decode("utf-8", errors="replace")
            # First line usually contains version
            first_line = output.split("\n")[0]
            match = re.search(r"(\d+\.\d+\.\d+)", first_line)
            if match:
                self._version_cache = match.group(1)
                return self._version_cache
        except Exception:
            pass

        return None

    def import_key(self, key_data: bytes) -> str:
        """Import a public key.

        Args:
            key_data: The key data (ASCII armored).

        Returns:
            The imported key ID.

        Raises:
            EncryptError: If import fails.
        """
        args = ["--import"]

        try:
            result = self._run_gpg(args, input_data=key_data, check=False)
            # Parse key ID from stderr
            stderr = result.stderr.decode("utf-8", errors="replace")
            match = re.search(r"key\s+([A-F0-9]+):", stderr, re.IGNORECASE)
            if match:
                return "0x" + match.group(1)
            return ""
        except Exception as e:
            raise EncryptError(f"Key import failed: {e}") from e

    def export_key(self, key_id: str) -> bytes:
        """Export a public key.

        Args:
            key_id: The key ID to export.

        Returns:
            The key data (ASCII armored).

        Raises:
            EncryptError: If export fails.
        """
        args = ["--export", "--armor", key_id]

        try:
            result = self._run_gpg(args)
            return result.stdout
        except Exception as e:
            raise EncryptError(f"Key export failed: {e}") from e
