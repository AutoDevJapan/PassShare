/**
 * PassShare Electron Preload Script
 * © 2026 株式会社BM1314. All rights reserved.
 */

import { contextBridge, ipcRenderer } from 'electron';

// Expose protected methods to renderer
contextBridge.exposeInMainWorld('electronAPI', {
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('get-app-version'),
  getPlatform: (): Promise<NodeJS.Platform> => ipcRenderer.invoke('get-platform'),
  isElectron: true,
});

// Type declarations for renderer
declare global {
  interface Window {
    electronAPI?: {
      getAppVersion: () => Promise<string>;
      getPlatform: () => Promise<NodeJS.Platform>;
      isElectron: boolean;
    };
  }
}
