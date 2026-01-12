/**
 * Directory scanner for seed files.
 */

import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as nodePath from 'path';
import {
  ScanResult,
  ScanOptions,
  CredentialGroup,
  DEFAULT_IGNORE_PATTERNS,
} from './types.js';
import { CredentialExtractor } from './extractor.js';
import { parseFile, getSupportedExtensions } from './parsers/index.js';

const DEFAULT_MAX_FILE_SIZE = 1024 * 1024; // 1MB

/**
 * Scans directories for seed files containing credentials.
 */
export class SeedScanner {
  private readonly _extractor: CredentialExtractor;
  private readonly _options: Required<ScanOptions>;

  /**
   * Create a new scanner.
   *
   * @param options - Scan options
   */
  constructor(options: ScanOptions = {}) {
    this._extractor = new CredentialExtractor(options.customFields);
    this._options = {
      customFields: options.customFields ?? [],
      maxFileSize: options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE,
      ignorePatterns: options.ignorePatterns ?? DEFAULT_IGNORE_PATTERNS,
      includeHidden: options.includeHidden ?? false,
    };
  }

  /**
   * Scan a directory for seed files.
   *
   * @param directory - The directory to scan
   * @param projectName - Name for the project/vault (defaults to directory name)
   * @returns Scan results with detected credentials
   */
  async scan(directory: string, projectName?: string): Promise<ScanResult> {
    const resolvedDir = nodePath.resolve(directory);
    const name = projectName ?? nodePath.basename(resolvedDir);

    const result: ScanResult = {
      projectName: name,
      rootDir: resolvedDir,
      credentials: [],
      scannedFiles: [],
      skippedFiles: [],
      errors: [],
    };

    // Check if directory exists
    if (!fs.existsSync(resolvedDir)) {
      result.errors.push({
        file: resolvedDir,
        error: 'Directory does not exist',
      });
      return result;
    }

    // Collect all files
    const files = await this.collectFiles(resolvedDir, result);

    // Parse each file and extract credentials
    const allCredentials: CredentialGroup[] = [];

    for (const file of files) {
      try {
        const content = await fsPromises.readFile(file, 'utf-8');
        const parsed = await parseFile(file, content);

        if (parsed !== null) {
          const credentials = this._extractor.extractFromObject(parsed, file);

          if (credentials.length > 0) {
            const groups = this._extractor.groupCredentials(credentials, name);
            allCredentials.push(...groups);
          }

          result.scannedFiles.push(file);
        }
      } catch (error) {
        result.errors.push({
          file,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Merge duplicate groups
    result.credentials = this.mergeGroups(allCredentials);

    return result;
  }

  /**
   * Collect all scannable files from a directory.
   */
  private async collectFiles(
    dir: string,
    result: ScanResult
  ): Promise<string[]> {
    const files: string[] = [];
    const supportedExtensions = getSupportedExtensions();

    const walk = async (currentDir: string): Promise<void> => {
      let entries: fs.Dirent[];

      try {
        entries = await fsPromises.readdir(currentDir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const fullPath = nodePath.join(currentDir, entry.name);

        // Skip hidden files/directories unless explicitly included
        if (!this._options.includeHidden && entry.name.startsWith('.')) {
          // Exception: .env files are important
          if (!entry.name.startsWith('.env')) {
            continue;
          }
        }

        // Check ignore patterns
        if (this.shouldIgnore(entry.name, fullPath)) {
          continue;
        }

        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile()) {
          // Check file extension
          const ext = nodePath.extname(entry.name).toLowerCase();
          const basename = entry.name.toLowerCase();

          // Special case for .env files (no extension check needed)
          const isSupportedExt = supportedExtensions.includes(ext);
          const isEnvFile = basename.startsWith('.env') || basename.endsWith('.env');

          if (!isSupportedExt && !isEnvFile) {
            continue;
          }

          // Check file size
          try {
            const stat = await fsPromises.stat(fullPath);
            if (stat.size > this._options.maxFileSize) {
              result.skippedFiles.push(fullPath);
              continue;
            }
          } catch {
            continue;
          }

          files.push(fullPath);
        }
      }
    };

    await walk(dir);
    return files;
  }

  /**
   * Check if a file/directory should be ignored.
   */
  private shouldIgnore(name: string, fullPath: string): boolean {
    for (const pattern of this._options.ignorePatterns) {
      // Simple glob matching
      if (pattern.includes('*')) {
        const regex = new RegExp(
          '^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
        );
        if (regex.test(name)) {
          return true;
        }
      } else if (name === pattern || fullPath.includes(pattern)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Merge credential groups with the same name.
   */
  private mergeGroups(groups: CredentialGroup[]): CredentialGroup[] {
    const merged: Map<string, CredentialGroup> = new Map();

    for (const group of groups) {
      // Skip groups without meaningful credentials
      if (!group.email && !group.password && Object.keys(group.extras).length === 0) {
        continue;
      }

      const existing = merged.get(group.name);

      if (existing) {
        // Merge with existing
        existing.email = existing.email || group.email;
        existing.password = existing.password || group.password;
        Object.assign(existing.extras, group.extras);
      } else {
        merged.set(group.name, { ...group });
      }
    }

    return Array.from(merged.values());
  }
}

/**
 * Convenience function to scan a directory.
 */
export async function scanDirectory(
  directory: string,
  options?: ScanOptions & { projectName?: string }
): Promise<ScanResult> {
  const scanner = new SeedScanner(options);
  return scanner.scan(directory, options?.projectName);
}
