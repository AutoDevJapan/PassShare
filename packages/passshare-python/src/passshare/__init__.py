"""PassShare - A gopass-compatible password manager for teams and individuals.

© 2026 株式会社BM1314. All rights reserved.
"""

from passshare.errors import (
    ConfigError,
    DecryptError,
    EncryptError,
    NotFoundError,
    NotInitializedError,
    PassShareError,
    StorageError,
)
from passshare.gopass import Gopass
from passshare.password import generate_password
from passshare.secret import Secret

__version__ = "1.0.0"
__author__ = "BM1314"
__all__ = [
    "Gopass",
    "Secret",
    "PassShareError",
    "NotFoundError",
    "DecryptError",
    "EncryptError",
    "StorageError",
    "ConfigError",
    "NotInitializedError",
    "generate_password",
]
