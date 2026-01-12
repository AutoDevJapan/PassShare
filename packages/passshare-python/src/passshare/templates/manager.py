"""Template Manager for PassShare.

© 2026 株式会社BM1314. All rights reserved.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from passshare.password import generate_password
from passshare.secret import Secret
from passshare.templates.builtin import BUILTIN_TEMPLATES
from passshare.templates.types import Template, TemplateField


class TemplateManager:
    """Template manager for creating secrets from templates."""

    def __init__(
        self,
        templates_dir: Path | str | None = None,
        include_builtin: bool = True,
    ) -> None:
        """Initialize the template manager.

        Args:
            templates_dir: Custom templates directory.
            include_builtin: Include built-in templates.
        """
        self._templates: dict[str, Template] = {}
        self._templates_dir = Path(templates_dir) if templates_dir else None

        # Load built-in templates
        if include_builtin:
            for template in BUILTIN_TEMPLATES:
                self._templates[template.id] = template

        # Load custom templates
        if self._templates_dir:
            self._load_custom_templates(self._templates_dir)

    def _load_custom_templates(self, directory: Path) -> None:
        """Load custom templates from a directory."""
        if not directory.exists():
            return

        for file in directory.iterdir():
            if file.suffix not in (".json", ".yaml", ".yml"):
                continue

            try:
                content = file.read_text(encoding="utf-8")
                data = json.loads(content)
                template = self._parse_template(data)
                self._templates[template.id] = template
            except Exception:
                # Skip invalid templates
                pass

    def _parse_template(self, data: dict[str, Any]) -> Template:
        """Parse template from dictionary."""
        fields = []
        for field_data in data.get("fields", []):
            fields.append(
                TemplateField(
                    name=field_data["name"],
                    label=field_data["label"],
                    type=field_data.get("type", "text"),
                    required=field_data.get("required", False),
                    default=field_data.get("default"),
                    placeholder=field_data.get("placeholder"),
                    generate=field_data.get("generate", False),
                    pattern=field_data.get("pattern"),
                )
            )

        return Template(
            id=data["id"],
            name=data["name"],
            description=data.get("description", ""),
            icon=data.get("icon", "📄"),
            category=data.get("category", "custom"),
            fields=fields,
            prefix=data.get("prefix"),
            priority=data.get("priority", 99),
        )

    def get_all(self) -> list[Template]:
        """Get all templates sorted by priority."""
        return sorted(self._templates.values(), key=lambda t: t.priority)

    def get_by_category(self, category: str) -> list[Template]:
        """Get templates by category."""
        return [t for t in self.get_all() if t.category == category]

    def get(self, template_id: str) -> Template | None:
        """Get a specific template by ID."""
        return self._templates.get(template_id)

    def add(self, template: Template) -> None:
        """Add a custom template."""
        self._templates[template.id] = template

    def remove(self, template_id: str) -> bool:
        """Remove a template."""
        if template_id in self._templates:
            del self._templates[template_id]
            return True
        return False

    def create_secret(self, template_id: str, values: dict[str, str]) -> Secret:
        """Create a Secret from a template with provided values.

        Args:
            template_id: Template ID.
            values: Field values.

        Returns:
            The created secret.

        Raises:
            ValueError: If template not found.
        """
        template = self._templates.get(template_id)
        if not template:
            raise ValueError(f"Template not found: {template_id}")

        # Get password field
        password_field = None
        for field in template.fields:
            if field.name == "password" or field.type == "password":
                password_field = field
                break

        password = values.get("password", "")
        if password_field:
            password = values.get(password_field.name, "")

        # Generate password if needed
        if not password and password_field and password_field.generate:
            password = generate_password(length=24, symbols=True)

        secret = Secret(password=password)

        # Set all other fields
        for field in template.fields:
            if field.name == "password":
                continue

            value = values.get(field.name, "")

            # Use default if not provided
            if not value and field.default:
                value = field.default

            # Generate if needed
            if not value and field.generate:
                value = generate_password(length=24, symbols=True)

            if value:
                if field.name in ("notes", "content"):
                    secret.body = value
                else:
                    secret.set(field.name, value)

        return secret

    def suggest_name(self, template_id: str, values: dict[str, str]) -> str:
        """Generate a suggested secret name from template and values.

        Args:
            template_id: Template ID.
            values: Field values.

        Returns:
            Suggested name.
        """
        template = self._templates.get(template_id)
        if not template:
            return "secret"

        prefix = template.prefix or template.category

        # Try to find a meaningful identifier
        identifiers = ["url", "service", "ssid", "product", "host", "bank_name", "title"]
        for key in identifiers:
            if values.get(key):
                # Extract domain from URL
                if key == "url":
                    try:
                        parsed = urlparse(values[key])
                        hostname = parsed.netloc.replace("www.", "")
                        return f"{prefix}/{hostname}"
                    except Exception:
                        pass
                return f"{prefix}/{values[key].lower().replace(' ', '-')}"

        # Use username or email as identifier
        if values.get("username"):
            return f"{prefix}/{values['username']}"
        if values.get("email"):
            return f"{prefix}/{values['email'].split('@')[0]}"

        # Fallback
        import time

        return f"{prefix}/{template.id}-{int(time.time())}"

    def validate_field(
        self, field: TemplateField, value: str
    ) -> tuple[bool, str | None]:
        """Validate field value against template definition.

        Args:
            field: Field definition.
            value: Field value.

        Returns:
            Tuple of (valid, error_message).
        """
        # Check required
        if field.required and not value:
            return False, f"{field.label} is required"

        # Check pattern
        if value and field.pattern:
            if not re.match(field.pattern, value):
                return False, f"{field.label} format is invalid"

        # Check email format
        if value and field.type == "email":
            email_pattern = r"^[^\s@]+@[^\s@]+\.[^\s@]+$"
            if not re.match(email_pattern, value):
                return False, f"{field.label} must be a valid email"

        # Check URL format
        if value and field.type == "url":
            try:
                result = urlparse(value)
                if not all([result.scheme, result.netloc]):
                    return False, f"{field.label} must be a valid URL"
            except Exception:
                return False, f"{field.label} must be a valid URL"

        # Check number format
        if value and field.type == "number":
            try:
                float(value)
            except ValueError:
                return False, f"{field.label} must be a number"

        return True, None

    def validate(
        self, template_id: str, values: dict[str, str]
    ) -> tuple[bool, dict[str, str]]:
        """Validate all values against template.

        Args:
            template_id: Template ID.
            values: Field values.

        Returns:
            Tuple of (valid, errors).
        """
        template = self._templates.get(template_id)
        if not template:
            return False, {"_template": "Template not found"}

        errors: dict[str, str] = {}

        for field in template.fields:
            valid, error = self.validate_field(field, values.get(field.name, ""))
            if not valid and error:
                errors[field.name] = error

        return len(errors) == 0, errors

    def export_template(self, template_id: str) -> str | None:
        """Export template to JSON.

        Args:
            template_id: Template ID.

        Returns:
            JSON string or None if not found.
        """
        template = self._templates.get(template_id)
        if not template:
            return None

        data = {
            "id": template.id,
            "name": template.name,
            "description": template.description,
            "icon": template.icon,
            "category": template.category,
            "prefix": template.prefix,
            "priority": template.priority,
            "fields": [
                {
                    "name": f.name,
                    "label": f.label,
                    "type": f.type,
                    "required": f.required,
                    "default": f.default,
                    "placeholder": f.placeholder,
                    "generate": f.generate,
                    "pattern": f.pattern,
                }
                for f in template.fields
            ],
        }
        return json.dumps(data, indent=2, ensure_ascii=False)

    def import_template(self, json_str: str) -> Template:
        """Import template from JSON.

        Args:
            json_str: JSON string.

        Returns:
            The imported template.

        Raises:
            ValueError: If invalid template.
        """
        data = json.loads(json_str)

        if not data.get("id") or not data.get("name") or not data.get("fields"):
            raise ValueError("Invalid template: missing required fields")

        template = self._parse_template(data)
        self._templates[template.id] = template
        return template


# Default template manager instance
default_template_manager = TemplateManager()
