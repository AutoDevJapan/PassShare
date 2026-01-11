"""PassShare - A gopass-compatible password manager for teams and individuals.

© 2026 BM1314 Inc. All rights reserved.
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
from passshare.importer import (
    ImportResult,
    ImportSource,
    Importer,
    import_1password,
    import_bitwarden,
    import_keepass,
    import_lastpass,
    import_pass,
)
from passshare.password import generate_password
from passshare.secret import Secret

__version__ = "1.0.0"
__author__ = "BM1314"
__all__ = [
    # Core
    "Gopass",
    "Secret",
    # Errors
    "PassShareError",
    "NotFoundError",
    "DecryptError",
    "EncryptError",
    "StorageError",
    "ConfigError",
    "NotInitializedError",
    # Utilities
    "generate_password",
    # Import
    "Importer",
    "ImportSource",
    "ImportResult",
    "import_1password",
    "import_bitwarden",
    "import_pass",
    "import_lastpass",
    "import_keepass",
]
