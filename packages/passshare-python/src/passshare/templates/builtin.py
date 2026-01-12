"""Built-in Templates for PassShare.

© 2026 株式会社BM1314. All rights reserved.
"""

from passshare.templates.types import Template, TemplateField

LOGIN_TEMPLATE = Template(
    id="login",
    name="Website Login",
    description="Login credentials for websites and applications",
    icon="🔐",
    category="login",
    prefix="logins",
    priority=1,
    fields=[
        TemplateField(name="password", label="Password", type="password", required=True, generate=True),
        TemplateField(name="username", label="Username", type="text", required=True),
        TemplateField(name="email", label="Email", type="email"),
        TemplateField(name="url", label="Website URL", type="url", placeholder="https://example.com"),
        TemplateField(name="totp", label="TOTP Secret", type="hidden", placeholder="otpauth://..."),
        TemplateField(name="notes", label="Notes", type="multiline"),
    ],
)

CREDIT_CARD_TEMPLATE = Template(
    id="credit-card",
    name="Credit Card",
    description="Credit or debit card information",
    icon="💳",
    category="card",
    prefix="cards",
    priority=2,
    fields=[
        TemplateField(name="number", label="Card Number", type="text", required=True, pattern=r"^[0-9]{13,19}$"),
        TemplateField(name="holder", label="Cardholder Name", type="text", required=True),
        TemplateField(name="expiry", label="Expiry Date", type="text", required=True, placeholder="MM/YY"),
        TemplateField(name="cvv", label="CVV/CVC", type="password", required=True, pattern=r"^[0-9]{3,4}$"),
        TemplateField(name="pin", label="PIN", type="password", pattern=r"^[0-9]{4,6}$"),
        TemplateField(name="type", label="Card Type", type="text", placeholder="Visa, Mastercard, etc."),
        TemplateField(name="bank", label="Issuing Bank", type="text"),
        TemplateField(name="billing_address", label="Billing Address", type="multiline"),
        TemplateField(name="notes", label="Notes", type="multiline"),
    ],
)

BANK_ACCOUNT_TEMPLATE = Template(
    id="bank-account",
    name="Bank Account",
    description="Bank account details",
    icon="🏦",
    category="card",
    prefix="banking",
    priority=3,
    fields=[
        TemplateField(name="account_number", label="Account Number", type="text", required=True),
        TemplateField(name="routing_number", label="Routing Number", type="text"),
        TemplateField(name="swift", label="SWIFT/BIC", type="text"),
        TemplateField(name="iban", label="IBAN", type="text"),
        TemplateField(name="bank_name", label="Bank Name", type="text", required=True),
        TemplateField(name="branch", label="Branch", type="text"),
        TemplateField(name="account_type", label="Account Type", type="text", placeholder="Checking, Savings, etc."),
        TemplateField(name="holder", label="Account Holder", type="text"),
        TemplateField(name="pin", label="PIN", type="password"),
        TemplateField(name="online_password", label="Online Banking Password", type="password", generate=True),
        TemplateField(name="notes", label="Notes", type="multiline"),
    ],
)

SSH_KEY_TEMPLATE = Template(
    id="ssh-key",
    name="SSH Key",
    description="SSH private key and configuration",
    icon="🔑",
    category="developer",
    prefix="ssh",
    priority=4,
    fields=[
        TemplateField(name="passphrase", label="Passphrase", type="password", generate=True),
        TemplateField(name="private_key", label="Private Key", type="multiline", required=True),
        TemplateField(name="public_key", label="Public Key", type="multiline"),
        TemplateField(name="key_type", label="Key Type", type="text", default="ed25519", placeholder="ed25519, rsa, etc."),
        TemplateField(name="host", label="Host", type="text", placeholder="github.com"),
        TemplateField(name="username", label="Username", type="text", default="git"),
        TemplateField(name="port", label="Port", type="number", default="22"),
        TemplateField(name="fingerprint", label="Fingerprint", type="text"),
        TemplateField(name="notes", label="Notes", type="multiline"),
    ],
)

API_TOKEN_TEMPLATE = Template(
    id="api-token",
    name="API Token",
    description="API keys and tokens",
    icon="🎫",
    category="developer",
    prefix="api",
    priority=5,
    fields=[
        TemplateField(name="token", label="API Token/Key", type="password", required=True),
        TemplateField(name="secret", label="API Secret", type="password"),
        TemplateField(name="service", label="Service Name", type="text", required=True),
        TemplateField(name="endpoint", label="API Endpoint", type="url"),
        TemplateField(name="expires", label="Expiration Date", type="date"),
        TemplateField(name="scopes", label="Scopes/Permissions", type="text"),
        TemplateField(name="notes", label="Notes", type="multiline"),
    ],
)

DATABASE_TEMPLATE = Template(
    id="database",
    name="Database",
    description="Database connection credentials",
    icon="🗄️",
    category="developer",
    prefix="databases",
    priority=6,
    fields=[
        TemplateField(name="password", label="Password", type="password", required=True, generate=True),
        TemplateField(name="username", label="Username", type="text", required=True),
        TemplateField(name="host", label="Host", type="text", required=True, default="localhost"),
        TemplateField(name="port", label="Port", type="number"),
        TemplateField(name="database", label="Database Name", type="text"),
        TemplateField(name="type", label="Database Type", type="text", placeholder="PostgreSQL, MySQL, etc."),
        TemplateField(name="connection_string", label="Connection String", type="text"),
        TemplateField(name="ssl", label="SSL Mode", type="text", default="require"),
        TemplateField(name="notes", label="Notes", type="multiline"),
    ],
)

PASSPORT_TEMPLATE = Template(
    id="passport",
    name="Passport",
    description="Passport information",
    icon="🛂",
    category="identity",
    prefix="identity",
    priority=7,
    fields=[
        TemplateField(name="number", label="Passport Number", type="text", required=True),
        TemplateField(name="full_name", label="Full Name", type="text", required=True),
        TemplateField(name="nationality", label="Nationality", type="text"),
        TemplateField(name="date_of_birth", label="Date of Birth", type="date"),
        TemplateField(name="place_of_birth", label="Place of Birth", type="text"),
        TemplateField(name="issue_date", label="Issue Date", type="date"),
        TemplateField(name="expiry_date", label="Expiry Date", type="date"),
        TemplateField(name="issuing_authority", label="Issuing Authority", type="text"),
        TemplateField(name="notes", label="Notes", type="multiline"),
    ],
)

DRIVERS_LICENSE_TEMPLATE = Template(
    id="drivers-license",
    name="Driver's License",
    description="Driver's license information",
    icon="🚗",
    category="identity",
    prefix="identity",
    priority=8,
    fields=[
        TemplateField(name="number", label="License Number", type="text", required=True),
        TemplateField(name="full_name", label="Full Name", type="text", required=True),
        TemplateField(name="date_of_birth", label="Date of Birth", type="date"),
        TemplateField(name="address", label="Address", type="multiline"),
        TemplateField(name="class", label="License Class", type="text"),
        TemplateField(name="issue_date", label="Issue Date", type="date"),
        TemplateField(name="expiry_date", label="Expiry Date", type="date"),
        TemplateField(name="state", label="State/Province", type="text"),
        TemplateField(name="country", label="Country", type="text"),
        TemplateField(name="notes", label="Notes", type="multiline"),
    ],
)

SOFTWARE_LICENSE_TEMPLATE = Template(
    id="software-license",
    name="Software License",
    description="Software license keys and activation codes",
    icon="📦",
    category="secure-note",
    prefix="licenses",
    priority=9,
    fields=[
        TemplateField(name="license_key", label="License Key", type="text", required=True),
        TemplateField(name="product", label="Product Name", type="text", required=True),
        TemplateField(name="version", label="Version", type="text"),
        TemplateField(name="registered_to", label="Registered To", type="text"),
        TemplateField(name="email", label="Registration Email", type="email"),
        TemplateField(name="purchase_date", label="Purchase Date", type="date"),
        TemplateField(name="expiry_date", label="Expiry Date", type="date"),
        TemplateField(name="seats", label="Number of Seats", type="number"),
        TemplateField(name="download_url", label="Download URL", type="url"),
        TemplateField(name="notes", label="Notes", type="multiline"),
    ],
)

WIFI_TEMPLATE = Template(
    id="wifi",
    name="Wi-Fi Network",
    description="Wireless network credentials",
    icon="📶",
    category="secure-note",
    prefix="wifi",
    priority=10,
    fields=[
        TemplateField(name="password", label="Password", type="password", required=True),
        TemplateField(name="ssid", label="Network Name (SSID)", type="text", required=True),
        TemplateField(name="security", label="Security Type", type="text", default="WPA2", placeholder="WPA2, WPA3, etc."),
        TemplateField(name="hidden", label="Hidden Network", type="text", default="no"),
        TemplateField(name="router_ip", label="Router IP", type="text", default="192.168.1.1"),
        TemplateField(name="admin_user", label="Admin Username", type="text"),
        TemplateField(name="admin_password", label="Admin Password", type="password"),
        TemplateField(name="notes", label="Notes", type="multiline"),
    ],
)

SECURE_NOTE_TEMPLATE = Template(
    id="secure-note",
    name="Secure Note",
    description="Free-form encrypted notes",
    icon="📝",
    category="secure-note",
    prefix="notes",
    priority=11,
    fields=[
        TemplateField(name="title", label="Title", type="text", required=True),
        TemplateField(name="content", label="Content", type="multiline", required=True),
        TemplateField(name="tags", label="Tags", type="text", placeholder="comma-separated"),
    ],
)

IDENTITY_TEMPLATE = Template(
    id="identity",
    name="Identity",
    description="Personal information for form filling",
    icon="👤",
    category="identity",
    prefix="identity",
    priority=12,
    fields=[
        TemplateField(name="first_name", label="First Name", type="text", required=True),
        TemplateField(name="last_name", label="Last Name", type="text", required=True),
        TemplateField(name="middle_name", label="Middle Name", type="text"),
        TemplateField(name="email", label="Email", type="email"),
        TemplateField(name="phone", label="Phone", type="text"),
        TemplateField(name="address", label="Address", type="multiline"),
        TemplateField(name="city", label="City", type="text"),
        TemplateField(name="state", label="State/Province", type="text"),
        TemplateField(name="postal_code", label="Postal Code", type="text"),
        TemplateField(name="country", label="Country", type="text"),
        TemplateField(name="date_of_birth", label="Date of Birth", type="date"),
        TemplateField(name="notes", label="Notes", type="multiline"),
    ],
)

SERVER_TEMPLATE = Template(
    id="server",
    name="Server",
    description="Server/VPS access credentials",
    icon="🖥️",
    category="developer",
    prefix="servers",
    priority=13,
    fields=[
        TemplateField(name="password", label="Password", type="password", generate=True),
        TemplateField(name="username", label="Username", type="text", required=True, default="root"),
        TemplateField(name="host", label="Hostname/IP", type="text", required=True),
        TemplateField(name="port", label="SSH Port", type="number", default="22"),
        TemplateField(name="provider", label="Provider", type="text", placeholder="AWS, DigitalOcean, etc."),
        TemplateField(name="os", label="Operating System", type="text"),
        TemplateField(name="control_panel", label="Control Panel URL", type="url"),
        TemplateField(name="notes", label="Notes", type="multiline"),
    ],
)

BUILTIN_TEMPLATES: list[Template] = [
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
]
