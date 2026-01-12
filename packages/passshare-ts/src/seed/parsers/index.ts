/**
 * Parser registry and dispatch.
 */

import * as nodePath from 'path';
import { parseEnvFile } from './env.js';
import { parseJsonFile } from './json.js';
import { parseYamlFile } from './yaml.js';
import { parseCsvFile } from './csv.js';
import { parseJavaScriptFile } from './javascript.js';
import { parsePythonFile } from './python.js';

export type ParsedData = Record<string, unknown> | unknown[] | null;

export interface Parser {
  extensions: string[];
  parse: (content: string, filePath: string) => Promise<ParsedData>;
}

/**
 * All registered parsers.
 */
const parsers: Parser[] = [
  {
    extensions: ['.env'],
    parse: parseEnvFile,
  },
  {
    extensions: ['.json'],
    parse: parseJsonFile,
  },
  {
    extensions: ['.yaml', '.yml'],
    parse: parseYamlFile,
  },
  {
    extensions: ['.csv'],
    parse: parseCsvFile,
  },
  {
    extensions: ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'],
    parse: parseJavaScriptFile,
  },
  {
    extensions: ['.py'],
    parse: parsePythonFile,
  },
];

/**
 * Get all supported file extensions.
 */
export function getSupportedExtensions(): string[] {
  const extensions: string[] = [];
  for (const parser of parsers) {
    extensions.push(...parser.extensions);
  }
  return extensions;
}

/**
 * Parse a file based on its extension.
 *
 * @param filePath - Path to the file
 * @param content - File content
 * @returns Parsed data or null if unsupported
 */
export async function parseFile(
  filePath: string,
  content: string
): Promise<ParsedData> {
  const ext = nodePath.extname(filePath).toLowerCase();
  const basename = nodePath.basename(filePath).toLowerCase();

  // Special case for .env files (they may not have an extension)
  if (basename.startsWith('.env') || basename.endsWith('.env')) {
    return parseEnvFile(content, filePath);
  }

  // Find matching parser
  for (const parser of parsers) {
    if (parser.extensions.includes(ext)) {
      return parser.parse(content, filePath);
    }
  }

  return null;
}

// Re-export individual parsers
export { parseEnvFile } from './env.js';
export { parseJsonFile } from './json.js';
export { parseYamlFile } from './yaml.js';
export { parseCsvFile } from './csv.js';
export { parseJavaScriptFile } from './javascript.js';
export { parsePythonFile } from './python.js';
