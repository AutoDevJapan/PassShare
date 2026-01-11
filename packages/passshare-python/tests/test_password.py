"""Tests for password generation."""

from passshare.password import (
    calculate_entropy,
    check_password_strength,
    generate_password,
)


class TestGeneratePassword:
    """Tests for password generation."""

    def test_default_length(self) -> None:
        """Test default password length."""
        password = generate_password()
        assert len(password) == 24

    def test_custom_length(self) -> None:
        """Test custom password length."""
        password = generate_password(length=16)
        assert len(password) == 16

        password = generate_password(length=32)
        assert len(password) == 32

    def test_with_symbols(self) -> None:
        """Test password with symbols."""
        # Generate multiple passwords to increase chance of symbols
        has_symbol = False
        for _ in range(10):
            password = generate_password(length=24, symbols=True)
            if any(c in "!@#$%^&*()-_=+[]{}|;:,.<>?" for c in password):
                has_symbol = True
                break
        assert has_symbol

    def test_no_symbols(self) -> None:
        """Test password without symbols."""
        password = generate_password(length=24, no_symbols=True)
        assert all(c not in "!@#$%^&*()-_=+[]{}|;:,.<>?" for c in password)

    def test_xkcd_style(self) -> None:
        """Test XKCD-style password."""
        password = generate_password(xkcd=True)
        # Should contain multiple words separated by dashes
        parts = password.split("-")
        assert len(parts) >= 2  # At least 2 words

    def test_xkcd_custom_separator(self) -> None:
        """Test XKCD-style password with custom separator."""
        password = generate_password(xkcd=True, xkcd_separator="_")
        assert "_" in password

    def test_xkcd_custom_words(self) -> None:
        """Test XKCD-style password with custom word count."""
        password = generate_password(xkcd=True, xkcd_words=6)
        parts = password.split("-")
        assert len(parts) == 6

    def test_password_is_random(self) -> None:
        """Test that passwords are random."""
        passwords = [generate_password() for _ in range(5)]
        # All should be unique
        assert len(set(passwords)) == 5

    def test_password_contains_required_chars(self) -> None:
        """Test password contains required character types."""
        password = generate_password(length=12, symbols=True)

        has_lower = any(c.islower() for c in password)
        has_upper = any(c.isupper() for c in password)
        has_digit = any(c.isdigit() for c in password)

        assert has_lower
        assert has_upper
        assert has_digit


class TestEntropy:
    """Tests for entropy calculation."""

    def test_entropy_short_password(self) -> None:
        """Test entropy for short password."""
        entropy = calculate_entropy("abc")
        assert entropy > 0
        assert entropy < 30  # Should be relatively low

    def test_entropy_long_password(self) -> None:
        """Test entropy for long password."""
        entropy = calculate_entropy("MyP@ssw0rd!123XyZ")
        assert entropy > 80  # Should be high

    def test_entropy_mixed_case(self) -> None:
        """Test entropy increases with mixed case."""
        lower_only = calculate_entropy("abcdefgh")
        mixed_case = calculate_entropy("AbCdEfGh")

        assert mixed_case > lower_only

    def test_entropy_with_symbols(self) -> None:
        """Test entropy increases with symbols."""
        no_symbols = calculate_entropy("Password123")
        with_symbols = calculate_entropy("P@ssword!23")

        assert with_symbols > no_symbols


class TestPasswordStrength:
    """Tests for password strength checking."""

    def test_weak_password(self) -> None:
        """Test weak password detection."""
        strength = check_password_strength("abc")
        assert strength["strength"] == "weak"
        assert strength["length"] == 3

    def test_fair_password(self) -> None:
        """Test fair password detection."""
        strength = check_password_strength("Password1")
        assert strength["strength"] in ["fair", "good"]

    def test_strong_password(self) -> None:
        """Test strong password detection."""
        strength = check_password_strength("MyV3ryStr0ng!P@ssw0rd#2024")
        assert strength["strength"] == "strong"

    def test_strength_contains_flags(self) -> None:
        """Test strength result contains all flags."""
        strength = check_password_strength("Test123!")

        assert "has_lowercase" in strength
        assert "has_uppercase" in strength
        assert "has_digits" in strength
        assert "has_symbols" in strength
        assert "entropy" in strength
        assert "length" in strength

    def test_strength_flags_accuracy(self) -> None:
        """Test strength flags are accurate."""
        strength = check_password_strength("Password123!")

        assert strength["has_lowercase"] is True
        assert strength["has_uppercase"] is True
        assert strength["has_digits"] is True
        assert strength["has_symbols"] is True
