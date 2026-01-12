/**
 * Parser for .env files.
 *
 * Supports:
 * - KEY=value
 * - KEY="quoted value"
 * - KEY='single quoted'
 * - # comments
 * - export KEY=value
 */

import type { ParsedData } from './index.js';

/**
 * Parse a .env file content.
 *
 * @param content - File content
 * @param _filePath - File path (unused but kept for interface consistency)
 * @returns Parsed key-value pairs
 */
export async function parseEnvFile(
  content: string,
  _filePath: string
): Promise<ParsedData> {
  const result: Record<string, string> = {};
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    // Remove 'export ' prefix if present
    const withoutExport = trimmed.startsWith('export ')
      ? trimmed.slice(7).trim()
      : trimmed;

    // Find the first '=' sign
    const eqIndex = withoutExport.indexOf('=');
    if (eqIndex === -1) {
      continue;
    }

    const key = withoutExport.slice(0, eqIndex).trim();
    let value = withoutExport.slice(eqIndex + 1).trim();

    // Skip if key is empty
    if (!key) {
      continue;
    }

    // Remove surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // Handle escape sequences in double-quoted values
    if (withoutExport.slice(eqIndex + 1).trim().startsWith('"')) {
      value = value
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\\\/g, '\\')
        .replace(/\\"/g, '"');
    }

    result[key] = value;
  }

  return result;
}
