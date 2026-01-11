"""Age crypto backend for PassShare."""

import os
import subprocess
from pathlib import Path

from passshare.crypto.base import CryptoBackend
from passshare.errors import DecryptError, EncryptError


class AgeBackend(CryptoBackend):
    """Age encryption backend."""

    def __init__(
        self,
        age_binary: str | None = None,
        identity_file: Path | None = None,
    ) -> None:
        """Initialize Age backend.

        Args:
            age_binary: Path to age binary. Uses GOPASS_AGE_BINARY env or 'age'.
            identity_file: Path to identity file. Uses default if not specified.
        """
        self._age = age_binary or os.environ.get("GOPASS_AGE_BINARY", "age")
        self._identity_file = identity_file or self._default_identity_file()
        self._version_cache: str | None = None

    def _default_identity_file(self) -> Path:
        """Get the default identity file path.

        Returns:
            Path to the identity file.
        """
        if env_file := os.environ.get("AGE_KEY_FILE"):
            return Path(env_file)

        if os.name == "nt":  # Windows
            return Path.home() / "AppData" / "Local" / "age" / "key.txt"
        else:  # Linux/macOS
            return Path.home() / ".config" / "age" / "key.txt"

    def _run_age(
        self,
        args: list[str],
        input_data: bytes | None = None,
        check: bool = True,
    ) -> subprocess.CompletedProcess[bytes]:
        """Run an age command.

        Args:
            args: Command arguments.
            input_data: Data to pass to stdin.
            check: Whether to check return code.

        Returns:
            The completed process.

        Raises:
            EncryptError/DecryptError: On failure.
        """
        cmd = [self._age] + args

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
            raise EncryptError(f"Age command failed: {stderr}") from e
        except FileNotFoundError as e:
            raise EncryptError(f"Age binary not found: {self._age}") from e

    def encrypt(self, plaintext: bytes, recipients: list[str]) -> bytes:
        """Encrypt plaintext for the given recipients.

        Args:
            plaintext: The data to encrypt.
            recipients: List of recipient public keys.

        Returns:
            The encrypted data.

        Raises:
            EncryptError: If encryption fails.
        """
        if not recipients:
            raise EncryptError("No recipients specified")

        args = ["--encrypt", "--armor"]
        for recipient in recipients:
            args.extend(["--recipient", recipient])

        try:
            result = self._run_age(args, input_data=plaintext)
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
        args = ["--decrypt", "--identity", str(self._identity_file)]

        try:
            result = self._run_age(args, input_data=ciphertext, check=False)
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

        Note: Age doesn't expose recipient info from ciphertext.

        Args:
            ciphertext: The encrypted data.

        Returns:
            Empty list (age doesn't support this).
        """
        return []

    def list_public_keys(self) -> list[str]:
        """List available public keys.

        Returns:
            List containing the public key from identity file.
        """
        keys = []

        if self._identity_file.exists():
            try:
                content = self._identity_file.read_text(encoding="utf-8")
                for line in content.split("\n"):
                    line = line.strip()
                    # Extract public key from comment
                    if line.startswith("# public key:"):
                        public_key = line.split(":", 1)[1].strip()
                        keys.append(public_key)
            except Exception:
                pass

        return keys

    def list_private_keys(self) -> list[str]:
        """List available private keys.

        Returns:
            List of identity files.
        """
        if self._identity_file.exists():
            return [str(self._identity_file)]
        return []

    @property
    def name(self) -> str:
        """Get the backend name."""
        return "age"

    @property
    def ext(self) -> str:
        """Get the file extension."""
        return ".age"

    @property
    def id_file(self) -> str:
        """Get the ID file name."""
        return ".age-recipients"

    def version(self) -> str | None:
        """Get the age version.

        Returns:
            Version string or None.
        """
        if self._version_cache:
            return self._version_cache

        try:
            result = self._run_age(["--version"], check=False)
            output = result.stdout.decode("utf-8", errors="replace")
            # Parse version from output
            if output.strip():
                self._version_cache = output.strip().split()[-1]
                return self._version_cache
        except Exception:
            pass

        return None

    def generate_key(self, output_path: Path | None = None) -> tuple[str, str]:
        """Generate a new key pair.

        Args:
            output_path: Path to save the private key. Uses default if not specified.

        Returns:
            Tuple of (public_key, private_key_path).

        Raises:
            EncryptError: If key generation fails.
        """
        output_file = output_path or self._identity_file

        try:
            # Run age-keygen
            keygen = self._age.replace("age", "age-keygen")
            result = subprocess.run(
                [keygen, "-o", str(output_file)],
                capture_output=True,
                check=True,
            )

            # Extract public key from stderr (age-keygen prints it there)
            stderr = result.stderr.decode("utf-8", errors="replace")
            for line in stderr.split("\n"):
                if line.startswith("Public key:"):
                    public_key = line.split(":", 1)[1].strip()
                    return (public_key, str(output_file))

            # Also check stdout
            stdout = result.stdout.decode("utf-8", errors="replace")
            if stdout.startswith("age1"):
                return (stdout.strip(), str(output_file))

            raise EncryptError("Could not extract public key")

        except subprocess.CalledProcessError as e:
            stderr = e.stderr.decode("utf-8", errors="replace") if e.stderr else ""
            raise EncryptError(f"Key generation failed: {stderr}") from e
        except FileNotFoundError as e:
            raise EncryptError("age-keygen binary not found") from e
