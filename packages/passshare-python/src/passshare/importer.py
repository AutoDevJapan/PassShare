"""Import functionality for migrating from other password managers.

Supports importing from:
- 1Password (CSV export)
- Bitwarden (JSON/CSV export)
- pass/gopass (directory structure)

© 2026 BM1314 Inc. All rights reserved.
"""

from __future__ import annotations

import csv
import json
from dataclasses import dataclass
from enum import Enum
from io import StringIO
from pathlib import Path
from typing import TYPE_CHECKING

from passshare.secret import Secret

if TYPE_CHECKING:
    from passshare.store import Store


class ImportSource(Enum):
    """Supported import sources."""

    ONEPASSWORD = "1password"
    BITWARDEN = "bitwarden"
    PASS = "pass"
    GOPASS = "gopass"
    LASTPASS = "lastpass"
    KEEPASS = "keepass"


@dataclass
class ImportResult:
    """Result of an import operation."""

    total: int = 0
    imported: int = 0
    skipped: int = 0
    errors: list[str] | None = None

    def __post_init__(self) -> None:
        if self.errors is None:
            self.errors = []


class Importer:
    """Import passwords from other password managers."""

    def __init__(self, store: Store) -> None:
        """Initialize the importer.

        Args:
            store: The target PassShare store.
        """
        self._store = store

    def import_from(
        self,
        source: ImportSource,
        data: str | Path,
        prefix: str = "",
        overwrite: bool = False,
    ) -> ImportResult:
        """Import passwords from a source.

        Args:
            source: The source password manager.
            data: The export data (file path or content string).
            prefix: Optional prefix for imported entries.
            overwrite: Whether to overwrite existing entries.

        Returns:
            Import result with statistics.
        """
        # Read data if it's a file path
        content = self._read_data(data)

        # Dispatch to appropriate importer
        if source == ImportSource.ONEPASSWORD:
            return self._import_1password(content, prefix, overwrite)
        elif source == ImportSource.BITWARDEN:
            return self._import_bitwarden(content, prefix, overwrite)
        elif source in (ImportSource.PASS, ImportSource.GOPASS):
            if isinstance(data, Path):
                return self._import_pass(data, prefix, overwrite)
            else:
                raise ValueError("pass/gopass import requires a directory path")
        elif source == ImportSource.LASTPASS:
            return self._import_lastpass(content, prefix, overwrite)
        elif source == ImportSource.KEEPASS:
            return self._import_keepass(content, prefix, overwrite)
        else:
            raise ValueError(f"Unsupported import source: {source}")

    def _read_data(self, data: str | Path) -> str:
        """Read data from file or return as-is."""
        if isinstance(data, Path):
            if data.is_file():
                return data.read_text(encoding="utf-8")
            elif data.is_dir():
                return ""  # Directory-based import
            else:
                raise FileNotFoundError(f"File not found: {data}")
        return data

    def _import_1password(
        self, content: str, prefix: str, overwrite: bool
    ) -> ImportResult:
        """Import from 1Password CSV export.

        1Password CSV format:
        Title,Username,Password,URL,Notes,Type,...
        """
        result = ImportResult()

        try:
            reader = csv.DictReader(StringIO(content))

            for row in reader:
                result.total += 1

                try:
                    # Extract fields (1Password uses various column names)
                    title = row.get("Title") or row.get("title") or row.get("name") or ""
                    username = row.get("Username") or row.get("username") or row.get("login") or ""
                    password = row.get("Password") or row.get("password") or ""
                    url = row.get("URL") or row.get("url") or row.get("website") or ""
                    notes = row.get("Notes") or row.get("notes") or row.get("notesPlain") or ""
                    item_type = row.get("Type") or row.get("type") or "login"

                    if not title:
                        result.skipped += 1
                        continue

                    # Build entry name
                    name = self._build_name(title, url, prefix)

                    # Check if exists
                    if self._store.exists(name) and not overwrite:
                        result.skipped += 1
                        continue

                    # Create secret
                    secret = Secret(password=password)
                    if username:
                        secret.set("username", username)
                        secret.set("login", username)  # Alias
                    if url:
                        secret.set("url", url)
                    if notes:
                        secret.set("notes", notes)
                    if item_type:
                        secret.set("type", item_type)

                    # Save
                    self._store.set(name, secret)
                    result.imported += 1

                except Exception as e:
                    result.errors.append(f"Error importing '{title}': {e}")

        except csv.Error as e:
            result.errors.append(f"CSV parse error: {e}")

        return result

    def _import_bitwarden(
        self, content: str, prefix: str, overwrite: bool
    ) -> ImportResult:
        """Import from Bitwarden JSON or CSV export.

        Bitwarden JSON format:
        {
            "items": [
                {
                    "name": "...",
                    "login": {"username": "...", "password": "...", "uris": [...]},
                    "notes": "...",
                    "type": 1
                }
            ]
        }
        """
        result = ImportResult()

        # Try JSON first, then CSV
        try:
            data = json.loads(content)
            return self._import_bitwarden_json(data, prefix, overwrite)
        except json.JSONDecodeError:
            # Fall back to CSV
            return self._import_bitwarden_csv(content, prefix, overwrite)

    def _import_bitwarden_json(
        self, data: dict, prefix: str, overwrite: bool
    ) -> ImportResult:
        """Import from Bitwarden JSON format."""
        result = ImportResult()

        items = data.get("items", [])
        if not items and "encrypted" in data:
            result.errors.append("Bitwarden export is encrypted. Please export unencrypted JSON.")
            return result

        for item in items:
            result.total += 1

            try:
                name_raw = item.get("name", "")
                item_type = item.get("type", 1)  # 1 = login, 2 = note, 3 = card
                notes = item.get("notes", "") or ""
                login = item.get("login", {}) or {}
                card = item.get("card", {}) or {}
                identity = item.get("identity", {}) or {}
                folder = item.get("folderId", "")

                if not name_raw:
                    result.skipped += 1
                    continue

                # Get URL for folder structure
                url = ""
                uris = login.get("uris", []) or []
                if uris:
                    url = uris[0].get("uri", "")

                # Build entry name
                name = self._build_name(name_raw, url, prefix)

                # Check if exists
                if self._store.exists(name) and not overwrite:
                    result.skipped += 1
                    continue

                # Create secret based on type
                password = login.get("password", "") or ""
                secret = Secret(password=password)

                if login:
                    username = login.get("username", "") or ""
                    if username:
                        secret.set("username", username)
                        secret.set("login", username)
                    if url:
                        secret.set("url", url)
                    totp = login.get("totp", "") or ""
                    if totp:
                        secret.set("totp", totp)

                if card:
                    secret.set("cardNumber", card.get("number", "") or "")
                    secret.set("cardholderName", card.get("cardholderName", "") or "")
                    secret.set("expMonth", card.get("expMonth", "") or "")
                    secret.set("expYear", card.get("expYear", "") or "")
                    secret.set("cvv", card.get("code", "") or "")
                    secret.set("brand", card.get("brand", "") or "")

                if notes:
                    secret.set("notes", notes)

                # Custom fields
                fields = item.get("fields", []) or []
                for field in fields:
                    field_name = field.get("name", "")
                    field_value = field.get("value", "")
                    if field_name and field_value:
                        secret.set(field_name, field_value)

                # Save
                self._store.set(name, secret)
                result.imported += 1

            except Exception as e:
                result.errors.append(f"Error importing '{name_raw}': {e}")

        return result

    def _import_bitwarden_csv(
        self, content: str, prefix: str, overwrite: bool
    ) -> ImportResult:
        """Import from Bitwarden CSV format."""
        result = ImportResult()

        try:
            reader = csv.DictReader(StringIO(content))

            for row in reader:
                result.total += 1

                try:
                    name_raw = row.get("name", "") or ""
                    username = row.get("login_username", "") or ""
                    password = row.get("login_password", "") or ""
                    url = row.get("login_uri", "") or ""
                    notes = row.get("notes", "") or ""
                    totp = row.get("login_totp", "") or ""
                    folder = row.get("folder", "") or ""

                    if not name_raw:
                        result.skipped += 1
                        continue

                    # Build entry name
                    name = self._build_name(name_raw, url, prefix)

                    # Check if exists
                    if self._store.exists(name) and not overwrite:
                        result.skipped += 1
                        continue

                    # Create secret
                    secret = Secret(password=password)
                    if username:
                        secret.set("username", username)
                        secret.set("login", username)
                    if url:
                        secret.set("url", url)
                    if notes:
                        secret.set("notes", notes)
                    if totp:
                        secret.set("totp", totp)

                    # Save
                    self._store.set(name, secret)
                    result.imported += 1

                except Exception as e:
                    result.errors.append(f"Error importing '{name_raw}': {e}")

        except csv.Error as e:
            result.errors.append(f"CSV parse error: {e}")

        return result

    def _import_pass(
        self, path: Path, prefix: str, overwrite: bool
    ) -> ImportResult:
        """Import from pass/gopass directory structure.

        pass stores secrets as:
        ~/.password-store/
            path/to/secret.gpg
        """
        result = ImportResult()

        # Find all .gpg files
        gpg_files = list(path.rglob("*.gpg"))

        for gpg_file in gpg_files:
            result.total += 1

            try:
                # Get relative path without extension
                relative = gpg_file.relative_to(path)
                name_raw = str(relative.with_suffix(""))

                # Add prefix
                if prefix:
                    name = f"{prefix}/{name_raw}"
                else:
                    name = name_raw

                # Check if exists
                if self._store.exists(name) and not overwrite:
                    result.skipped += 1
                    continue

                # Read and decrypt (using the store's crypto backend)
                ciphertext = gpg_file.read_bytes()
                try:
                    plaintext = self._store.crypto.decrypt(ciphertext)
                    secret = Secret.from_bytes(plaintext)
                except Exception:
                    # Try to read as plain text (first line = password)
                    lines = ciphertext.decode("utf-8", errors="ignore").split("\n")
                    secret = Secret(password=lines[0] if lines else "")
                    for line in lines[1:]:
                        if ": " in line:
                            key, value = line.split(": ", 1)
                            secret.set(key.lower(), value)

                # Save to new store
                self._store.set(name, secret)
                result.imported += 1

            except Exception as e:
                result.errors.append(f"Error importing '{gpg_file}': {e}")

        return result

    def _import_lastpass(
        self, content: str, prefix: str, overwrite: bool
    ) -> ImportResult:
        """Import from LastPass CSV export.

        LastPass CSV format:
        url,username,password,totp,extra,name,grouping,fav
        """
        result = ImportResult()

        try:
            reader = csv.DictReader(StringIO(content))

            for row in reader:
                result.total += 1

                try:
                    name_raw = row.get("name", "") or ""
                    username = row.get("username", "") or ""
                    password = row.get("password", "") or ""
                    url = row.get("url", "") or ""
                    notes = row.get("extra", "") or ""
                    totp = row.get("totp", "") or ""
                    grouping = row.get("grouping", "") or ""

                    if not name_raw:
                        result.skipped += 1
                        continue

                    # Build entry name with grouping
                    if grouping:
                        name = self._build_name(name_raw, "", f"{prefix}/{grouping}" if prefix else grouping)
                    else:
                        name = self._build_name(name_raw, url, prefix)

                    # Check if exists
                    if self._store.exists(name) and not overwrite:
                        result.skipped += 1
                        continue

                    # Create secret
                    secret = Secret(password=password)
                    if username:
                        secret.set("username", username)
                        secret.set("login", username)
                    if url:
                        secret.set("url", url)
                    if notes:
                        secret.set("notes", notes)
                    if totp:
                        secret.set("totp", totp)

                    # Save
                    self._store.set(name, secret)
                    result.imported += 1

                except Exception as e:
                    result.errors.append(f"Error importing '{name_raw}': {e}")

        except csv.Error as e:
            result.errors.append(f"CSV parse error: {e}")

        return result

    def _import_keepass(
        self, content: str, prefix: str, overwrite: bool
    ) -> ImportResult:
        """Import from KeePass CSV export.

        KeePass CSV format:
        "Group","Title","Username","Password","URL","Notes"
        """
        result = ImportResult()

        try:
            reader = csv.DictReader(StringIO(content))

            for row in reader:
                result.total += 1

                try:
                    group = row.get("Group", "") or ""
                    title = row.get("Title", "") or ""
                    username = row.get("Username", "") or ""
                    password = row.get("Password", "") or ""
                    url = row.get("URL", "") or ""
                    notes = row.get("Notes", "") or ""

                    if not title:
                        result.skipped += 1
                        continue

                    # Build entry name with group
                    if group:
                        full_prefix = f"{prefix}/{group}" if prefix else group
                    else:
                        full_prefix = prefix

                    name = self._build_name(title, url, full_prefix)

                    # Check if exists
                    if self._store.exists(name) and not overwrite:
                        result.skipped += 1
                        continue

                    # Create secret
                    secret = Secret(password=password)
                    if username:
                        secret.set("username", username)
                        secret.set("login", username)
                    if url:
                        secret.set("url", url)
                    if notes:
                        secret.set("notes", notes)

                    # Save
                    self._store.set(name, secret)
                    result.imported += 1

                except Exception as e:
                    result.errors.append(f"Error importing '{title}': {e}")

        except csv.Error as e:
            result.errors.append(f"CSV parse error: {e}")

        return result

    def _build_name(self, title: str, url: str, prefix: str) -> str:
        """Build a secret name from title and URL.

        Args:
            title: The entry title.
            url: The entry URL.
            prefix: Optional prefix.

        Returns:
            A normalized secret name.
        """
        # Extract domain from URL if available
        domain = ""
        if url:
            try:
                # Simple domain extraction
                if "://" in url:
                    url = url.split("://", 1)[1]
                domain = url.split("/")[0].lower()
                # Remove www.
                if domain.startswith("www."):
                    domain = domain[4:]
            except Exception:
                pass

        # Build name
        if domain:
            name = f"{domain}/{self._sanitize(title)}"
        else:
            name = self._sanitize(title)

        # Add prefix
        if prefix:
            name = f"{prefix.strip('/')}/{name}"

        return name

    def _sanitize(self, name: str) -> str:
        """Sanitize a name for use as a path component.

        Args:
            name: The name to sanitize.

        Returns:
            A sanitized name.
        """
        # Replace problematic characters
        replacements = {
            "/": "-",
            "\\": "-",
            ":": "-",
            "*": "",
            "?": "",
            '"': "",
            "<": "",
            ">": "",
            "|": "",
            "\n": " ",
            "\r": "",
            "\t": " ",
        }

        result = name
        for old, new in replacements.items():
            result = result.replace(old, new)

        # Collapse multiple spaces/dashes
        while "  " in result:
            result = result.replace("  ", " ")
        while "--" in result:
            result = result.replace("--", "-")

        return result.strip().strip("-")


def import_1password(store: Store, data: str | Path, **kwargs) -> ImportResult:
    """Convenience function to import from 1Password.

    Args:
        store: The target store.
        data: The CSV export file or content.
        **kwargs: Additional options (prefix, overwrite).

    Returns:
        Import result.
    """
    return Importer(store).import_from(ImportSource.ONEPASSWORD, data, **kwargs)


def import_bitwarden(store: Store, data: str | Path, **kwargs) -> ImportResult:
    """Convenience function to import from Bitwarden.

    Args:
        store: The target store.
        data: The JSON/CSV export file or content.
        **kwargs: Additional options (prefix, overwrite).

    Returns:
        Import result.
    """
    return Importer(store).import_from(ImportSource.BITWARDEN, data, **kwargs)


def import_pass(store: Store, path: Path, **kwargs) -> ImportResult:
    """Convenience function to import from pass/gopass.

    Args:
        store: The target store.
        path: The pass store directory.
        **kwargs: Additional options (prefix, overwrite).

    Returns:
        Import result.
    """
    return Importer(store).import_from(ImportSource.PASS, path, **kwargs)


def import_lastpass(store: Store, data: str | Path, **kwargs) -> ImportResult:
    """Convenience function to import from LastPass.

    Args:
        store: The target store.
        data: The CSV export file or content.
        **kwargs: Additional options (prefix, overwrite).

    Returns:
        Import result.
    """
    return Importer(store).import_from(ImportSource.LASTPASS, data, **kwargs)


def import_keepass(store: Store, data: str | Path, **kwargs) -> ImportResult:
    """Convenience function to import from KeePass.

    Args:
        store: The target store.
        data: The CSV export file or content.
        **kwargs: Additional options (prefix, overwrite).

    Returns:
        Import result.
    """
    return Importer(store).import_from(ImportSource.KEEPASS, data, **kwargs)
