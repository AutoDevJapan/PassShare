/**
 * Export functionality for PassShare.
 *
 * Supports exporting to:
 * - PassShare JSON (native format)
 * - Bitwarden JSON
 * - CSV (generic)
 *
 * © 2026 BM1314 Inc. All rights reserved.
 */

import type { Gopass } from './gopass.js';

/**
 * Supported export formats
 */
export type ExportFormat = 'passshare' | 'bitwarden' | 'csv';

/**
 * Export result
 */
export interface ExportResult {
  total: number;
  exported: number;
  skipped: number;
  errors: string[];
  content: string;
}

/**
 * Export options
 */
export interface ExportOptions {
  prefix?: string;
}

/**
 * Export to PassShare native JSON format
 */
async function exportPassShareJSON(
  gopass: Gopass,
  options: ExportOptions = {}
): Promise<ExportResult> {
  const result: ExportResult = {
    total: 0,
    exported: 0,
    skipped: 0,
    errors: [],
    content: '',
  };

  const items: Array<{
    name: string;
    password: string;
    data: Record<string, string>;
    body?: string;
  }> = [];

  const secrets = await gopass.list(options.prefix || '');

  for (const name of secrets) {
    result.total++;

    try {
      const secret = await gopass.get(name);

      const item: {
        name: string;
        password: string;
        data: Record<string, string>;
        body?: string;
      } = {
        name,
        password: secret.password,
        data: Object.fromEntries(secret.data),
      };

      if (secret.body) {
        item.body = secret.body;
      }

      items.push(item);
      result.exported++;
    } catch (e) {
      result.errors.push(`Error exporting '${name}': ${e}`);
    }
  }

  const exportData = {
    version: '1.0',
    generator: 'passshare',
    items,
  };

  result.content = JSON.stringify(exportData, null, 2);
  return result;
}

/**
 * Export to Bitwarden JSON format
 */
async function exportBitwardenJSON(
  gopass: Gopass,
  options: ExportOptions = {}
): Promise<ExportResult> {
  const result: ExportResult = {
    total: 0,
    exported: 0,
    skipped: 0,
    errors: [],
    content: '',
  };

  const items: Array<Record<string, unknown>> = [];
  const folderSet = new Set<string>();

  const secrets = await gopass.list(options.prefix || '');

  for (const name of secrets) {
    result.total++;

    try {
      const secret = await gopass.get(name);
      const data = Object.fromEntries(secret.data);

      // Determine item type
      let itemType = 1; // Default: login
      if (data.cardNumber || (data.number && data.expiry)) {
        itemType = 3; // Card
      } else if (!secret.password && secret.body) {
        itemType = 2; // Secure note
      }

      const displayName = name.includes('/') ? name.split('/').pop()! : name;

      const item: Record<string, unknown> = {
        name: displayName,
        type: itemType,
        notes: data.notes || secret.body || '',
      };

      // Login fields
      if (itemType === 1) {
        const uris: Array<{ uri: string }> = [];
        if (data.url) {
          uris.push({ uri: data.url });
        }

        item.login = {
          username: data.username || data.login || '',
          password: secret.password,
          uris,
          totp: data.totp || '',
        };
      }

      // Card fields
      if (itemType === 3) {
        const expiry = data.expiry || '';
        let expMonth = data.expMonth || '';
        let expYear = data.expYear || '';

        if (expiry && expiry.includes('/')) {
          const parts = expiry.split('/');
          if (parts.length === 2) {
            expMonth = parts[0];
            expYear = parts[1];
          }
        }

        item.card = {
          cardholderName: data.holder || data.cardholderName || '',
          number: data.number || data.cardNumber || '',
          expMonth,
          expYear,
          code: data.cvv || data.code || '',
          brand: data.type || data.brand || '',
        };
      }

      // Custom fields
      const skipFields = new Set([
        'username', 'login', 'password', 'url', 'notes', 'totp',
        'number', 'holder', 'expiry', 'cvv', 'type', 'cardNumber',
        'cardholderName', 'expMonth', 'expYear', 'code', 'brand',
      ]);

      const customFields: Array<{ name: string; value: string; type: number }> = [];
      for (const [key, value] of Object.entries(data)) {
        if (!skipFields.has(key) && value) {
          customFields.push({ name: key, value, type: 0 });
        }
      }

      if (customFields.length > 0) {
        item.fields = customFields;
      }

      // Folder from path
      if (name.includes('/')) {
        const folder = name.substring(0, name.lastIndexOf('/'));
        item.folderId = folder;
        folderSet.add(folder);
      }

      items.push(item);
      result.exported++;
    } catch (e) {
      result.errors.push(`Error exporting '${name}': ${e}`);
    }
  }

  const exportData = {
    encrypted: false,
    folders: Array.from(folderSet).sort().map(f => ({ id: f, name: f })),
    items,
  };

  result.content = JSON.stringify(exportData, null, 2);
  return result;
}

/**
 * Export to CSV format
 */
async function exportCSV(
  gopass: Gopass,
  options: ExportOptions = {}
): Promise<ExportResult> {
  const result: ExportResult = {
    total: 0,
    exported: 0,
    skipped: 0,
    errors: [],
    content: '',
  };

  const lines: string[] = [];
  lines.push('name,username,password,url,notes,totp');

  const secrets = await gopass.list(options.prefix || '');

  for (const name of secrets) {
    result.total++;

    try {
      const secret = await gopass.get(name);
      const data = Object.fromEntries(secret.data);

      const row = [
        escapeCSV(name),
        escapeCSV(data.username || data.login || ''),
        escapeCSV(secret.password),
        escapeCSV(data.url || ''),
        escapeCSV(data.notes || secret.body || ''),
        escapeCSV(data.totp || ''),
      ];

      lines.push(row.join(','));
      result.exported++;
    } catch (e) {
      result.errors.push(`Error exporting '${name}': ${e}`);
    }
  }

  result.content = lines.join('\n');
  return result;
}

/**
 * Escape a value for CSV
 */
function escapeCSV(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Export passwords to various formats
 */
export async function exportPasswords(
  gopass: Gopass,
  format: ExportFormat,
  options: ExportOptions = {}
): Promise<ExportResult> {
  switch (format) {
    case 'passshare':
      return exportPassShareJSON(gopass, options);
    case 'bitwarden':
      return exportBitwardenJSON(gopass, options);
    case 'csv':
      return exportCSV(gopass, options);
    default:
      throw new Error(`Unsupported export format: ${format}`);
  }
}

/**
 * Exporter class for OOP-style usage
 */
export class Exporter {
  constructor(private gopass: Gopass) {}

  async exportTo(
    format: ExportFormat,
    options: ExportOptions = {}
  ): Promise<ExportResult> {
    return exportPasswords(this.gopass, format, options);
  }
}
