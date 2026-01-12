"""Have I Been Pwned (HIBP) integration for PassShare.

Uses the k-anonymity API to check if passwords have been compromised
without sending the full password hash.

API: https://haveibeenpwned.com/API/v3#PwnedPasswords

© 2026 BM1314 Inc. All rights reserved.
"""

from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

if TYPE_CHECKING:
    pass

HIBP_API_BASE = "https://api.pwnedpasswords.com/range/"


@dataclass
class HIBPCheckResult:
    """Result of a HIBP password check."""

    pwned: bool
    """Whether the password was found in breaches."""

    count: int
    """Number of times the password appeared in breaches (0 if not found)."""


@dataclass
class HIBPBatchResult:
    """Result of checking a password in a batch."""

    name: str
    """Password identifier."""

    result: HIBPCheckResult
    """Check result."""

    error: str | None = None
    """Any error that occurred."""


def check_password(password: str) -> HIBPCheckResult:
    """Check if a password has been compromised using HIBP k-anonymity API.

    This method is privacy-preserving:
    1. SHA-1 hash the password
    2. Send only the first 5 characters of the hash
    3. HIBP returns all hashes starting with those 5 chars
    4. We check locally if our full hash is in the list

    Args:
        password: The password to check.

    Returns:
        Check result with pwned status and count.

    Raises:
        Exception: If the API request fails.
    """
    # Hash the password using SHA-1
    hash_value = hashlib.sha1(password.encode("utf-8")).hexdigest().upper()

    # Split into prefix (first 5 chars) and suffix (rest)
    prefix = hash_value[:5]
    suffix = hash_value[5:]

    try:
        # Fetch matching hashes from HIBP
        request = Request(
            f"{HIBP_API_BASE}{prefix}",
            headers={
                "User-Agent": "PassShare/1.0",
                "Add-Padding": "true",  # Request padding to prevent timing attacks
            },
        )

        with urlopen(request, timeout=10) as response:
            text = response.read().decode("utf-8")

        # Parse response - format: SUFFIX:COUNT
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue

            parts = line.split(":")
            if len(parts) >= 2:
                hash_suffix = parts[0].upper()
                count_str = parts[1]

                if hash_suffix == suffix:
                    return HIBPCheckResult(
                        pwned=True,
                        count=int(count_str),
                    )

        # Not found in breaches
        return HIBPCheckResult(pwned=False, count=0)

    except HTTPError as e:
        if e.code == 429:
            raise Exception("Rate limited by HIBP API. Please try again later.") from e
        raise Exception(f"HIBP API error: {e.code}") from e
    except URLError as e:
        raise Exception(f"Failed to connect to HIBP API: {e}") from e


def check_passwords_batch(
    passwords: list[tuple[str, str]],
    delay_ms: int = 100,
) -> list[HIBPBatchResult]:
    """Check multiple passwords with rate limiting.

    Args:
        passwords: List of (name, password) tuples.
        delay_ms: Delay between requests to avoid rate limiting (default: 100ms).

    Returns:
        List of results.
    """
    results: list[HIBPBatchResult] = []

    for i, (name, password) in enumerate(passwords):
        try:
            result = check_password(password)
            results.append(HIBPBatchResult(name=name, result=result))
        except Exception as e:
            results.append(
                HIBPBatchResult(
                    name=name,
                    result=HIBPCheckResult(pwned=False, count=0),
                    error=str(e),
                )
            )

        # Delay between requests (except for the last one)
        if i < len(passwords) - 1 and delay_ms > 0:
            time.sleep(delay_ms / 1000.0)

    return results


def check_email(email: str, api_key: str) -> list[str]:
    """Check if an email has been in any known breaches.

    Note: This requires an HIBP API key for the breached accounts API.

    Args:
        email: The email to check.
        api_key: HIBP API key.

    Returns:
        List of breach names.

    Raises:
        Exception: If the API request fails.
    """
    import json
    from urllib.parse import quote

    url = f"https://haveibeenpwned.com/api/v3/breachedaccount/{quote(email)}"

    try:
        request = Request(
            url,
            headers={
                "hibp-api-key": api_key,
                "User-Agent": "PassShare/1.0",
            },
        )

        with urlopen(request, timeout=10) as response:
            data = json.loads(response.read().decode("utf-8"))
            return [breach.get("Name", "") for breach in data]

    except HTTPError as e:
        if e.code == 404:
            # Not found - email not in any breaches
            return []
        if e.code == 401:
            raise Exception("Invalid HIBP API key") from e
        if e.code == 429:
            raise Exception("Rate limited by HIBP API. Please try again later.") from e
        raise Exception(f"HIBP API error: {e.code}") from e
    except URLError as e:
        raise Exception(f"Failed to connect to HIBP API: {e}") from e


def format_pwned_count(count: int) -> str:
    """Format the HIBP count for display.

    Args:
        count: The count to format.

    Returns:
        Formatted string.
    """
    if count == 0:
        return "0"
    if count >= 1_000_000:
        return f"{count / 1_000_000:.1f}M"
    if count >= 1_000:
        return f"{count / 1_000:.1f}K"
    return str(count)
