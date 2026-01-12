"""PassShare Templates module.

© 2026 株式会社BM1314. All rights reserved.
"""

from passshare.templates.types import Template, TemplateField
from passshare.templates.builtin import (
    BUILTIN_TEMPLATES,
    LOGIN_TEMPLATE,
    CREDIT_CARD_TEMPLATE,
    BANK_ACCOUNT_TEMPLATE,
    SSH_KEY_TEMPLATE,
    API_TOKEN_TEMPLATE,
    DATABASE_TEMPLATE,
    PASSPORT_TEMPLATE,
    DRIVERS_LICENSE_TEMPLATE,
    SOFTWARE_LICENSE_TEMPLATE,
    WIFI_TEMPLATE,
    SECURE_NOTE_TEMPLATE,
    IDENTITY_TEMPLATE,
    SERVER_TEMPLATE,
)
from passshare.templates.manager import TemplateManager, default_template_manager

__all__ = [
    "Template",
    "TemplateField",
    "TemplateManager",
    "default_template_manager",
    "BUILTIN_TEMPLATES",
    "LOGIN_TEMPLATE",
    "CREDIT_CARD_TEMPLATE",
    "BANK_ACCOUNT_TEMPLATE",
    "SSH_KEY_TEMPLATE",
    "API_TOKEN_TEMPLATE",
    "DATABASE_TEMPLATE",
    "PASSPORT_TEMPLATE",
    "DRIVERS_LICENSE_TEMPLATE",
    "SOFTWARE_LICENSE_TEMPLATE",
    "WIFI_TEMPLATE",
    "SECURE_NOTE_TEMPLATE",
    "IDENTITY_TEMPLATE",
    "SERVER_TEMPLATE",
]
