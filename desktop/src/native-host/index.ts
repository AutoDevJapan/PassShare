#!/usr/bin/env node
/**
 * PassShare Native Messaging Host
 *
 * This script handles communication between browser extensions and the PassShare desktop app.
 * It implements the Chrome Native Messaging protocol (4-byte length prefix + JSON).
 *
 * © 2026 株式会社BM1314. All rights reserved.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Types
interface NativeMessage {
  id: string;
  type: string;
  payload?: unknown;
}

interface NativeResponse {
  id: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

interface CredentialEntry {
  source: string;
  email?: string;
  password?: string;
  extras: Record<string, string>;
}

interface ProjectVault {
  name: string;
  path: string;
  credentials: CredentialEntry[];
}

interface ProjectConfig {
  registeredProjects: string[];
}

// Get config path (same as desktop app)
function getConfigPath(): string {
  const platform = process.platform;
  let configDir: string;

  if (platform === 'win32') {
    configDir = path.join(process.env.APPDATA || '', 'passshare-desktop');
  } else if (platform === 'darwin') {
    configDir = path.join(os.homedir(), 'Library', 'Application Support', 'passshare-desktop');
  } else {
    configDir = path.join(os.homedir(), '.config', 'passshare-desktop');
  }

  return path.join(configDir, 'passshare-projects.json');
}

// Load registered projects
function loadProjects(): string[] {
  try {
    const configPath = getConfigPath();
    if (fs.existsSync(configPath)) {
      const data = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as ProjectConfig;
      return data.registeredProjects.filter((p) => fs.existsSync(p));
    }
  } catch (err) {
    // Ignore errors
  }
  return [];
}

// Scan a project directory for credentials
function scanProject(projectPath: string): CredentialEntry[] {
  const credentials: CredentialEntry[] = [];
  const filePatterns = ['.env', '.json', '.yaml', '.yml'];
  const ignorePatterns = ['node_modules', '.git', 'dist', 'build', '__pycache__'];

  function walkDir(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (ignorePatterns.some((p) => entry.name === p || fullPath.includes(p))) {
        continue;
      }

      if (entry.isDirectory()) {
        walkDir(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        const isEnvFile = entry.name.startsWith('.env') || entry.name.endsWith('.env');

        if (!filePatterns.includes(ext) && !isEnvFile) {
          continue;
        }

        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const extracted = extractCredentials(content, fullPath, entry.name, projectPath);
          credentials.push(...extracted);
        } catch {
          // Ignore file read errors
        }
      }
    }
  }

  walkDir(projectPath);
  return credentials;
}

// Extract credentials from file content
function extractCredentials(
  content: string,
  filePath: string,
  fileName: string,
  projectPath: string
): CredentialEntry[] {
  const results: CredentialEntry[] = [];
  const relativePath = path.relative(projectPath, filePath);

  if (fileName.startsWith('.env') || fileName.endsWith('.env')) {
    const entry: CredentialEntry = {
      source: relativePath,
      extras: {},
    };

    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;

      const key = trimmed.slice(0, eqIndex).trim().replace(/^export\s+/, '');
      let value = trimmed.slice(eqIndex + 1).trim();

      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      const keyLower = key.toLowerCase();
      if (/email|mail/i.test(keyLower)) {
        entry.email = value;
      } else if (/password|passwd|pwd/i.test(keyLower)) {
        entry.password = value;
      } else if (/token|key|secret|credential/i.test(keyLower)) {
        entry.extras[key] = value;
      }
    }

    if (entry.email || entry.password || Object.keys(entry.extras).length > 0) {
      results.push(entry);
    }
  } else if (fileName.endsWith('.json')) {
    try {
      const data = JSON.parse(content);
      extractFromObject(data, relativePath, results);
    } catch {
      // Invalid JSON
    }
  } else if (fileName.endsWith('.yaml') || fileName.endsWith('.yml')) {
    const entry: CredentialEntry = {
      source: relativePath,
      extras: {},
    };

    const yamlPattern = /^(\s*)(\w+):\s*["']?([^"'\n]+)["']?\s*$/gm;
    let match;
    while ((match = yamlPattern.exec(content)) !== null) {
      const key = match[2];
      const value = match[3].trim();
      const keyLower = key.toLowerCase();

      if (/email|mail/i.test(keyLower)) {
        entry.email = value;
      } else if (/password|passwd|pwd/i.test(keyLower)) {
        entry.password = value;
      } else if (/token|key|secret|credential|user/i.test(keyLower)) {
        entry.extras[key] = value;
      }
    }

    if (entry.email || entry.password || Object.keys(entry.extras).length > 0) {
      results.push(entry);
    }
  }

  return results;
}

// Extract credentials from object
function extractFromObject(
  obj: unknown,
  source: string,
  results: CredentialEntry[]
): void {
  if (obj === null || obj === undefined) return;

  if (Array.isArray(obj)) {
    obj.forEach((item) => extractFromObject(item, source, results));
  } else if (typeof obj === 'object') {
    const entry: CredentialEntry = {
      source,
      extras: {},
    };

    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const keyLower = key.toLowerCase();

      if (typeof value === 'string') {
        if (/email|mail/i.test(keyLower)) {
          entry.email = value;
        } else if (/password|passwd|pwd/i.test(keyLower)) {
          entry.password = value;
        } else if (/token|key|secret|credential|user/i.test(keyLower)) {
          entry.extras[key] = value;
        }
      } else if (value !== null && typeof value === 'object') {
        extractFromObject(value, source, results);
      }
    }

    if (entry.email || entry.password || Object.keys(entry.extras).length > 0) {
      results.push(entry);
    }
  }
}

// Get all project vaults
function getAllVaults(): ProjectVault[] {
  const projects = loadProjects();
  const vaults: ProjectVault[] = [];

  for (const projectPath of projects) {
    if (!fs.existsSync(projectPath)) continue;

    const projectName = path.basename(projectPath);
    const credentials = scanProject(projectPath);

    const credentialsWithPasswords = credentials.filter(
      (cred) =>
        cred.password || Object.keys(cred.extras).some((k) => /token|key|secret/i.test(k))
    );

    if (credentialsWithPasswords.length > 0) {
      vaults.push({
        name: projectName,
        path: projectPath,
        credentials: credentialsWithPasswords,
      });
    }
  }

  return vaults;
}

// Find vaults matching a URL hostname
function findVaultsForUrl(hostname: string): string[] {
  const vaults = getAllVaults();
  const matches: string[] = [];

  // Simple matching: check if vault name contains hostname or vice versa
  const hostnameWithoutTld = hostname.replace(/\.[^.]+$/, '');

  for (const vault of vaults) {
    const vaultNameLower = vault.name.toLowerCase();
    const hostnameLower = hostname.toLowerCase();
    const hostnameWithoutTldLower = hostnameWithoutTld.toLowerCase();

    if (
      vaultNameLower.includes(hostnameLower) ||
      hostnameLower.includes(vaultNameLower) ||
      vaultNameLower.includes(hostnameWithoutTldLower) ||
      hostnameWithoutTldLower.includes(vaultNameLower)
    ) {
      matches.push(vault.name);
    }
  }

  return matches;
}

// Message handlers
async function handleMessage(message: NativeMessage): Promise<NativeResponse> {
  const { id, type, payload } = message;

  try {
    switch (type) {
      case 'list': {
        const vaults = getAllVaults();
        const names = vaults.map((v) => v.name).sort();
        return { id, success: true, data: names };
      }

      case 'get': {
        const vaults = getAllVaults();
        const vault = vaults.find((v) => v.name === payload);
        if (vault) {
          return {
            id,
            success: true,
            data: {
              password: vault.credentials[0]?.password || '',
              data: {
                username: vault.credentials[0]?.email || '',
                email: vault.credentials[0]?.email || '',
                ...vault.credentials[0]?.extras,
              },
            },
          };
        }
        return { id, success: false, error: `Vault not found: ${payload}` };
      }

      case 'find': {
        const matches = findVaultsForUrl(payload as string);
        return { id, success: true, data: matches };
      }

      case 'otp': {
        // OTP not supported in seed scanning mode
        return { id, success: false, error: 'OTP not supported' };
      }

      case 'sync': {
        // Re-scan all projects
        const vaults = getAllVaults();
        return { id, success: true, data: vaults.length };
      }

      case 'generate': {
        // Generate a random password
        const length = (payload as { length?: number })?.length || 24;
        const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
        let password = '';
        const randomBytes = require('crypto').randomBytes(length);
        for (let i = 0; i < length; i++) {
          password += chars[randomBytes[i] % chars.length];
        }
        return { id, success: true, data: password };
      }

      default:
        return { id, success: false, error: `Unknown message type: ${type}` };
    }
  } catch (err) {
    return { id, success: false, error: String(err) };
  }
}

// Native Messaging Protocol implementation
function readMessage(): Promise<NativeMessage | null> {
  return new Promise((resolve) => {
    // Read 4-byte length prefix
    const lengthBuffer = Buffer.alloc(4);
    let bytesRead = 0;

    const readLength = (): void => {
      const chunk = process.stdin.read(4 - bytesRead);
      if (chunk === null) {
        process.stdin.once('readable', readLength);
        return;
      }

      chunk.copy(lengthBuffer, bytesRead);
      bytesRead += chunk.length;

      if (bytesRead < 4) {
        process.stdin.once('readable', readLength);
        return;
      }

      const messageLength = lengthBuffer.readUInt32LE(0);
      if (messageLength === 0) {
        resolve(null);
        return;
      }

      // Read message
      let messageData = '';
      let messageBytesRead = 0;

      const readMessageData = (): void => {
        const msgChunk = process.stdin.read(messageLength - messageBytesRead);
        if (msgChunk === null) {
          process.stdin.once('readable', readMessageData);
          return;
        }

        messageData += msgChunk.toString('utf-8');
        messageBytesRead += msgChunk.length;

        if (messageBytesRead < messageLength) {
          process.stdin.once('readable', readMessageData);
          return;
        }

        try {
          const message = JSON.parse(messageData) as NativeMessage;
          resolve(message);
        } catch {
          resolve(null);
        }
      };

      readMessageData();
    };

    readLength();
  });
}

function writeMessage(response: NativeResponse): void {
  const messageStr = JSON.stringify(response);
  const messageBuffer = Buffer.from(messageStr, 'utf-8');
  const lengthBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32LE(messageBuffer.length, 0);

  process.stdout.write(lengthBuffer);
  process.stdout.write(messageBuffer);
}

// Main loop
async function main(): Promise<void> {
  // Set stdin to raw mode for binary reading
  if (process.stdin.setRawMode) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();

  while (true) {
    const message = await readMessage();
    if (message === null) {
      break;
    }

    const response = await handleMessage(message);
    writeMessage(response);
  }
}

// Handle process termination
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

// Start
main().catch((err) => {
  console.error('Native host error:', err);
  process.exit(1);
});
