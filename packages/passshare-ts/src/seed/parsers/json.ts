/**
 * Parser for JSON files.
 *
 * Supports:
 * - Standard JSON
 * - JSON with comments (JSONC) - strips comments before parsing
 */

import type { ParsedData } from './index.js';

/**
 * Parse a JSON file content.
 *
 * @param content - File content
 * @param _filePath - File path (unused but kept for interface consistency)
 * @returns Parsed JSON data
 */
export async function parseJsonFile(
  content: string,
  _filePath: string
): Promise<ParsedData> {
  // Strip comments (JSONC support)
  const withoutComments = stripJsonComments(content);

  try {
    const parsed = JSON.parse(withoutComments);

    // Only return objects and arrays (not primitives)
    if (parsed !== null && typeof parsed === 'object') {
      return parsed as ParsedData;
    }

    return null;
  } catch {
    // Invalid JSON
    return null;
  }
}

/**
 * Strip comments from JSON content.
 * Handles both single-line (//) and multi-line comment styles.
 */
function stripJsonComments(content: string): string {
  let result = '';
  let i = 0;
  let inString = false;
  let stringChar = '';

  while (i < content.length) {
    const char = content[i];
    const nextChar = content[i + 1];

    // Handle string boundaries
    if (!inString && (char === '"' || char === "'")) {
      inString = true;
      stringChar = char;
      result += char;
      i++;
      continue;
    }

    if (inString) {
      result += char;

      // Check for escape sequences
      if (char === '\\' && i + 1 < content.length) {
        result += nextChar;
        i += 2;
        continue;
      }

      // Check for end of string
      if (char === stringChar) {
        inString = false;
      }

      i++;
      continue;
    }

    // Not in string - check for comments
    if (char === '/' && nextChar === '/') {
      // Single-line comment - skip to end of line
      while (i < content.length && content[i] !== '\n') {
        i++;
      }
      continue;
    }

    if (char === '/' && nextChar === '*') {
      // Multi-line comment - skip to */
      i += 2;
      while (i < content.length - 1) {
        if (content[i] === '*' && content[i + 1] === '/') {
          i += 2;
          break;
        }
        i++;
      }
      continue;
    }

    result += char;
    i++;
  }

  return result;
}
