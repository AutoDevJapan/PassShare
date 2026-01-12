/**
 * Parser for Python files.
 *
 * Uses regex-based extraction to find dictionaries and lists
 * containing credential-like data.
 */

import type { ParsedData } from './index.js';

/**
 * Parse a Python file content.
 *
 * @param content - File content
 * @param _filePath - File path
 * @returns Extracted data structures
 */
export async function parsePythonFile(
  content: string,
  _filePath: string
): Promise<ParsedData> {
  const results: Record<string, unknown>[] = [];

  // Strategy 1: Extract dictionary literals
  const dictLiterals = extractDictLiterals(content);
  results.push(...dictLiterals);

  // Strategy 2: Extract variable assignments
  const assignments = extractPythonAssignments(content);
  if (Object.keys(assignments).length > 0) {
    results.push(assignments);
  }

  // Strategy 3: Extract from list of dicts (common in seed files)
  const listData = extractListOfDicts(content);
  results.push(...listData);

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
 * Extract dictionary literals from Python code.
 */
function extractDictLiterals(content: string): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];

  // Regex to find dict-like structures with credential keys
  // Python uses both single and double quotes
  const dictPattern =
    /\{[^{}]*(?:["'](?:email|password|user|login|token|api[_-]?key|secret)["'])[^{}]*\}/gi;

  const matches = content.matchAll(dictPattern);

  for (const match of matches) {
    const dictStr = match[0];
    const parsed = parsePythonDict(dictStr);

    if (parsed && Object.keys(parsed).length > 0) {
      results.push(parsed);
    }
  }

  return results;
}

/**
 * Parse a Python dictionary literal into a JavaScript object.
 */
function parsePythonDict(str: string): Record<string, unknown> | null {
  const result: Record<string, unknown> = {};

  // Remove outer braces
  const inner = str.slice(1, -1).trim();
  if (!inner) return null;

  // Match key-value pairs
  // Python style: "key": "value" or 'key': 'value'
  const pairPattern =
    /["'](\w+)["']\s*:\s*(?:["']([^"'\\]*(?:\\.[^"'\\]*)*)["']|(\d+(?:\.\d+)?)|(\w+))/g;

  let pairMatch;
  while ((pairMatch = pairPattern.exec(inner)) !== null) {
    const key = pairMatch[1];
    const value = pairMatch[2] ?? pairMatch[3] ?? pairMatch[4];

    if (key && value !== undefined) {
      // Handle Python's True/False/None
      if (value === 'True') {
        result[key] = true;
      } else if (value === 'False') {
        result[key] = false;
      } else if (value === 'None') {
        result[key] = null;
      } else {
        result[key] = value;
      }
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Extract variable assignments that look like credentials.
 */
function extractPythonAssignments(content: string): Record<string, string> {
  const result: Record<string, string> = {};

  // Pattern: EMAIL = "value" or password = 'value'
  const assignmentPatterns = [
    // Simple assignment (uppercase convention for constants)
    /^(\w*(?:EMAIL|PASSWORD|USER|LOGIN|TOKEN|API[_]?KEY|SECRET)\w*)\s*=\s*["']([^"']+)["']/gim,
    // os.environ.get("KEY", "default")
    /os\.environ\.get\(\s*["'](\w+)["']\s*,\s*["']([^"']+)["']\s*\)/gi,
    // os.getenv("KEY", "default")
    /os\.getenv\(\s*["'](\w+)["']\s*,\s*["']([^"']+)["']\s*\)/gi,
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
 * Extract data from list of dictionaries.
 * Common pattern: USERS = [{"email": "...", "password": "..."}, ...]
 */
function extractListOfDicts(content: string): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];

  // Look for list assignments with dicts inside
  const listPattern =
    /\w+\s*=\s*\[\s*\{[^[\]]*(?:["'](?:email|password|user)["'])[^[\]]*\}[^\]]*\]/gi;

  const matches = content.matchAll(listPattern);

  for (const match of matches) {
    const listStr = match[0];

    // Extract individual dicts from the list
    const dictPattern = /\{[^{}]+\}/g;
    let dictMatch;

    while ((dictMatch = dictPattern.exec(listStr)) !== null) {
      const parsed = parsePythonDict(dictMatch[0]);
      if (parsed) {
        results.push(parsed);
      }
    }
  }

  return results;
}

/**
 * Extract Django/Flask fixture-style data.
 */
export function extractFixtureData(content: string): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];

  // Django fixture pattern: {"model": "app.model", "fields": {...}}
  const fixturePattern = /\{\s*["']model["']\s*:\s*["'][^"']+["']\s*,\s*["'](?:pk|id)["']\s*:\s*\d+\s*,\s*["']fields["']\s*:\s*(\{[^{}]+\})/gi;

  const matches = content.matchAll(fixturePattern);

  for (const match of matches) {
    const fieldsStr = match[1];
    const parsed = parsePythonDict(fieldsStr);
    if (parsed) {
      results.push(parsed);
    }
  }

  return results;
}
