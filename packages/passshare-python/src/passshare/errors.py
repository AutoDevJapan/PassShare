"""PassShare error classes."""



class PassShareError(Exception):
    """Base exception for PassShare."""

    pass


class NotFoundError(PassShareError):
    """Secret not found."""

    def __init__(self, name: str) -> None:
        self.name = name
        super().__init__(f"Secret not found: {name}")


class DecryptError(PassShareError):
    """Decryption failed."""

    def __init__(self, message: str = "Decryption failed") -> None:
        super().__init__(message)


class EncryptError(PassShareError):
    """Encryption failed."""

    def __init__(self, message: str = "Encryption failed") -> None:
        super().__init__(message)


class StorageError(PassShareError):
    """Storage operation failed."""

    def __init__(self, message: str, path: str | None = None) -> None:
        self.path = path
        super().__init__(message)


class ConfigError(PassShareError):
    """Configuration error."""

    def __init__(self, message: str) -> None:
        super().__init__(message)


class NotInitializedError(PassShareError):
    """Store not initialized."""

    def __init__(self, store_path: str | None = None) -> None:
        self.store_path = store_path
        message = "Store not initialized"
        if store_path:
            message = f"Store not initialized: {store_path}"
        super().__init__(message)


class GitError(PassShareError):
    """Git operation failed."""

    def __init__(self, message: str, command: str | None = None) -> None:
        self.command = command
        super().__init__(message)


class RecipientError(PassShareError):
    """Recipient management error."""

    def __init__(self, message: str, key_id: str | None = None) -> None:
        self.key_id = key_id
        super().__init__(message)
