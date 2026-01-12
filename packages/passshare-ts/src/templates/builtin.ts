/**
 * Built-in Templates for PassShare
 *
 * © 2026 株式会社BM1314. All rights reserved.
 */

import type { Template } from './types.js';

/**
 * Website Login Template
 */
export const LOGIN_TEMPLATE: Template = {
  id: 'login',
  name: 'Website Login',
  description: 'Login credentials for websites and applications',
  icon: '🔐',
  category: 'login',
  prefix: 'logins',
  priority: 1,
  fields: [
    { name: 'password', label: 'Password', type: 'password', required: true, generate: true },
    { name: 'username', label: 'Username', type: 'text', required: true },
    { name: 'email', label: 'Email', type: 'email' },
    { name: 'url', label: 'Website URL', type: 'url', placeholder: 'https://example.com' },
    { name: 'totp', label: 'TOTP Secret', type: 'hidden', placeholder: 'otpauth://...' },
    { name: 'notes', label: 'Notes', type: 'multiline' },
  ],
};

/**
 * Credit Card Template
 */
export const CREDIT_CARD_TEMPLATE: Template = {
  id: 'credit-card',
  name: 'Credit Card',
  description: 'Credit or debit card information',
  icon: '💳',
  category: 'card',
  prefix: 'cards',
  priority: 2,
  fields: [
    { name: 'number', label: 'Card Number', type: 'text', required: true, pattern: '^[0-9]{13,19}$' },
    { name: 'holder', label: 'Cardholder Name', type: 'text', required: true },
    { name: 'expiry', label: 'Expiry Date', type: 'text', required: true, placeholder: 'MM/YY' },
    { name: 'cvv', label: 'CVV/CVC', type: 'password', required: true, pattern: '^[0-9]{3,4}$' },
    { name: 'pin', label: 'PIN', type: 'password', pattern: '^[0-9]{4,6}$' },
    { name: 'type', label: 'Card Type', type: 'text', placeholder: 'Visa, Mastercard, etc.' },
    { name: 'bank', label: 'Issuing Bank', type: 'text' },
    { name: 'billing_address', label: 'Billing Address', type: 'multiline' },
    { name: 'notes', label: 'Notes', type: 'multiline' },
  ],
};

/**
 * Bank Account Template
 */
export const BANK_ACCOUNT_TEMPLATE: Template = {
  id: 'bank-account',
  name: 'Bank Account',
  description: 'Bank account details',
  icon: '🏦',
  category: 'card',
  prefix: 'banking',
  priority: 3,
  fields: [
    { name: 'account_number', label: 'Account Number', type: 'text', required: true },
    { name: 'routing_number', label: 'Routing Number', type: 'text' },
    { name: 'swift', label: 'SWIFT/BIC', type: 'text' },
    { name: 'iban', label: 'IBAN', type: 'text' },
    { name: 'bank_name', label: 'Bank Name', type: 'text', required: true },
    { name: 'branch', label: 'Branch', type: 'text' },
    { name: 'account_type', label: 'Account Type', type: 'text', placeholder: 'Checking, Savings, etc.' },
    { name: 'holder', label: 'Account Holder', type: 'text' },
    { name: 'pin', label: 'PIN', type: 'password' },
    { name: 'online_password', label: 'Online Banking Password', type: 'password', generate: true },
    { name: 'notes', label: 'Notes', type: 'multiline' },
  ],
};

/**
 * SSH Key Template
 */
export const SSH_KEY_TEMPLATE: Template = {
  id: 'ssh-key',
  name: 'SSH Key',
  description: 'SSH private key and configuration',
  icon: '🔑',
  category: 'developer',
  prefix: 'ssh',
  priority: 4,
  fields: [
    { name: 'passphrase', label: 'Passphrase', type: 'password', generate: true },
    { name: 'private_key', label: 'Private Key', type: 'multiline', required: true },
    { name: 'public_key', label: 'Public Key', type: 'multiline' },
    { name: 'key_type', label: 'Key Type', type: 'text', default: 'ed25519', placeholder: 'ed25519, rsa, etc.' },
    { name: 'host', label: 'Host', type: 'text', placeholder: 'github.com' },
    { name: 'username', label: 'Username', type: 'text', default: 'git' },
    { name: 'port', label: 'Port', type: 'number', default: '22' },
    { name: 'fingerprint', label: 'Fingerprint', type: 'text' },
    { name: 'notes', label: 'Notes', type: 'multiline' },
  ],
};

/**
 * API Token Template
 */
export const API_TOKEN_TEMPLATE: Template = {
  id: 'api-token',
  name: 'API Token',
  description: 'API keys and tokens',
  icon: '🎫',
  category: 'developer',
  prefix: 'api',
  priority: 5,
  fields: [
    { name: 'token', label: 'API Token/Key', type: 'password', required: true },
    { name: 'secret', label: 'API Secret', type: 'password' },
    { name: 'service', label: 'Service Name', type: 'text', required: true },
    { name: 'endpoint', label: 'API Endpoint', type: 'url' },
    { name: 'expires', label: 'Expiration Date', type: 'date' },
    { name: 'scopes', label: 'Scopes/Permissions', type: 'text' },
    { name: 'notes', label: 'Notes', type: 'multiline' },
  ],
};

/**
 * Database Credentials Template
 */
export const DATABASE_TEMPLATE: Template = {
  id: 'database',
  name: 'Database',
  description: 'Database connection credentials',
  icon: '🗄️',
  category: 'developer',
  prefix: 'databases',
  priority: 6,
  fields: [
    { name: 'password', label: 'Password', type: 'password', required: true, generate: true },
    { name: 'username', label: 'Username', type: 'text', required: true },
    { name: 'host', label: 'Host', type: 'text', required: true, default: 'localhost' },
    { name: 'port', label: 'Port', type: 'number' },
    { name: 'database', label: 'Database Name', type: 'text' },
    { name: 'type', label: 'Database Type', type: 'text', placeholder: 'PostgreSQL, MySQL, etc.' },
    { name: 'connection_string', label: 'Connection String', type: 'text' },
    { name: 'ssl', label: 'SSL Mode', type: 'text', default: 'require' },
    { name: 'notes', label: 'Notes', type: 'multiline' },
  ],
};

/**
 * Passport Template
 */
export const PASSPORT_TEMPLATE: Template = {
  id: 'passport',
  name: 'Passport',
  description: 'Passport information',
  icon: '🛂',
  category: 'identity',
  prefix: 'identity',
  priority: 7,
  fields: [
    { name: 'number', label: 'Passport Number', type: 'text', required: true },
    { name: 'full_name', label: 'Full Name', type: 'text', required: true },
    { name: 'nationality', label: 'Nationality', type: 'text' },
    { name: 'date_of_birth', label: 'Date of Birth', type: 'date' },
    { name: 'place_of_birth', label: 'Place of Birth', type: 'text' },
    { name: 'issue_date', label: 'Issue Date', type: 'date' },
    { name: 'expiry_date', label: 'Expiry Date', type: 'date' },
    { name: 'issuing_authority', label: 'Issuing Authority', type: 'text' },
    { name: 'notes', label: 'Notes', type: 'multiline' },
  ],
};

/**
 * Driver's License Template
 */
export const DRIVERS_LICENSE_TEMPLATE: Template = {
  id: 'drivers-license',
  name: "Driver's License",
  description: "Driver's license information",
  icon: '🚗',
  category: 'identity',
  prefix: 'identity',
  priority: 8,
  fields: [
    { name: 'number', label: 'License Number', type: 'text', required: true },
    { name: 'full_name', label: 'Full Name', type: 'text', required: true },
    { name: 'date_of_birth', label: 'Date of Birth', type: 'date' },
    { name: 'address', label: 'Address', type: 'multiline' },
    { name: 'class', label: 'License Class', type: 'text' },
    { name: 'issue_date', label: 'Issue Date', type: 'date' },
    { name: 'expiry_date', label: 'Expiry Date', type: 'date' },
    { name: 'state', label: 'State/Province', type: 'text' },
    { name: 'country', label: 'Country', type: 'text' },
    { name: 'notes', label: 'Notes', type: 'multiline' },
  ],
};

/**
 * Software License Template
 */
export const SOFTWARE_LICENSE_TEMPLATE: Template = {
  id: 'software-license',
  name: 'Software License',
  description: 'Software license keys and activation codes',
  icon: '📦',
  category: 'secure-note',
  prefix: 'licenses',
  priority: 9,
  fields: [
    { name: 'license_key', label: 'License Key', type: 'text', required: true },
    { name: 'product', label: 'Product Name', type: 'text', required: true },
    { name: 'version', label: 'Version', type: 'text' },
    { name: 'registered_to', label: 'Registered To', type: 'text' },
    { name: 'email', label: 'Registration Email', type: 'email' },
    { name: 'purchase_date', label: 'Purchase Date', type: 'date' },
    { name: 'expiry_date', label: 'Expiry Date', type: 'date' },
    { name: 'seats', label: 'Number of Seats', type: 'number' },
    { name: 'download_url', label: 'Download URL', type: 'url' },
    { name: 'notes', label: 'Notes', type: 'multiline' },
  ],
};

/**
 * Wi-Fi Network Template
 */
export const WIFI_TEMPLATE: Template = {
  id: 'wifi',
  name: 'Wi-Fi Network',
  description: 'Wireless network credentials',
  icon: '📶',
  category: 'secure-note',
  prefix: 'wifi',
  priority: 10,
  fields: [
    { name: 'password', label: 'Password', type: 'password', required: true },
    { name: 'ssid', label: 'Network Name (SSID)', type: 'text', required: true },
    { name: 'security', label: 'Security Type', type: 'text', default: 'WPA2', placeholder: 'WPA2, WPA3, etc.' },
    { name: 'hidden', label: 'Hidden Network', type: 'text', default: 'no' },
    { name: 'router_ip', label: 'Router IP', type: 'text', default: '192.168.1.1' },
    { name: 'admin_user', label: 'Admin Username', type: 'text' },
    { name: 'admin_password', label: 'Admin Password', type: 'password' },
    { name: 'notes', label: 'Notes', type: 'multiline' },
  ],
};

/**
 * Secure Note Template
 */
export const SECURE_NOTE_TEMPLATE: Template = {
  id: 'secure-note',
  name: 'Secure Note',
  description: 'Free-form encrypted notes',
  icon: '📝',
  category: 'secure-note',
  prefix: 'notes',
  priority: 11,
  fields: [
    { name: 'title', label: 'Title', type: 'text', required: true },
    { name: 'content', label: 'Content', type: 'multiline', required: true },
    { name: 'tags', label: 'Tags', type: 'text', placeholder: 'comma-separated' },
  ],
};

/**
 * Identity (Personal Info) Template
 */
export const IDENTITY_TEMPLATE: Template = {
  id: 'identity',
  name: 'Identity',
  description: 'Personal information for form filling',
  icon: '👤',
  category: 'identity',
  prefix: 'identity',
  priority: 12,
  fields: [
    { name: 'first_name', label: 'First Name', type: 'text', required: true },
    { name: 'last_name', label: 'Last Name', type: 'text', required: true },
    { name: 'middle_name', label: 'Middle Name', type: 'text' },
    { name: 'email', label: 'Email', type: 'email' },
    { name: 'phone', label: 'Phone', type: 'text' },
    { name: 'address', label: 'Address', type: 'multiline' },
    { name: 'city', label: 'City', type: 'text' },
    { name: 'state', label: 'State/Province', type: 'text' },
    { name: 'postal_code', label: 'Postal Code', type: 'text' },
    { name: 'country', label: 'Country', type: 'text' },
    { name: 'date_of_birth', label: 'Date of Birth', type: 'date' },
    { name: 'notes', label: 'Notes', type: 'multiline' },
  ],
};

/**
 * Server/VPS Template
 */
export const SERVER_TEMPLATE: Template = {
  id: 'server',
  name: 'Server',
  description: 'Server/VPS access credentials',
  icon: '🖥️',
  category: 'developer',
  prefix: 'servers',
  priority: 13,
  fields: [
    { name: 'password', label: 'Password', type: 'password', generate: true },
    { name: 'username', label: 'Username', type: 'text', required: true, default: 'root' },
    { name: 'host', label: 'Hostname/IP', type: 'text', required: true },
    { name: 'port', label: 'SSH Port', type: 'number', default: '22' },
    { name: 'provider', label: 'Provider', type: 'text', placeholder: 'AWS, DigitalOcean, etc.' },
    { name: 'os', label: 'Operating System', type: 'text' },
    { name: 'control_panel', label: 'Control Panel URL', type: 'url' },
    { name: 'notes', label: 'Notes', type: 'multiline' },
  ],
};

/**
 * All built-in templates
 */
export const BUILTIN_TEMPLATES: Template[] = [
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
];
