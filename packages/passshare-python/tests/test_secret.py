"""Tests for Secret class."""

from passshare.secret import Secret


class TestSecret:
    """Tests for Secret class."""

    def test_empty_secret(self) -> None:
        """Test creating an empty secret."""
        secret = Secret()
        assert secret.password == ""
        assert secret.keys() == []
        assert secret.body == ""

    def test_password_only(self) -> None:
        """Test creating a secret with password only."""
        secret = Secret(password="my-secret-password")
        assert secret.password == "my-secret-password"
        assert str(secret) == "my-secret-password"

    def test_with_data(self) -> None:
        """Test creating a secret with key-value data."""
        secret = Secret(
            password="password123",
            data={"username": "john", "url": "https://example.com"},
        )
        assert secret.password == "password123"
        assert secret.get("username") == "john"
        assert secret.get("url") == "https://example.com"
        assert secret.get("missing", "default") == "default"

    def test_with_body(self) -> None:
        """Test creating a secret with body."""
        secret = Secret(
            password="password123",
            body="Additional notes here",
        )
        assert secret.password == "password123"
        assert secret.body == "Additional notes here"

    def test_parse_simple(self) -> None:
        """Test parsing simple secret format."""
        content = "my-password"
        secret = Secret.parse(content)
        assert secret.password == "my-password"

    def test_parse_with_data(self) -> None:
        """Test parsing secret with key-value data."""
        content = """my-password
---
username: john@example.com
url: https://example.com
---
"""
        secret = Secret.parse(content)
        assert secret.password == "my-password"
        assert secret.get("username") == "john@example.com"
        assert secret.get("url") == "https://example.com"

    def test_parse_with_body(self) -> None:
        """Test parsing secret with body."""
        content = """my-password
---
username: john
---
Additional notes
Multiple lines
"""
        secret = Secret.parse(content)
        assert secret.password == "my-password"
        assert secret.get("username") == "john"
        assert "Additional notes" in secret.body
        assert "Multiple lines" in secret.body

    def test_parse_otp(self) -> None:
        """Test parsing secret with OTP URI."""
        content = """my-password
---
otpauth://totp/Example:alice?secret=JBSWY3DPEHPK3PXP&issuer=Example
---
"""
        secret = Secret.parse(content)
        assert secret.otp_uri is not None
        assert "otpauth://totp" in secret.otp_uri

    def test_set_and_delete(self) -> None:
        """Test setting and deleting key-value pairs."""
        secret = Secret(password="password")

        secret.set("key1", "value1")
        assert secret.get("key1") == "value1"

        result = secret.delete("key1")
        assert result is True
        assert secret.get("key1") == ""

        result = secret.delete("nonexistent")
        assert result is False

    def test_to_string(self) -> None:
        """Test converting secret to string."""
        secret = Secret(
            password="password123",
            data={"username": "john"},
            body="Notes",
        )
        output = str(secret)
        assert "password123" in output
        assert "username: john" in output
        assert "Notes" in output

    def test_to_bytes_from_bytes(self) -> None:
        """Test serialization and deserialization."""
        original = Secret(
            password="password123",
            data={"key": "value"},
            body="Body text",
        )

        data = original.to_bytes()
        restored = Secret.from_bytes(data)

        assert restored.password == original.password
        assert restored.get("key") == original.get("key")
        assert restored.body == original.body

    def test_equality(self) -> None:
        """Test secret equality."""
        secret1 = Secret(password="pass", data={"key": "value"})
        secret2 = Secret(password="pass", data={"key": "value"})
        secret3 = Secret(password="different")

        assert secret1 == secret2
        assert secret1 != secret3

    def test_keys(self) -> None:
        """Test getting all keys."""
        secret = Secret(
            password="pass",
            data={"key1": "value1", "key2": "value2"},
        )
        keys = secret.keys()
        assert "key1" in keys
        assert "key2" in keys
        assert len(keys) == 2

    def test_data_property(self) -> None:
        """Test data property returns a copy."""
        secret = Secret(password="pass", data={"key": "value"})
        data = secret.data
        data["new_key"] = "new_value"

        # Original should not be affected
        assert secret.get("new_key") == ""
