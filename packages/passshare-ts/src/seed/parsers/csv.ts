/**
 * Parser for CSV files.
 *
 * Parses CSV into an array of objects using the first row as headers.
 */

import type { ParsedData } from './index.js';

/**
 * Parse a CSV file content.
 *
 * @param content - File content
 * @param _filePath - File path (unused but kept for interface consistency)
 * @returns Array of objects with header keys
 */
export async function parseCsvFile(
  content: string,
  _filePath: string
): Promise<ParsedData> {
  const lines = content.split('\n').map((line) => line.trim());

  // Need at least a header and one data row
  if (lines.length < 2) {
    return null;
  }

  // Parse header row
  const headers = parseCsvLine(lines[0]);
  if (headers.length === 0) {
    return null;
  }

  // Parse data rows
  const result: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    const values = parseCsvLine(line);
    const row: Record<string, string> = {};

    for (let j = 0; j < headers.length; j++) {
      const header = headers[j];
      const value = values[j] ?? '';

      if (header) {
        row[header] = value;
      }
    }

    // Only add rows that have at least one non-empty value
    if (Object.values(row).some((v) => v.trim())) {
      result.push(row);
    }
  }

  return result.length > 0 ? result : null;
}

/**
 * Parse a single CSV line into values.
 * Handles quoted values with commas inside.
 */
function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;
  let quoteChar = '';

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (!inQuotes) {
      if (char === '"' || char === "'") {
        inQuotes = true;
        quoteChar = char;
        continue;
      }

      if (char === ',') {
        values.push(current.trim());
        current = '';
        continue;
      }

      current += char;
    } else {
      // Inside quotes
      if (char === quoteChar) {
        // Check for escaped quote (doubled)
        if (i + 1 < line.length && line[i + 1] === quoteChar) {
          current += quoteChar;
          i++;
          continue;
        }

        // End of quoted section
        inQuotes = false;
        continue;
      }

      current += char;
    }
  }

  // Add the last value
  values.push(current.trim());

  return values;
}
