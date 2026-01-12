/**
 * Parser for JavaScript/TypeScript files.
 *
 * Uses regex-based extraction to find object literals and arrays
 * containing credential-like data. This is a best-effort parser
 * that doesn't require a full AST.
 */

import type { ParsedData } from './index.js';

/**
 * Parse a JavaScript/TypeScript file content.
 *
 * @param content - File content
 * @param _filePath - File path
 * @returns Extracted data structures
 */
export async function parseJavaScriptFile(
  content: string,
  _filePath: string
): Promise<ParsedData> {
  const results: Record<string, unknown>[] = [];

  // Strategy 1: Extract object literals with credential-like keys
  const objectLiterals = extractObjectLiterals(content);
  results.push(...objectLiterals);

  // Strategy 2: Extract key-value assignments
  const assignments = extractAssignments(content);
  if (Object.keys(assignments).length > 0) {
    results.push(assignments);
  }

  // Combine all results
  if (results.length === 0) {
    return null;
  }

  if (results.length === 1) {
    return results[0];
  }

  return results;
}

/**
 * Extract object literals from JavaScript code.
 * Looks for patterns like: { email: "...", password: "..." }
 */
function extractObjectLiterals(content: string): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];

  // Regex to find object-like structures with string values
  // Matches: { key: "value", key2: 'value2' }
  const objectPattern = /\{[^{}]*(?:email|password|user|login|token|api[_-]?key|secret)[^{}]*\}/gi;

  const matches = content.matchAll(objectPattern);

  for (const match of matches) {
    const objectStr = match[0];
    const parsed = parseObjectLiteral(objectStr);

    if (parsed && Object.keys(parsed).length > 0) {
      results.push(parsed);
    }
  }

  return results;
}

/**
 * Parse a single object literal string into a JavaScript object.
 */
function parseObjectLiteral(str: string): Record<string, unknown> | null {
  const result: Record<string, unknown> = {};

  // Remove outer braces
  const inner = str.slice(1, -1).trim();
  if (!inner) return null;

  // Match key-value pairs
  // Supports: key: "value", key: 'value', key: `value`, "key": value
  const pairPattern =
    /(?:["']?(\w+)["']?)\s*:\s*(?:"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|`([^`\\]*(?:\\.[^`\\]*)*)`|(\d+(?:\.\d+)?)|(\w+))/g;

  let pairMatch;
  while ((pairMatch = pairPattern.exec(inner)) !== null) {
    const key = pairMatch[1];
    // Value is in one of the capture groups 2-6
    const value =
      pairMatch[2] ?? pairMatch[3] ?? pairMatch[4] ?? pairMatch[5] ?? pairMatch[6];

    if (key && value !== undefined) {
      result[key] = value;
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Extract variable assignments that look like credentials.
 */
function extractAssignments(content: string): Record<string, string> {
  const result: Record<string, string> = {};

  // Pattern: const EMAIL = "value" or let password = 'value'
  const assignmentPatterns = [
    // const/let/var assignment
    /(?:const|let|var)\s+(\w*(?:email|password|user|login|token|api[_-]?key|secret)\w*)\s*=\s*["'`]([^"'`]+)["'`]/gi,
    // module.exports.KEY = "value"
    /module\.exports\.(\w+)\s*=\s*["'`]([^"'`]+)["'`]/gi,
    // exports.KEY = "value"
    /exports\.(\w+)\s*=\s*["'`]([^"'`]+)["'`]/gi,
    // process.env.KEY || "default"
    /process\.env\.(\w*(?:password|secret|token|key)\w*)\s*\|\|\s*["'`]([^"'`]+)["'`]/gi,
  ];

  for (const pattern of assignmentPatterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const key = match[1];
      const value = match[2];

      if (key && value && !result[key]) {
        result[key] = value;
      }
    }
  }

  return result;
}

/**
 * Extract data from array literals.
 */
export function extractArrayData(content: string): unknown[] {
  const results: unknown[] = [];

  // Look for arrays of objects with credential fields
  const arrayPattern = /\[\s*\{[^[\]]*(?:email|password|user)[^[\]]*\}\s*(?:,\s*\{[^[\]]*\}\s*)*\]/gi;

  const matches = content.matchAll(arrayPattern);

  for (const match of matches) {
    const arrayStr = match[0];

    // Extract individual objects from the array
    const objectPattern = /\{[^{}]+\}/g;
    let objMatch;

    while ((objMatch = objectPattern.exec(arrayStr)) !== null) {
      const parsed = parseObjectLiteral(objMatch[0]);
      if (parsed) {
        results.push(parsed);
      }
    }
  }

  return results;
}
