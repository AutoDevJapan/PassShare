"""Template Types for PassShare.

© 2026 株式会社BM1314. All rights reserved.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal


@dataclass
class TemplateField:
    """Template field definition."""

    name: str
    """Field name (key)."""

    label: str
    """Display label."""

    type: Literal["text", "password", "email", "url", "number", "date", "multiline", "hidden"] = "text"
    """Field type."""

    required: bool = False
    """Whether the field is required."""

    default: str | None = None
    """Default value."""

    placeholder: str | None = None
    """Placeholder text."""

    generate: bool = False
    """Generate password for this field."""

    pattern: str | None = None
    """Validation pattern (regex)."""


@dataclass
class Template:
    """Template definition."""

    id: str
    """Unique identifier."""

    name: str
    """Display name."""

    description: str
    """Description."""

    icon: str
    """Icon (emoji or icon name)."""

    category: Literal["login", "card", "identity", "secure-note", "developer", "custom"]
    """Category."""

    fields: list[TemplateField] = field(default_factory=list)
    """Fields."""

    prefix: str | None = None
    """Suggested folder prefix."""

    priority: int = 99
    """Priority (for sorting)."""
