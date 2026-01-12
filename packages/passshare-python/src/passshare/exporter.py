"""Export functionality for PassShare.

Supports exporting to:
- PassShare JSON (native format)
- Bitwarden JSON
- CSV (generic)

© 2026 BM1314 Inc. All rights reserved.
"""

from __future__ import annotations

import csv
import json
from dataclasses import dataclass
from enum import Enum
from io import StringIO
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from passshare.gopass import Gopass


class ExportFormat(Enum):
    """Supported export formats."""

    PASSSHARE_JSON = "passshare"
    BITWARDEN_JSON = "bitwarden"
    CSV = "csv"
    ENCRYPTED_JSON = "encrypted"


@dataclass
class ExportResult:
    """Result of an export operation."""

    total: int = 0
    exported: int = 0
    skipped: int = 0
    errors: list[str] | None = None
    content: str = ""

    def __post_init__(self) -> None:
        if self.errors is None:
            self.errors = []


class Exporter:
    """Export passwords to various formats."""

    def __init__(self, gopass: Gopass) -> None:
        """Initialize the exporter.

        Args:
            gopass: The PassShare gopass instance.
        """
        self._gopass = gopass

    def export_to(
        self,
        format: ExportFormat,
        prefix: str = "",
        output_path: Path | None = None,
    ) -> ExportResult:
        """Export passwords to a format.

        Args:
            format: The target format.
            prefix: Optional prefix filter (only export secrets with this prefix).
            output_path: Optional output file path.

        Returns:
            Export result with content.
        """
        if format == ExportFormat.PASSSHARE_JSON:
            result = self._export_passshare_json(prefix)
        elif format == ExportFormat.BITWARDEN_JSON:
            result = self._export_bitwarden_json(prefix)
        elif format == ExportFormat.CSV:
            result = self._export_csv(prefix)
        else:
            raise ValueError(f"Unsupported export format: {format}")

        # Write to file if path provided
        if output_path and result.content:
            output_path.write_text(result.content, encoding="utf-8")

        return result

    def _export_passshare_json(self, prefix: str) -> ExportResult:
        """Export to PassShare native JSON format."""
        result = ExportResult()

        items = []
        secrets = self._gopass.list(prefix)

        for name in secrets:
            result.total += 1

            try:
                secret = self._gopass.get(name)

                item: dict[str, Any] = {
                    "name": name,
                    "password": secret.password,
                    "data": dict(secret.data),
                }

                if secret.body:
                    item["body"] = secret.body

                items.append(item)
                result.exported += 1

            except Exception as e:
                result.errors.append(f"Error exporting '{name}': {e}")

        export_data = {
            "version": "1.0",
            "generator": "passshare",
            "items": items,
        }

        result.content = json.dumps(export_data, indent=2, ensure_ascii=False)
        return result

    def _export_bitwarden_json(self, prefix: str) -> ExportResult:
        """Export to Bitwarden JSON format."""
        result = ExportResult()

        items = []
        secrets = self._gopass.list(prefix)

        for name in secrets:
            result.total += 1

            try:
                secret = self._gopass.get(name)
                data = dict(secret.data)

                # Determine item type
                item_type = 1  # Default: login
                if "cardNumber" in data or "number" in data and "expiry" in data:
                    item_type = 3  # Card
                elif not secret.password and secret.body:
                    item_type = 2  # Secure note

                item: dict[str, Any] = {
                    "name": name.split("/")[-1] if "/" in name else name,
                    "type": item_type,
                    "notes": data.get("notes", "") or secret.body or "",
                }

                # Login fields
                if item_type == 1:
                    uris = []
                    url = data.get("url", "")
                    if url:
                        uris.append({"uri": url})

                    item["login"] = {
                        "username": data.get("username", "") or data.get("login", ""),
                        "password": secret.password,
                        "uris": uris,
                        "totp": data.get("totp", ""),
                    }

                # Card fields
                elif item_type == 3:
                    item["card"] = {
                        "cardholderName": data.get("holder", "") or data.get("cardholderName", ""),
                        "number": data.get("number", "") or data.get("cardNumber", ""),
                        "expMonth": data.get("expMonth", ""),
                        "expYear": data.get("expYear", ""),
                        "code": data.get("cvv", "") or data.get("code", ""),
                        "brand": data.get("type", "") or data.get("brand", ""),
                    }

                    # Parse expiry if in MM/YY format
                    expiry = data.get("expiry", "")
                    if expiry and "/" in expiry:
                        parts = expiry.split("/")
                        if len(parts) == 2:
                            item["card"]["expMonth"] = parts[0]
                            item["card"]["expYear"] = parts[1]

                # Custom fields
                custom_fields = []
                skip_fields = {
                    "username", "login", "password", "url", "notes", "totp",
                    "number", "holder", "expiry", "cvv", "type", "cardNumber",
                    "cardholderName", "expMonth", "expYear", "code", "brand",
                }
                for key, value in data.items():
                    if key not in skip_fields and value:
                        custom_fields.append({
                            "name": key,
                            "value": value,
                            "type": 0,  # Text
                        })

                if custom_fields:
                    item["fields"] = custom_fields

                # Folder from path
                if "/" in name:
                    parts = name.rsplit("/", 1)
                    item["folderId"] = parts[0]

                items.append(item)
                result.exported += 1

            except Exception as e:
                result.errors.append(f"Error exporting '{name}': {e}")

        export_data = {
            "encrypted": False,
            "folders": [],
            "items": items,
        }

        # Extract unique folders
        folders = set()
        for item in items:
            if "folderId" in item:
                folders.add(item["folderId"])

        export_data["folders"] = [{"id": f, "name": f} for f in sorted(folders)]

        result.content = json.dumps(export_data, indent=2, ensure_ascii=False)
        return result

    def _export_csv(self, prefix: str) -> ExportResult:
        """Export to generic CSV format."""
        result = ExportResult()

        output = StringIO()
        writer = csv.writer(output)

        # Write header
        writer.writerow(["name", "username", "password", "url", "notes", "totp"])

        secrets = self._gopass.list(prefix)

        for name in secrets:
            result.total += 1

            try:
                secret = self._gopass.get(name)
                data = dict(secret.data)

                writer.writerow([
                    name,
                    data.get("username", "") or data.get("login", ""),
                    secret.password,
                    data.get("url", ""),
                    data.get("notes", "") or secret.body or "",
                    data.get("totp", ""),
                ])

                result.exported += 1

            except Exception as e:
                result.errors.append(f"Error exporting '{name}': {e}")

        result.content = output.getvalue()
        return result


def export_passshare(gopass: Gopass, output: Path | None = None, **kwargs) -> ExportResult:
    """Convenience function to export to PassShare JSON format.

    Args:
        gopass: The PassShare instance.
        output: Optional output file path.
        **kwargs: Additional options (prefix).

    Returns:
        Export result.
    """
    return Exporter(gopass).export_to(ExportFormat.PASSSHARE_JSON, output_path=output, **kwargs)


def export_bitwarden(gopass: Gopass, output: Path | None = None, **kwargs) -> ExportResult:
    """Convenience function to export to Bitwarden JSON format.

    Args:
        gopass: The PassShare instance.
        output: Optional output file path.
        **kwargs: Additional options (prefix).

    Returns:
        Export result.
    """
    return Exporter(gopass).export_to(ExportFormat.BITWARDEN_JSON, output_path=output, **kwargs)


def export_csv(gopass: Gopass, output: Path | None = None, **kwargs) -> ExportResult:
    """Convenience function to export to CSV format.

    Args:
        gopass: The PassShare instance.
        output: Optional output file path.
        **kwargs: Additional options (prefix).

    Returns:
        Export result.
    """
    return Exporter(gopass).export_to(ExportFormat.CSV, output_path=output, **kwargs)
