/**
 * PassShare Desktop - Electron Main Process
 *
 * © 2026 株式会社BM1314. All rights reserved.
 */

import { app, BrowserWindow, ipcMain, globalShortcut, clipboard, nativeTheme, dialog, shell } from 'electron';
import * as path from 'path';
import { setupIpcHandlers } from './ipc-handlers';
import { createTray } from './tray';
import { setupAutoUpdater } from './auto-updater';
import {
  installNativeHost,
  needsFirstTimeSetup,
  getInstallationStatus,
  uninstallNativeHost,
} from './native-host-setup';

// Keep a global reference of the window object
let mainWindow: BrowserWindow | null = null;

const isDev = process.env.NODE_ENV === 'development';

// Browser extension install URLs
const EXTENSION_URLS = {
  chrome: 'https://chrome.google.com/webstore/detail/passshare/placeholder-id',
  edge: 'https://microsoftedge.microsoft.com/addons/detail/passshare/placeholder-id',
  firefox: 'https://addons.mozilla.org/firefox/addon/passshare/',
};

function createWindow(): void {
  // Create the browser window
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'PassShare',
    icon: path.join(__dirname, '../../assets/icon.png'),
    backgroundColor: '#0a0a0b',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  // Load the app
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  // Handle window close
  mainWindow.on('close', (event) => {
    if (process.platform === 'darwin') {
      // On macOS, hide instead of quit
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Setup global shortcuts
function setupGlobalShortcuts(): void {
  // Quick access shortcut (Ctrl+Shift+P / Cmd+Shift+P)
  const shortcut = process.platform === 'darwin' ? 'Cmd+Shift+P' : 'Ctrl+Shift+P';

  globalShortcut.register(shortcut, () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    } else {
      createWindow();
    }
  });
}

/**
 * Perform first-time setup for browser extension integration
 */
async function performFirstTimeSetup(): Promise<void> {
  console.log('[FirstTimeSetup] Starting native host setup...');

  const result = await installNativeHost();

  if (result.success) {
    console.log('[FirstTimeSetup] Native host installed successfully');
    console.log('[FirstTimeSetup] Installed for:', result.installed.join(', '));

    // Show success dialog with extension install instructions
    const response = await dialog.showMessageBox(mainWindow!, {
      type: 'info',
      title: 'PassShare セットアップ完了',
      message: 'ブラウザ連携の準備が完了しました',
      detail: `以下のブラウザでオートフィル機能が利用可能です：\n${result.installed.join(', ')}\n\nブラウザ拡張機能をインストールして、オートフィル機能を有効にしてください。`,
      buttons: ['Chrome 拡張機能をインストール', 'Firefox アドオンをインストール', '後で'],
      defaultId: 2,
      cancelId: 2,
    });

    if (response.response === 0) {
      // Open Chrome Web Store
      shell.openExternal(EXTENSION_URLS.chrome);
    } else if (response.response === 1) {
      // Open Firefox Add-ons
      shell.openExternal(EXTENSION_URLS.firefox);
    }
  } else {
    console.error('[FirstTimeSetup] Native host installation failed');
    console.error('[FirstTimeSetup] Failed for:', result.failed.join(', '));

    // Show error dialog
    if (result.installed.length > 0) {
      dialog.showMessageBox(mainWindow!, {
        type: 'warning',
        title: 'PassShare セットアップ',
        message: '一部のブラウザでセットアップが失敗しました',
        detail: `成功: ${result.installed.join(', ')}\n失敗: ${result.failed.join(', ')}\n\nセットアップに失敗したブラウザではオートフィル機能が利用できません。`,
        buttons: ['OK'],
      });
    } else {
      dialog.showMessageBox(mainWindow!, {
        type: 'error',
        title: 'PassShare セットアップ',
        message: 'ブラウザ連携のセットアップに失敗しました',
        detail: 'オートフィル機能を利用するには、アプリを再起動するか、設定画面から手動でセットアップを行ってください。',
        buttons: ['OK'],
      });
    }
  }
}

// App lifecycle
app.whenReady().then(async () => {
  // Set app name
  app.setName('PassShare');

  // Use dark mode
  nativeTheme.themeSource = 'dark';

  // Create window
  createWindow();

  // Setup IPC handlers
  setupIpcHandlers();

  // Setup native host IPC handlers
  setupNativeHostIpcHandlers();

  // Setup tray
  createTray(() => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });

  // Setup global shortcuts
  setupGlobalShortcuts();

  // Setup auto-updater (only in production)
  if (!isDev) {
    setupAutoUpdater();
  }

  // Check if first-time setup is needed
  if (needsFirstTimeSetup()) {
    // Delay setup to allow window to fully load
    setTimeout(() => {
      performFirstTimeSetup();
    }, 1500);
  }

  // macOS: recreate window when dock icon is clicked
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      mainWindow?.show();
    }
  });
});

// Quit when all windows are closed (except on macOS)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Cleanup on quit
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

// Handle clipboard auto-clear
let clipboardClearTimeout: NodeJS.Timeout | null = null;

ipcMain.on('clipboard:copy', (_, text: string, timeout: number = 45000) => {
  clipboard.writeText(text);

  // Clear previous timeout
  if (clipboardClearTimeout) {
    clearTimeout(clipboardClearTimeout);
  }

  // Set new timeout to clear clipboard
  clipboardClearTimeout = setTimeout(() => {
    if (clipboard.readText() === text) {
      clipboard.clear();
    }
  }, timeout);
});

// Auto-lock functionality
let isLocked = false;
let autoLockTimeout: NodeJS.Timeout | null = null;
const AUTO_LOCK_DELAY_MS = 5 * 60 * 1000; // 5 minutes

function resetAutoLockTimer(): void {
  if (autoLockTimeout) {
    clearTimeout(autoLockTimeout);
  }

  autoLockTimeout = setTimeout(() => {
    lockApp();
  }, AUTO_LOCK_DELAY_MS);
}

function lockApp(): void {
  isLocked = true;
  if (mainWindow) {
    mainWindow.webContents.send('app:locked');
  }
}

function unlockApp(): void {
  isLocked = false;
  resetAutoLockTimer();
  if (mainWindow) {
    mainWindow.webContents.send('app:unlocked');
  }
}

// Handle lock/unlock events
ipcMain.on('app:unlock', (_, _masterPassword: string) => {
  // In a real implementation, verify the master password
  unlockApp();
});

ipcMain.on('app:lock', () => {
  lockApp();
});

ipcMain.handle('app:isLocked', () => {
  return isLocked;
});

ipcMain.handle('app:getAutoLockDelay', () => {
  return AUTO_LOCK_DELAY_MS / 1000; // Return in seconds
});

ipcMain.on('app:setAutoLockDelay', (_, _delaySeconds: number) => {
  // Update delay and reset timer
  // In a real implementation, this would be persisted to config
  resetAutoLockTimer();
});

// Reset auto-lock on user activity
ipcMain.on('app:userActivity', () => {
  if (!isLocked) {
    resetAutoLockTimer();
  }
});

/**
 * Setup IPC handlers for native host management
 */
function setupNativeHostIpcHandlers(): void {
  // Get native host installation status
  ipcMain.handle('nativeHost:status', () => {
    return getInstallationStatus();
  });

  // Install native host
  ipcMain.handle('nativeHost:install', async () => {
    return await installNativeHost();
  });

  // Uninstall native host
  ipcMain.handle('nativeHost:uninstall', async () => {
    await uninstallNativeHost();
    return { success: true };
  });

  // Open browser extension store
  ipcMain.on('nativeHost:openExtensionStore', (_, browser: 'chrome' | 'edge' | 'firefox') => {
    const url = EXTENSION_URLS[browser];
    if (url) {
      shell.openExternal(url);
    }
  });
}

// Export for tray access
export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

export function lockApplication(): void {
  lockApp();
}
