"""Secret model for PassShare.

A secret consists of:
1. Password (first line)
2. Key-value data (YAML-like section between ---)
3. Body (freeform notes after second ---)
"""

from __future__ import annotations

import re


class Secret:
    """Represents a secret with password, key-value data, and notes."""

    def __init__(
        self,
        password: str = "",
        data: dict[str, str] | None = None,
        body: str = "",
    ) -> None:
        """Initialize a Secret.

        Args:
            password: The password (first line of the secret).
            data: Key-value pairs (username, url, etc.).
            body: Freeform notes.
        """
        self._password = password
        self._data: dict[str, str] = data if data is not None else {}
        self._body = body

    @property
    def password(self) -> str:
        """Get the password (first line)."""
        return self._password

    @password.setter
    def password(self, value: str) -> None:
        """Set the password."""
        self._password = value

    def get(self, key: str, default: str = "") -> str:
        """Get a value by key.

        Args:
            key: The key to look up.
            default: Default value if key not found.

        Returns:
            The value or default.
        """
        return self._data.get(key, default)

    def set(self, key: str, value: str) -> None:
        """Set a key-value pair.

        Args:
            key: The key to set.
            value: The value to set.
        """
        self._data[key] = value

    def delete(self, key: str) -> bool:
        """Delete a key-value pair.

        Args:
            key: The key to delete.

        Returns:
            True if the key was deleted, False if not found.
        """
        if key in self._data:
            del self._data[key]
            return True
        return False

    def keys(self) -> list[str]:
        """Get all keys."""
        return list(self._data.keys())

    @property
    def data(self) -> dict[str, str]:
        """Get all key-value data."""
        return self._data.copy()

    @property
    def body(self) -> str:
        """Get the freeform notes."""
        return self._body

    @body.setter
    def body(self, value: str) -> None:
        """Set the freeform notes."""
        self._body = value

    @property
    def otp_uri(self) -> str | None:
        """Get the OTP URI if present.

        Returns:
            The OTP URI or None.
        """
        for value in self._data.values():
            if value.startswith("otpauth://"):
                return value
        return None

    def otp(self) -> str | None:
        """Generate current OTP code.

        Returns:
            The OTP code (6 or 8 digits) or None if no OTP URI.
        """
        uri = self.otp_uri
        if not uri:
            return None

        try:
            import pyotp

            # Parse the URI and generate code
            totp = pyotp.parse_uri(uri)
            return totp.now()
        except Exception:
            return None

    def to_bytes(self) -> bytes:
        """Serialize the secret to bytes.

        Returns:
            UTF-8 encoded bytes.
        """
        return str(self).encode("utf-8")

    @classmethod
    def from_bytes(cls, data: bytes) -> Secret:
        """Deserialize a secret from bytes.

        Args:
            data: UTF-8 encoded bytes.

        Returns:
            A Secret instance.
        """
        return cls.parse(data.decode("utf-8"))

    @classmethod
    def parse(cls, content: str) -> Secret:
        """Parse secret content into a Secret object.

        Format:
            password-on-first-line
            ---
            key1: value1
            key2: value2
            ---
            Freeform notes here

        Args:
            content: The raw secret content.

        Returns:
            A Secret instance.
        """
        if not content:
            return cls()

        lines = content.split("\n")
        password = lines[0] if lines else ""

        data: dict[str, str] = {}
        body = ""
        in_data = False
        in_body = False
        body_lines: list[str] = []

        for line in lines[1:]:
            if line == "---":
                if not in_data and not in_body:
                    in_data = True
                elif in_data:
                    in_data = False
                    in_body = True
                continue

            if in_body:
                body_lines.append(line)
            elif in_data:
                # Check for otpauth URI first (before key:value matching)
                if line.startswith("otpauth://"):
                    data["otp"] = line
                else:
                    # Parse key: value
                    match = re.match(r"^([^:]+):\s*(.*)$", line)
                    if match:
                        key = match.group(1).strip()
                        value = match.group(2).strip()
                        data[key] = value
            else:
                # Check for otpauth URI first
                if line.startswith("otpauth://"):
                    data["otp"] = line
                else:
                    # Lines between password and first --- are also key-value
                    match = re.match(r"^([^:]+):\s*(.*)$", line)
                    if match:
                        key = match.group(1).strip()
                        value = match.group(2).strip()
                        data[key] = value

        body = "\n".join(body_lines)

        return cls(password=password, data=data, body=body)

    def __str__(self) -> str:
        """Convert to string format.

        Returns:
            The secret in standard format.
        """
        lines = [self._password]

        if self._data:
            lines.append("---")
            for key, value in self._data.items():
                lines.append(f"{key}: {value}")

        if self._body:
            if not self._data:
                lines.append("---")
            lines.append("---")
            lines.append(self._body)

        return "\n".join(lines)

    def __repr__(self) -> str:
        """Get string representation."""
        return f"Secret(password='***', data={list(self._data.keys())}, body_len={len(self._body)})"

    def __eq__(self, other: object) -> bool:
        """Check equality."""
        if not isinstance(other, Secret):
            return False
        return (
            self._password == other._password
            and self._data == other._data
            and self._body == other._body
        )
