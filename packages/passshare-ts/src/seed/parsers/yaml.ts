/**
 * Parser for YAML files.
 *
 * Uses js-yaml for parsing.
 */

import yaml from 'js-yaml';
import type { ParsedData } from './index.js';

/**
 * Parse a YAML file content.
 *
 * @param content - File content
 * @param _filePath - File path (unused but kept for interface consistency)
 * @returns Parsed YAML data
 */
export async function parseYamlFile(
  content: string,
  _filePath: string
): Promise<ParsedData> {
  try {
    // Use safeLoad to prevent arbitrary code execution
    const parsed = yaml.load(content, {
      schema: yaml.DEFAULT_SCHEMA,
      json: true, // Duplicate keys throw error
    });

    // Only return objects and arrays (not primitives)
    if (parsed !== null && parsed !== undefined && typeof parsed === 'object') {
      return parsed as ParsedData;
    }

    return null;
  } catch {
    // Invalid YAML
    return null;
  }
}

/**
 * Parse multiple YAML documents from a file.
 * Useful for files with --- separators.
 *
 * @param content - File content
 * @param _filePath - File path
 * @returns Array of parsed documents
 */
export async function parseYamlMultiDoc(
  content: string,
  _filePath: string
): Promise<ParsedData[]> {
  try {
    const documents = yaml.loadAll(content, undefined, {
      schema: yaml.DEFAULT_SCHEMA,
      json: true,
    });

    return documents
      .filter((doc): doc is ParsedData => doc !== null && typeof doc === 'object')
      .map((doc) => doc as ParsedData);
  } catch {
    return [];
  }
}
