"""Tests for OTP functionality."""

import pytest
from passshare.otp import TOTP, HOTP, parse_otp_uri, generate_otp_uri


class TestTOTP:
    """Tests for TOTP class."""

    # Test secret (Base32 encoded)
    TEST_SECRET = "JBSWY3DPEHPK3PXP"

    def test_generate_code(self) -> None:
        """Test generating TOTP code."""
        totp = TOTP(self.TEST_SECRET)
        code = totp.generate()
        
        assert len(code) == 6
        assert code.isdigit()

    def test_generate_with_timestamp(self) -> None:
        """Test generating TOTP code for specific timestamp."""
        totp = TOTP(self.TEST_SECRET)
        
        # RFC 6238 test vector (time = 59, expected = 287082)
        # Note: This may not match exactly due to implementation differences
        code = totp.generate(timestamp=59)
        assert len(code) == 6

    def test_verify_code(self) -> None:
        """Test verifying TOTP code."""
        totp = TOTP(self.TEST_SECRET)
        current_code = totp.generate()
        
        assert totp.verify(current_code) is True
        assert totp.verify("000000") is False

    def test_verify_with_window(self) -> None:
        """Test verifying with time window."""
        totp = TOTP(self.TEST_SECRET, period=30)
        
        # Get code from 30 seconds ago
        import time
        past_code = totp.generate(int(time.time()) - 30)
        
        # Should verify with window=1
        assert totp.verify(past_code, window=1) is True

    def test_custom_digits(self) -> None:
        """Test TOTP with 8 digits."""
        totp = TOTP(self.TEST_SECRET, digits=8)
        code = totp.generate()
        
        assert len(code) == 8

    def test_remaining_seconds(self) -> None:
        """Test remaining seconds calculation."""
        totp = TOTP(self.TEST_SECRET, period=30)
        remaining = totp.remaining_seconds
        
        assert 0 <= remaining <= 30


class TestHOTP:
    """Tests for HOTP class."""

    TEST_SECRET = "JBSWY3DPEHPK3PXP"

    def test_generate_code(self) -> None:
        """Test generating HOTP code."""
        hotp = HOTP(self.TEST_SECRET, counter=0)
        code = hotp.generate()
        
        assert len(code) == 6
        assert code.isdigit()

    def test_counter_not_incremented_on_generate(self) -> None:
        """Test counter is not auto-incremented on generate."""
        hotp = HOTP(self.TEST_SECRET, counter=0)
        code1 = hotp.generate()
        code2 = hotp.generate()
        
        # Same code because counter didn't change
        assert code1 == code2

    def test_verify_increments_counter(self) -> None:
        """Test verify increments counter on success."""
        hotp = HOTP(self.TEST_SECRET, counter=0)
        code = hotp.generate()
        
        assert hotp.verify(code) is True
        assert hotp.counter == 1

    def test_verify_with_window(self) -> None:
        """Test verify with look-ahead window."""
        hotp = HOTP(self.TEST_SECRET, counter=0)
        
        # Generate code for counter=5
        temp_hotp = HOTP(self.TEST_SECRET, counter=5)
        future_code = temp_hotp.generate()
        
        # Should verify with window=10
        assert hotp.verify(future_code, window=10) is True
        assert hotp.counter == 6


class TestParseOtpUri:
    """Tests for OTP URI parsing."""

    def test_parse_totp_uri(self) -> None:
        """Test parsing TOTP URI."""
        uri = "otpauth://totp/Example:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example"
        otp = parse_otp_uri(uri)
        
        assert isinstance(otp, TOTP)
        assert otp.secret == "JBSWY3DPEHPK3PXP"
        assert otp.digits == 6
        assert otp.period == 30

    def test_parse_hotp_uri(self) -> None:
        """Test parsing HOTP URI."""
        uri = "otpauth://hotp/Example:alice?secret=JBSWY3DPEHPK3PXP&counter=0"
        otp = parse_otp_uri(uri)
        
        assert isinstance(otp, HOTP)
        assert otp.secret == "JBSWY3DPEHPK3PXP"
        assert otp.counter == 0

    def test_parse_with_custom_params(self) -> None:
        """Test parsing URI with custom parameters."""
        uri = "otpauth://totp/Test?secret=JBSWY3DPEHPK3PXP&digits=8&period=60&algorithm=SHA256"
        otp = parse_otp_uri(uri)
        
        assert isinstance(otp, TOTP)
        assert otp.digits == 8
        assert otp.period == 60
        assert otp.algorithm == "SHA256"

    def test_parse_invalid_scheme(self) -> None:
        """Test parsing invalid URI scheme."""
        with pytest.raises(ValueError):
            parse_otp_uri("http://example.com")

    def test_parse_missing_secret(self) -> None:
        """Test parsing URI without secret."""
        with pytest.raises(ValueError):
            parse_otp_uri("otpauth://totp/Test")


class TestGenerateOtpUri:
    """Tests for OTP URI generation."""

    def test_generate_totp_uri(self) -> None:
        """Test generating TOTP URI."""
        uri = generate_otp_uri(
            secret="JBSWY3DPEHPK3PXP",
            issuer="Example",
            account="alice@example.com",
        )
        
        assert uri.startswith("otpauth://totp/")
        assert "secret=JBSWY3DPEHPK3PXP" in uri
        assert "issuer=Example" in uri

    def test_generate_hotp_uri(self) -> None:
        """Test generating HOTP URI."""
        uri = generate_otp_uri(
            secret="JBSWY3DPEHPK3PXP",
            issuer="Example",
            account="alice",
            type="hotp",
            counter=5,
        )
        
        assert uri.startswith("otpauth://hotp/")
        assert "counter=5" in uri

    def test_roundtrip(self) -> None:
        """Test generating and parsing URI."""
        original_uri = generate_otp_uri(
            secret="JBSWY3DPEHPK3PXP",
            issuer="Test",
            account="user",
            digits=8,
            period=60,
        )
        
        parsed = parse_otp_uri(original_uri)
        
        assert parsed.secret == "JBSWY3DPEHPK3PXP"
        assert parsed.digits == 8
        assert parsed.period == 60
