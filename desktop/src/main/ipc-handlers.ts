/**
 * IPC Handlers for PassShare operations
 *
 * Placeholder implementation for initial release
 */

import { ipcMain, dialog, BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

// Types for scan results (matching passshare-core types)
interface CredentialGroup {
  file: string;
  name: string;
  email?: string;
  password?: string;
  extras: Record<string, string>;
}

interface ScanResult {
  projectName: string;
  rootDir: string;
  credentials: CredentialGroup[];
  scannedFiles: string[];
  skippedFiles: string[];
  errors: Array<{ file: string; error: string }>;
}

export function setupIpcHandlers(): void {
  // List secrets (placeholder)
  ipcMain.handle('passshare:list', async () => {
    return { success: true, data: [] };
  });

  // Get secret (placeholder)
  ipcMain.handle('passshare:get', async (_, name: string) => {
    return {
      success: true,
      data: {
        name,
        password: '',
        data: {},
        notes: '',
        hasOtp: false,
      },
    };
  });

  // Set secret (placeholder)
  ipcMain.handle(
    'passshare:set',
    async (_, name: string, data: { password: string; data?: Record<string, string> }) => {
      // Placeholder - in real implementation, this would save to the store
      console.log(`[IPC] passshare:set called for ${name}`);
      return { success: true };
    }
  );

  // Check if initialized (placeholder)
  ipcMain.handle('passshare:initialized', async () => {
    return { success: true, data: false };
  });

  // Scan directory for seed data
  ipcMain.handle('passshare:scan', async (event) => {
    try {
      // Get the focused window for the dialog
      const focusedWindow = BrowserWindow.fromWebContents(event.sender);

      // Open directory picker
      const result = await dialog.showOpenDialog(focusedWindow || undefined as any, {
        title: 'スキャンするプロジェクトフォルダを選択',
        properties: ['openDirectory'],
        buttonLabel: 'スキャン',
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, cancelled: true };
      }

      const directory = result.filePaths[0];
      const projectName = path.basename(directory);

      // Perform scan using built-in simple scanner
      // Note: In production, this would import SeedScanner from passshare-core
      const scanResult = await performScan(directory, projectName);

      return { success: true, data: scanResult };
    } catch (error) {
      console.error('[IPC] Scan error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

/**
 * Simple built-in scanner for Electron main process.
 * This is a simplified version that scans common seed file patterns.
 */
async function performScan(directory: string, projectName: string): Promise<ScanResult> {
  const result: ScanResult = {
    projectName,
    rootDir: directory,
    credentials: [],
    scannedFiles: [],
    skippedFiles: [],
    errors: [],
  };

  // Credential field patterns
  const credentialPatterns = [
    /email/i,
    /password/i,
    /passwd/i,
    /pwd/i,
    /username/i,
    /user/i,
    /login/i,
    /token/i,
    /api[_-]?key/i,
    /secret/i,
  ];

  // File patterns to scan
  const filePatterns = ['.env', '.json', '.yaml', '.yml'];

  // Ignore patterns
  const ignorePatterns = ['node_modules', '.git', 'dist', 'build', '__pycache__'];

  // Walk directory
  const walkDir = async (dir: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      // Skip ignored directories
      if (ignorePatterns.some((p) => entry.name === p || fullPath.includes(p))) {
        continue;
      }

      if (entry.isDirectory()) {
        await walkDir(fullPath);
      } else if (entry.isFile()) {
        // Check file extension
        const ext = path.extname(entry.name).toLowerCase();
        const isEnvFile = entry.name.startsWith('.env') || entry.name.endsWith('.env');

        if (!filePatterns.includes(ext) && !isEnvFile) {
          continue;
        }

        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const extracted = extractCredentials(content, fullPath, entry.name, projectName);

          if (extracted.length > 0) {
            result.credentials.push(...extracted);
          }

          result.scannedFiles.push(fullPath);
        } catch (err) {
          result.errors.push({
            file: fullPath,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  };

  await walkDir(directory);

  // Merge duplicate credentials by name
  const merged = new Map<string, CredentialGroup>();
  for (const cred of result.credentials) {
    const existing = merged.get(cred.name);
    if (existing) {
      existing.email = existing.email || cred.email;
      existing.password = existing.password || cred.password;
      Object.assign(existing.extras, cred.extras);
    } else {
      merged.set(cred.name, { ...cred });
    }
  }
  result.credentials = Array.from(merged.values());

  return result;
}

/**
 * Extract credentials from file content.
 */
function extractCredentials(
  content: string,
  filePath: string,
  fileName: string,
  projectName: string
): CredentialGroup[] {
  const results: CredentialGroup[] = [];

  // Parse based on file type
  if (fileName.startsWith('.env') || fileName.endsWith('.env')) {
    // .env file format
    const group: CredentialGroup = {
      file: filePath,
      name: `${projectName}/env`,
      extras: {},
    };

    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;

      const key = trimmed.slice(0, eqIndex).trim().replace(/^export\s+/, '');
      let value = trimmed.slice(eqIndex + 1).trim();

      // Remove quotes
      if ((value.startsWith('"') && value.endsWith('"')) || 
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      // Check if credential-like
      const keyLower = key.toLowerCase();
      if (/email|mail/i.test(keyLower)) {
        group.email = value;
      } else if (/password|passwd|pwd/i.test(keyLower)) {
        group.password = value;
      } else if (/token|key|secret|credential/i.test(keyLower)) {
        group.extras[key] = value;
      }
    }

    if (group.email || group.password || Object.keys(group.extras).length > 0) {
      results.push(group);
    }
  } else if (fileName.endsWith('.json')) {
    // JSON file
    try {
      const data = JSON.parse(content);
      extractFromObject(data, filePath, projectName, results);
    } catch {
      // Invalid JSON
    }
  } else if (fileName.endsWith('.yaml') || fileName.endsWith('.yml')) {
    // YAML - simple extraction using regex (no yaml parser in main process)
    const group: CredentialGroup = {
      file: filePath,
      name: `${projectName}/${path.basename(fileName, path.extname(fileName))}`,
      extras: {},
    };

    // Simple YAML key-value extraction
    const yamlPattern = /^(\s*)(\w+):\s*["']?([^"'\n]+)["']?\s*$/gm;
    let match;
    while ((match = yamlPattern.exec(content)) !== null) {
      const key = match[2];
      const value = match[3].trim();
      const keyLower = key.toLowerCase();

      if (/email|mail/i.test(keyLower)) {
        group.email = value;
      } else if (/password|passwd|pwd/i.test(keyLower)) {
        group.password = value;
      } else if (/token|key|secret|credential|user/i.test(keyLower)) {
        group.extras[key] = value;
      }
    }

    if (group.email || group.password || Object.keys(group.extras).length > 0) {
      results.push(group);
    }
  }

  return results;
}

/**
 * Recursively extract credentials from an object.
 */
function extractFromObject(
  obj: unknown,
  filePath: string,
  projectName: string,
  results: CredentialGroup[],
  context: string = ''
): void {
  if (obj === null || obj === undefined) return;

  if (Array.isArray(obj)) {
    obj.forEach((item, index) => {
      extractFromObject(item, filePath, projectName, results, `${context}[${index}]`);
    });
  } else if (typeof obj === 'object') {
    const group: CredentialGroup = {
      file: filePath,
      name: `${projectName}${context ? '/' + context.replace(/\[|\]/g, '').replace(/\./g, '/') : ''}`,
      extras: {},
    };

    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const keyLower = key.toLowerCase();

      if (typeof value === 'string') {
        if (/email|mail/i.test(keyLower)) {
          group.email = value;
        } else if (/password|passwd|pwd/i.test(keyLower)) {
          group.password = value;
        } else if (/token|key|secret|credential|user/i.test(keyLower)) {
          group.extras[key] = value;
        }
      } else if (value !== null && typeof value === 'object') {
        // Recurse
        extractFromObject(value, filePath, projectName, results, `${context}.${key}`);
      }
    }

    if (group.email || group.password || Object.keys(group.extras).length > 0) {
      results.push(group);
    }
  }
}
