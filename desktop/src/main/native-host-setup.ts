/**
 * Native Messaging Host Setup
 *
 * Configures browser native messaging hosts for PassShare.
 * Supports Chrome, Edge, and Firefox on Windows, macOS, and Linux.
 *
 * © 2026 株式会社BM1314. All rights reserved.
 */

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const NATIVE_HOST_NAME = 'net.bm1314.passshare';

// Chrome extension ID (will be updated when published to Chrome Web Store)
// For development, use the unpacked extension ID
const CHROME_EXTENSION_ID = '*'; // Allow all for development

// Firefox extension ID
const FIREFOX_EXTENSION_ID = 'passshare@bm1314.net';

interface BrowserConfig {
  name: string;
  manifestDir: string;
  registryKey?: string; // Windows only
}

/**
 * Get browser configurations for the current platform
 */
function getBrowserConfigs(): BrowserConfig[] {
  const platform = process.platform;
  const homeDir = os.homedir();
  const configs: BrowserConfig[] = [];

  if (platform === 'win32') {
    configs.push(
      {
        name: 'Chrome',
        manifestDir: path.join(homeDir, 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'NativeMessagingHosts'),
        registryKey: 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts',
      },
      {
        name: 'Edge',
        manifestDir: path.join(homeDir, 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data', 'NativeMessagingHosts'),
        registryKey: 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts',
      },
      {
        name: 'Firefox',
        manifestDir: path.join(homeDir, 'AppData', 'Roaming', 'Mozilla', 'NativeMessagingHosts'),
        registryKey: 'HKCU\\Software\\Mozilla\\NativeMessagingHosts',
      }
    );
  } else if (platform === 'darwin') {
    const libraryPath = path.join(homeDir, 'Library', 'Application Support');
    configs.push(
      {
        name: 'Chrome',
        manifestDir: path.join(libraryPath, 'Google', 'Chrome', 'NativeMessagingHosts'),
      },
      {
        name: 'Edge',
        manifestDir: path.join(libraryPath, 'Microsoft Edge', 'NativeMessagingHosts'),
      },
      {
        name: 'Firefox',
        manifestDir: path.join(libraryPath, 'Mozilla', 'NativeMessagingHosts'),
      }
    );
  } else {
    // Linux
    const configDir = path.join(homeDir, '.config');
    configs.push(
      {
        name: 'Chrome',
        manifestDir: path.join(configDir, 'google-chrome', 'NativeMessagingHosts'),
      },
      {
        name: 'Chromium',
        manifestDir: path.join(configDir, 'chromium', 'NativeMessagingHosts'),
      },
      {
        name: 'Edge',
        manifestDir: path.join(configDir, 'microsoft-edge', 'NativeMessagingHosts'),
      },
      {
        name: 'Firefox',
        manifestDir: path.join(homeDir, '.mozilla', 'native-messaging-hosts'),
      }
    );
  }

  return configs;
}

/**
 * Get the path to the native host executable
 */
function getNativeHostPath(): string {
  const platform = process.platform;
  const appPath = app.getAppPath();
  const resourcesPath = path.dirname(appPath);

  if (app.isPackaged) {
    // In production, native host is bundled
    if (platform === 'win32') {
      return path.join(resourcesPath, 'native-host', 'passshare-native-host.exe');
    } else {
      return path.join(resourcesPath, 'native-host', 'passshare-native-host');
    }
  } else {
    // In development, use Node.js to run the script
    if (platform === 'win32') {
      // Create a batch file wrapper for Windows
      const batchPath = path.join(appPath, 'dist', 'native-host', 'passshare-native-host.bat');
      return batchPath;
    } else {
      // Create a shell script wrapper for Unix
      const scriptPath = path.join(appPath, 'dist', 'native-host', 'passshare-native-host.sh');
      return scriptPath;
    }
  }
}

/**
 * Create the native host wrapper script for development
 */
function createDevWrapper(): void {
  const platform = process.platform;
  const appPath = app.getAppPath();
  const distDir = path.join(appPath, 'dist', 'native-host');

  // Ensure directory exists
  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
  }

  const jsPath = path.join(distDir, 'index.js');

  if (platform === 'win32') {
    const batchPath = path.join(distDir, 'passshare-native-host.bat');
    const batchContent = `@echo off\r\nnode "${jsPath}" %*\r\n`;
    fs.writeFileSync(batchPath, batchContent);
    console.log(`[NativeHostSetup] Created dev wrapper: ${batchPath}`);
  } else {
    const scriptPath = path.join(distDir, 'passshare-native-host.sh');
    const scriptContent = `#!/bin/bash\nexec node "${jsPath}" "$@"\n`;
    fs.writeFileSync(scriptPath, scriptContent);
    fs.chmodSync(scriptPath, '755');
    console.log(`[NativeHostSetup] Created dev wrapper: ${scriptPath}`);
  }
}

/**
 * Generate manifest content for a browser
 */
function generateManifest(browser: string, nativeHostPath: string): string {
  const isFirefox = browser.toLowerCase() === 'firefox';

  const manifest: Record<string, unknown> = {
    name: NATIVE_HOST_NAME,
    description: 'PassShare Native Messaging Host - Secure password manager',
    path: nativeHostPath,
    type: 'stdio',
  };

  if (isFirefox) {
    manifest.allowed_extensions = [FIREFOX_EXTENSION_ID];
  } else {
    // Chrome, Edge, Chromium
    if (CHROME_EXTENSION_ID === '*') {
      // Development mode: allow all extensions
      manifest.allowed_origins = ['chrome-extension://*/'];
    } else {
      manifest.allowed_origins = [`chrome-extension://${CHROME_EXTENSION_ID}/`];
    }
  }

  return JSON.stringify(manifest, null, 2);
}

/**
 * Install native messaging host for a specific browser
 */
async function installForBrowser(config: BrowserConfig, nativeHostPath: string): Promise<boolean> {
  try {
    // Create manifest directory if it doesn't exist
    if (!fs.existsSync(config.manifestDir)) {
      fs.mkdirSync(config.manifestDir, { recursive: true });
    }

    // Generate and write manifest
    const manifestPath = path.join(config.manifestDir, `${NATIVE_HOST_NAME}.json`);
    const manifestContent = generateManifest(config.name, nativeHostPath);
    fs.writeFileSync(manifestPath, manifestContent);
    console.log(`[NativeHostSetup] Installed manifest for ${config.name}: ${manifestPath}`);

    // Windows: also add registry entry
    if (process.platform === 'win32' && config.registryKey) {
      try {
        const regCommand = `reg add "${config.registryKey}\\${NATIVE_HOST_NAME}" /ve /t REG_SZ /d "${manifestPath}" /f`;
        await execAsync(regCommand);
        console.log(`[NativeHostSetup] Added registry entry for ${config.name}`);
      } catch (regErr) {
        console.warn(`[NativeHostSetup] Failed to add registry entry for ${config.name}:`, regErr);
        // Continue anyway - manifest file might be sufficient
      }
    }

    return true;
  } catch (err) {
    console.error(`[NativeHostSetup] Failed to install for ${config.name}:`, err);
    return false;
  }
}

/**
 * Uninstall native messaging host for a specific browser
 */
async function uninstallForBrowser(config: BrowserConfig): Promise<boolean> {
  try {
    const manifestPath = path.join(config.manifestDir, `${NATIVE_HOST_NAME}.json`);

    // Remove manifest file
    if (fs.existsSync(manifestPath)) {
      fs.unlinkSync(manifestPath);
      console.log(`[NativeHostSetup] Removed manifest for ${config.name}`);
    }

    // Windows: remove registry entry
    if (process.platform === 'win32' && config.registryKey) {
      try {
        const regCommand = `reg delete "${config.registryKey}\\${NATIVE_HOST_NAME}" /f`;
        await execAsync(regCommand);
        console.log(`[NativeHostSetup] Removed registry entry for ${config.name}`);
      } catch {
        // Ignore if key doesn't exist
      }
    }

    return true;
  } catch (err) {
    console.error(`[NativeHostSetup] Failed to uninstall for ${config.name}:`, err);
    return false;
  }
}

/**
 * Install native messaging host for all supported browsers
 */
export async function installNativeHost(): Promise<{ success: boolean; installed: string[]; failed: string[] }> {
  const configs = getBrowserConfigs();
  const installed: string[] = [];
  const failed: string[] = [];

  // Create dev wrapper if in development mode
  if (!app.isPackaged) {
    createDevWrapper();
  }

  const nativeHostPath = getNativeHostPath();
  console.log(`[NativeHostSetup] Native host path: ${nativeHostPath}`);

  // Check if native host exists
  if (!fs.existsSync(nativeHostPath)) {
    console.error(`[NativeHostSetup] Native host not found: ${nativeHostPath}`);
    return { success: false, installed: [], failed: configs.map((c) => c.name) };
  }

  for (const config of configs) {
    const result = await installForBrowser(config, nativeHostPath);
    if (result) {
      installed.push(config.name);
    } else {
      failed.push(config.name);
    }
  }

  return { success: failed.length === 0, installed, failed };
}

/**
 * Uninstall native messaging host from all browsers
 */
export async function uninstallNativeHost(): Promise<void> {
  const configs = getBrowserConfigs();

  for (const config of configs) {
    await uninstallForBrowser(config);
  }

  console.log('[NativeHostSetup] Uninstalled from all browsers');
}

/**
 * Check if native messaging host is installed for a browser
 */
export function isInstalledForBrowser(browserName: string): boolean {
  const configs = getBrowserConfigs();
  const config = configs.find((c) => c.name.toLowerCase() === browserName.toLowerCase());

  if (!config) {
    return false;
  }

  const manifestPath = path.join(config.manifestDir, `${NATIVE_HOST_NAME}.json`);
  return fs.existsSync(manifestPath);
}

/**
 * Get installation status for all browsers
 */
export function getInstallationStatus(): Record<string, boolean> {
  const configs = getBrowserConfigs();
  const status: Record<string, boolean> = {};

  for (const config of configs) {
    const manifestPath = path.join(config.manifestDir, `${NATIVE_HOST_NAME}.json`);
    status[config.name] = fs.existsSync(manifestPath);
  }

  return status;
}

/**
 * Check if first-time setup is needed
 */
export function needsFirstTimeSetup(): boolean {
  const status = getInstallationStatus();
  // If no browser has native host installed, setup is needed
  return !Object.values(status).some((installed) => installed);
}
