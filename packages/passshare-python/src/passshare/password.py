"""Password generation for PassShare."""

import secrets
import string

# Character sets for password generation
LOWERCASE = string.ascii_lowercase
UPPERCASE = string.ascii_uppercase
DIGITS = string.digits
SYMBOLS = "!@#$%^&*()-_=+[]{}|;:,.<>?"

# Word list for XKCD-style passwords (subset for demonstration)
WORD_LIST_EN = [
    "correct", "horse", "battery", "staple", "apple", "banana", "cherry", "dragon",
    "elephant", "falcon", "guitar", "hammer", "island", "jungle", "kingdom", "lemon",
    "mountain", "noble", "ocean", "piano", "queen", "river", "sunset", "tiger",
    "umbrella", "valley", "wizard", "xenon", "yellow", "zebra", "anchor", "bridge",
    "castle", "diamond", "eagle", "forest", "garden", "harbor", "iceberg", "jacket",
    "knight", "lantern", "marble", "needle", "orange", "penguin", "quartz", "rocket",
    "silver", "thunder", "unicorn", "violet", "window", "crystal", "dolphin", "empire",
    "fountain", "glacier", "horizon", "ivory", "jasmine", "koala", "lighthouse", "meteor",
]


def generate_password(
    length: int = 24,
    symbols: bool = True,
    no_symbols: bool = False,
    xkcd: bool = False,
    xkcd_separator: str = "-",
    xkcd_lang: str = "en",
    xkcd_words: int | None = None,
) -> str:
    """Generate a random password.

    Args:
        length: Password length (characters or words for XKCD).
        symbols: Include symbols in the password.
        no_symbols: Exclude symbols (overrides symbols=True).
        xkcd: Generate XKCD-style password (word-based).
        xkcd_separator: Separator for XKCD words.
        xkcd_lang: Language for word list (currently only 'en').
        xkcd_words: Number of words for XKCD (defaults to 4).

    Returns:
        The generated password.
    """
    if xkcd:
        return _generate_xkcd_password(
            num_words=xkcd_words or 4,
            separator=xkcd_separator,
            lang=xkcd_lang,
        )

    return _generate_random_password(
        length=length,
        use_symbols=symbols and not no_symbols,
    )


def _generate_random_password(length: int, use_symbols: bool) -> str:
    """Generate a random character-based password.

    Args:
        length: Password length.
        use_symbols: Whether to include symbols.

    Returns:
        The generated password.
    """
    charset = LOWERCASE + UPPERCASE + DIGITS
    if use_symbols:
        charset += SYMBOLS

    # Ensure at least one of each required character type
    password_chars = []

    if length >= 4:
        password_chars.append(secrets.choice(LOWERCASE))
        password_chars.append(secrets.choice(UPPERCASE))
        password_chars.append(secrets.choice(DIGITS))
        if use_symbols:
            password_chars.append(secrets.choice(SYMBOLS))

        remaining_length = length - len(password_chars)
        password_chars.extend(secrets.choice(charset) for _ in range(remaining_length))

        # Shuffle to avoid predictable positions
        password_list = list(password_chars)
        secrets.SystemRandom().shuffle(password_list)
        return "".join(password_list)
    else:
        return "".join(secrets.choice(charset) for _ in range(length))


def _generate_xkcd_password(
    num_words: int = 4,
    separator: str = "-",
    lang: str = "en",
) -> str:
    """Generate an XKCD-style password.

    Args:
        num_words: Number of words.
        separator: Word separator.
        lang: Language for word list.

    Returns:
        The generated password.
    """
    # Currently only English is supported
    word_list = WORD_LIST_EN

    words = [secrets.choice(word_list) for _ in range(num_words)]
    return separator.join(words)


def calculate_entropy(password: str) -> float:
    """Calculate the entropy of a password.

    Args:
        password: The password to analyze.

    Returns:
        Entropy in bits.
    """
    import math

    # Determine charset size
    charset_size = 0
    has_lower = any(c in LOWERCASE for c in password)
    has_upper = any(c in UPPERCASE for c in password)
    has_digit = any(c in DIGITS for c in password)
    has_symbol = any(c in SYMBOLS for c in password)

    if has_lower:
        charset_size += len(LOWERCASE)
    if has_upper:
        charset_size += len(UPPERCASE)
    if has_digit:
        charset_size += len(DIGITS)
    if has_symbol:
        charset_size += len(SYMBOLS)

    if charset_size == 0:
        return 0.0

    return len(password) * math.log2(charset_size)


def check_password_strength(password: str) -> dict[str, any]:
    """Check password strength.

    Args:
        password: The password to check.

    Returns:
        A dict with strength analysis.
    """
    entropy = calculate_entropy(password)
    length = len(password)

    # Determine strength level
    if entropy >= 80:
        strength = "strong"
    elif entropy >= 60:
        strength = "good"
    elif entropy >= 40:
        strength = "fair"
    else:
        strength = "weak"

    return {
        "length": length,
        "entropy": entropy,
        "strength": strength,
        "has_lowercase": any(c in LOWERCASE for c in password),
        "has_uppercase": any(c in UPPERCASE for c in password),
        "has_digits": any(c in DIGITS for c in password),
        "has_symbols": any(c in SYMBOLS for c in password),
    }
