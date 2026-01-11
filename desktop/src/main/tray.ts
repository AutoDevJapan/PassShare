/**
 * System Tray for PassShare Desktop
 */

import { Tray, Menu, app, nativeImage } from 'electron';
import * as path from 'path';

let tray: Tray | null = null;

export function createTray(showWindow: () => void): void {
  // Create tray icon
  const iconPath = path.join(__dirname, '../../assets/tray-icon.png');
  const icon = nativeImage.createFromPath(iconPath);

  // On macOS, use template icon
  if (process.platform === 'darwin') {
    icon.setTemplateImage(true);
  }

  tray = new Tray(icon.isEmpty() ? createDefaultIcon() : icon);

  // Create context menu
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open PassShare',
      click: showWindow,
    },
    {
      type: 'separator',
    },
    {
      label: 'Quick Search',
      accelerator: process.platform === 'darwin' ? 'Cmd+Shift+P' : 'Ctrl+Shift+P',
      click: showWindow,
    },
    {
      type: 'separator',
    },
    {
      label: 'Sync Now',
      click: async () => {
        // Trigger sync via IPC
        const { BrowserWindow } = await import('electron');
        const windows = BrowserWindow.getAllWindows();
        if (windows.length > 0) {
          windows[0].webContents.send('passshare:sync-requested');
        }
      },
    },
    {
      type: 'separator',
    },
    {
      label: 'About PassShare',
      click: () => {
        const { dialog } = require('electron');
        dialog.showMessageBox({
          type: 'info',
          title: 'About PassShare',
          message: 'PassShare Desktop',
          detail: `Version: ${app.getVersion()}\n© 2026 株式会社BM1314. All rights reserved.`,
        });
      },
    },
    {
      type: 'separator',
    },
    {
      label: 'Quit',
      accelerator: process.platform === 'darwin' ? 'Cmd+Q' : 'Alt+F4',
      click: () => {
        app.quit();
      },
    },
  ]);

  tray.setToolTip('PassShare');
  tray.setContextMenu(contextMenu);

  // Double-click to show window
  tray.on('double-click', showWindow);
}

function createDefaultIcon(): Electron.NativeImage {
  // Create a simple default icon if asset is missing
  const { nativeImage } = require('electron');

  // 16x16 simple key icon (base64 encoded PNG would go here)
  // For now, return empty which will use system default
  return nativeImage.createEmpty();
}

export function destroyTray(): void {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}
