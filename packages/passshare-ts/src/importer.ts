/**
 * Import functionality for migrating from other password managers.
 *
 * Supports importing from:
 * - 1Password (CSV export)
 * - Bitwarden (JSON/CSV export)
 * - LastPass (CSV export)
 * - KeePass (CSV export)
 *
 * © 2026 BM1314 Inc. All rights reserved.
 */

import { Secret } from './secret.js';
import type { Store } from './store.js';

/**
 * Supported import sources
 */
export type ImportSource = '1password' | 'bitwarden' | 'lastpass' | 'keepass' | 'csv';

/**
 * Import result
 */
export interface ImportResult {
  total: number;
  imported: number;
  skipped: number;
  errors: string[];
}

/**
 * Import options
 */
export interface ImportOptions {
  prefix?: string;
  overwrite?: boolean;
}

/**
 * Parse CSV content into array of objects
 */
function parseCSV(content: string): Record<string, string>[] {
  const lines = content.split('\n').filter(line => line.trim());
  if (lines.length < 2) return [];

  // Parse header
  const header = parseCSVLine(lines[0]);
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const row: Record<string, string> = {};
    for (let j = 0; j < header.length; j++) {
      row[header[j]] = values[j] || '';
    }
    rows.push(row);
  }

  return rows;
}

/**
 * Parse a single CSV line, handling quoted values
 */
function parseCSVLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      values.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current.trim());

  return values;
}

/**
 * Sanitize a name for use as path
 */
function sanitizeName(name: string): string {
  return name
    .replace(/[\/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/-+/g, '-')
    .trim()
    .replace(/^-|-$/g, '');
}

/**
 * Build secret name from title and URL
 */
function buildName(title: string, url: string, prefix: string): string {
  let domain = '';
  if (url) {
    try {
      const parsed = new URL(url);
      domain = parsed.hostname.replace('www.', '').toLowerCase();
    } catch {
      // Not a valid URL
    }
  }

  let name = domain ? `${domain}/${sanitizeName(title)}` : sanitizeName(title);
  if (prefix) {
    name = `${prefix.replace(/\/$/, '')}/${name}`;
  }
  return name;
}

/**
 * Import from 1Password CSV export
 */
async function import1Password(
  store: Store,
  content: string,
  options: ImportOptions = {}
): Promise<ImportResult> {
  const result: ImportResult = { total: 0, imported: 0, skipped: 0, errors: [] };
  const rows = parseCSV(content);

  for (const row of rows) {
    result.total++;

    try {
      const title = row['Title'] || row['title'] || row['name'] || '';
      const username = row['Username'] || row['username'] || row['login'] || '';
      const password = row['Password'] || row['password'] || '';
      const url = row['URL'] || row['url'] || row['website'] || '';
      const notes = row['Notes'] || row['notes'] || row['notesPlain'] || '';

      if (!title) {
        result.skipped++;
        continue;
      }

      const name = buildName(title, url, options.prefix || '');

      if ((await store.exists(name)) && !options.overwrite) {
        result.skipped++;
        continue;
      }

      const secret = new Secret(password);
      if (username) {
        secret.set('username', username);
        secret.set('login', username);
      }
      if (url) secret.set('url', url);
      if (notes) secret.set('notes', notes);

      await store.set(name, secret);
      result.imported++;
    } catch (e) {
      result.errors.push(`Error importing: ${e}`);
    }
  }

  return result;
}

/**
 * Import from Bitwarden JSON export
 */
async function importBitwardenJSON(
  store: Store,
  data: { items?: Array<Record<string, unknown>> },
  options: ImportOptions = {}
): Promise<ImportResult> {
  const result: ImportResult = { total: 0, imported: 0, skipped: 0, errors: [] };
  const items = data.items || [];

  for (const item of items) {
    result.total++;

    try {
      const nameRaw = (item.name as string) || '';
      const notes = (item.notes as string) || '';
      const login = (item.login as Record<string, unknown>) || {};
      const card = (item.card as Record<string, unknown>) || {};

      if (!nameRaw) {
        result.skipped++;
        continue;
      }

      const uris = (login.uris as Array<{ uri: string }>) || [];
      const url = uris.length > 0 ? uris[0].uri : '';

      const name = buildName(nameRaw, url, options.prefix || '');

      if ((await store.exists(name)) && !options.overwrite) {
        result.skipped++;
        continue;
      }

      const password = (login.password as string) || '';
      const secret = new Secret(password);

      if (login.username) {
        secret.set('username', login.username as string);
        secret.set('login', login.username as string);
      }
      if (url) secret.set('url', url);
      if (login.totp) secret.set('totp', login.totp as string);
      if (notes) secret.set('notes', notes);

      // Card fields
      if (card.number) secret.set('cardNumber', card.number as string);
      if (card.cardholderName) secret.set('cardholderName', card.cardholderName as string);
      if (card.expMonth) secret.set('expMonth', card.expMonth as string);
      if (card.expYear) secret.set('expYear', card.expYear as string);
      if (card.code) secret.set('cvv', card.code as string);

      // Custom fields
      const fields = (item.fields as Array<{ name: string; value: string }>) || [];
      for (const field of fields) {
        if (field.name && field.value) {
          secret.set(field.name, field.value);
        }
      }

      await store.set(name, secret);
      result.imported++;
    } catch (e) {
      result.errors.push(`Error importing: ${e}`);
    }
  }

  return result;
}

/**
 * Import from Bitwarden (JSON or CSV)
 */
async function importBitwarden(
  store: Store,
  content: string,
  options: ImportOptions = {}
): Promise<ImportResult> {
  // Try JSON first
  try {
    const data = JSON.parse(content);
    return importBitwardenJSON(store, data, options);
  } catch {
    // Fall back to CSV
    return importBitwardenCSV(store, content, options);
  }
}

/**
 * Import from Bitwarden CSV export
 */
async function importBitwardenCSV(
  store: Store,
  content: string,
  options: ImportOptions = {}
): Promise<ImportResult> {
  const result: ImportResult = { total: 0, imported: 0, skipped: 0, errors: [] };
  const rows = parseCSV(content);

  for (const row of rows) {
    result.total++;

    try {
      const nameRaw = row['name'] || '';
      const username = row['login_username'] || '';
      const password = row['login_password'] || '';
      const url = row['login_uri'] || '';
      const notes = row['notes'] || '';
      const totp = row['login_totp'] || '';

      if (!nameRaw) {
        result.skipped++;
        continue;
      }

      const name = buildName(nameRaw, url, options.prefix || '');

      if ((await store.exists(name)) && !options.overwrite) {
        result.skipped++;
        continue;
      }

      const secret = new Secret(password);
      if (username) {
        secret.set('username', username);
        secret.set('login', username);
      }
      if (url) secret.set('url', url);
      if (notes) secret.set('notes', notes);
      if (totp) secret.set('totp', totp);

      await store.set(name, secret);
      result.imported++;
    } catch (e) {
      result.errors.push(`Error importing: ${e}`);
    }
  }

  return result;
}

/**
 * Import from LastPass CSV export
 */
async function importLastPass(
  store: Store,
  content: string,
  options: ImportOptions = {}
): Promise<ImportResult> {
  const result: ImportResult = { total: 0, imported: 0, skipped: 0, errors: [] };
  const rows = parseCSV(content);

  for (const row of rows) {
    result.total++;

    try {
      const nameRaw = row['name'] || '';
      const username = row['username'] || '';
      const password = row['password'] || '';
      const url = row['url'] || '';
      const notes = row['extra'] || '';
      const totp = row['totp'] || '';
      const grouping = row['grouping'] || '';

      if (!nameRaw) {
        result.skipped++;
        continue;
      }

      let prefix = options.prefix || '';
      if (grouping) {
        prefix = prefix ? `${prefix}/${grouping}` : grouping;
      }

      const name = buildName(nameRaw, url, prefix);

      if ((await store.exists(name)) && !options.overwrite) {
        result.skipped++;
        continue;
      }

      const secret = new Secret(password);
      if (username) {
        secret.set('username', username);
        secret.set('login', username);
      }
      if (url) secret.set('url', url);
      if (notes) secret.set('notes', notes);
      if (totp) secret.set('totp', totp);

      await store.set(name, secret);
      result.imported++;
    } catch (e) {
      result.errors.push(`Error importing: ${e}`);
    }
  }

  return result;
}

/**
 * Import from KeePass CSV export
 */
async function importKeePass(
  store: Store,
  content: string,
  options: ImportOptions = {}
): Promise<ImportResult> {
  const result: ImportResult = { total: 0, imported: 0, skipped: 0, errors: [] };
  const rows = parseCSV(content);

  for (const row of rows) {
    result.total++;

    try {
      const group = row['Group'] || '';
      const title = row['Title'] || '';
      const username = row['Username'] || '';
      const password = row['Password'] || '';
      const url = row['URL'] || '';
      const notes = row['Notes'] || '';

      if (!title) {
        result.skipped++;
        continue;
      }

      let prefix = options.prefix || '';
      if (group) {
        prefix = prefix ? `${prefix}/${group}` : group;
      }

      const name = buildName(title, url, prefix);

      if ((await store.exists(name)) && !options.overwrite) {
        result.skipped++;
        continue;
      }

      const secret = new Secret(password);
      if (username) {
        secret.set('username', username);
        secret.set('login', username);
      }
      if (url) secret.set('url', url);
      if (notes) secret.set('notes', notes);

      await store.set(name, secret);
      result.imported++;
    } catch (e) {
      result.errors.push(`Error importing: ${e}`);
    }
  }

  return result;
}

/**
 * Import passwords from various sources
 */
export async function importPasswords(
  store: Store,
  source: ImportSource,
  content: string,
  options: ImportOptions = {}
): Promise<ImportResult> {
  switch (source) {
    case '1password':
      return import1Password(store, content, options);
    case 'bitwarden':
      return importBitwarden(store, content, options);
    case 'lastpass':
      return importLastPass(store, content, options);
    case 'keepass':
      return importKeePass(store, content, options);
    case 'csv':
      // Generic CSV (same as 1Password format)
      return import1Password(store, content, options);
    default:
      throw new Error(`Unsupported import source: ${source}`);
  }
}

/**
 * Importer class for OOP-style usage
 */
export class Importer {
  constructor(private store: Store) {}

  async importFrom(
    source: ImportSource,
    content: string,
    options: ImportOptions = {}
  ): Promise<ImportResult> {
    return importPasswords(this.store, source, content, options);
  }
}
