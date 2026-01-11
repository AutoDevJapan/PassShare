"""OTP (One-Time Password) utilities for PassShare."""

from __future__ import annotations

import base64
import hashlib
import hmac
import struct
import time
from typing import Optional, Union
from urllib.parse import parse_qs, urlparse


class TOTP:
    """Time-based One-Time Password (RFC 6238)."""

    def __init__(
        self,
        secret: str,
        digits: int = 6,
        period: int = 30,
        algorithm: str = "SHA1",
    ) -> None:
        """Initialize TOTP.

        Args:
            secret: Base32-encoded secret.
            digits: Number of digits (6 or 8).
            period: Time step in seconds.
            algorithm: Hash algorithm (SHA1, SHA256, SHA512).
        """
        self.secret = secret
        self.digits = digits
        self.period = period
        self.algorithm = algorithm.upper()

    def _get_hash_func(self):
        """Get the hash function."""
        if self.algorithm == "SHA256":
            return hashlib.sha256
        elif self.algorithm == "SHA512":
            return hashlib.sha512
        else:
            return hashlib.sha1

    def _decode_secret(self) -> bytes:
        """Decode the base32 secret."""
        # Add padding if needed
        secret = self.secret.upper().replace(" ", "")
        padding = (8 - len(secret) % 8) % 8
        secret += "=" * padding
        return base64.b32decode(secret)

    def generate(self, timestamp: Optional[int] = None) -> str:
        """Generate current TOTP code.

        Args:
            timestamp: Unix timestamp (uses current time if not specified).

        Returns:
            The OTP code as a string.
        """
        if timestamp is None:
            timestamp = int(time.time())

        # Calculate time counter
        counter = timestamp // self.period

        return self._generate_hotp(counter)

    def _generate_hotp(self, counter: int) -> str:
        """Generate HOTP code for a counter.

        Args:
            counter: The counter value.

        Returns:
            The OTP code.
        """
        # Pack counter as 8-byte big-endian
        counter_bytes = struct.pack(">Q", counter)

        # Calculate HMAC
        key = self._decode_secret()
        hash_func = self._get_hash_func()
        mac = hmac.new(key, counter_bytes, hash_func).digest()

        # Dynamic truncation
        offset = mac[-1] & 0x0F
        code = struct.unpack(">I", mac[offset : offset + 4])[0]
        code &= 0x7FFFFFFF

        # Get the right number of digits
        code %= 10**self.digits

        return str(code).zfill(self.digits)

    def verify(self, code: str, window: int = 1) -> bool:
        """Verify a TOTP code.

        Args:
            code: The code to verify.
            window: Number of periods to check before/after.

        Returns:
            True if the code is valid.
        """
        timestamp = int(time.time())

        for offset in range(-window, window + 1):
            check_time = timestamp + (offset * self.period)
            if self.generate(check_time) == code:
                return True

        return False

    @property
    def remaining_seconds(self) -> int:
        """Get remaining seconds until code expires.

        Returns:
            Seconds until next period.
        """
        return self.period - (int(time.time()) % self.period)


class HOTP:
    """HMAC-based One-Time Password (RFC 4226)."""

    def __init__(
        self,
        secret: str,
        digits: int = 6,
        counter: int = 0,
        algorithm: str = "SHA1",
    ) -> None:
        """Initialize HOTP.

        Args:
            secret: Base32-encoded secret.
            digits: Number of digits (6 or 8).
            counter: Initial counter value.
            algorithm: Hash algorithm.
        """
        self.secret = secret
        self.digits = digits
        self.counter = counter
        self.algorithm = algorithm.upper()
        self._totp = TOTP(secret, digits, 1, algorithm)

    def generate(self) -> str:
        """Generate current HOTP code.

        Returns:
            The OTP code.
        """
        code = self._totp._generate_hotp(self.counter)
        return code

    def verify(self, code: str, window: int = 10) -> bool:
        """Verify an HOTP code.

        Args:
            code: The code to verify.
            window: Number of counters to check ahead.

        Returns:
            True if the code is valid.
        """
        for offset in range(window):
            check_counter = self.counter + offset
            temp_totp = TOTP(self.secret, self.digits, 1, self.algorithm)
            if temp_totp._generate_hotp(check_counter) == code:
                self.counter = check_counter + 1
                return True

        return False


def parse_otp_uri(uri: str) -> Union[TOTP, HOTP]:
    """Parse an OTP URI and return the appropriate OTP object.

    Args:
        uri: The otpauth:// URI.

    Returns:
        TOTP or HOTP object.

    Raises:
        ValueError: If the URI is invalid.
    """
    parsed = urlparse(uri)

    if parsed.scheme != "otpauth":
        raise ValueError(f"Invalid OTP URI scheme: {parsed.scheme}")

    otp_type = parsed.netloc.lower()
    if otp_type not in ("totp", "hotp"):
        raise ValueError(f"Invalid OTP type: {otp_type}")

    # Parse query parameters
    params = parse_qs(parsed.query)

    secret = params.get("secret", [""])[0]
    if not secret:
        raise ValueError("Missing secret in OTP URI")

    digits = int(params.get("digits", ["6"])[0])
    algorithm = params.get("algorithm", ["SHA1"])[0]

    if otp_type == "totp":
        period = int(params.get("period", ["30"])[0])
        return TOTP(secret, digits, period, algorithm)
    else:
        counter = int(params.get("counter", ["0"])[0])
        return HOTP(secret, digits, counter, algorithm)


def generate_otp_uri(
    secret: str,
    issuer: str,
    account: str,
    otp_type: str = "totp",
    digits: int = 6,
    period: int = 30,
    algorithm: str = "SHA1",
    counter: int = 0,
) -> str:
    """Generate an OTP URI.

    Args:
        secret: Base32-encoded secret.
        issuer: The issuer name.
        account: The account name.
        otp_type: 'totp' or 'hotp'.
        digits: Number of digits.
        period: TOTP period (ignored for HOTP).
        algorithm: Hash algorithm.
        counter: HOTP counter (ignored for TOTP).

    Returns:
        The OTP URI.
    """
    from urllib.parse import quote

    label = f"{quote(issuer)}:{quote(account)}"
    params = f"secret={secret}&issuer={quote(issuer)}"

    if digits != 6:
        params += f"&digits={digits}"

    if algorithm != "SHA1":
        params += f"&algorithm={algorithm}"

    if otp_type == "totp" and period != 30:
        params += f"&period={period}"
    elif otp_type == "hotp":
        params += f"&counter={counter}"

    return f"otpauth://{otp_type}/{label}?{params}"
