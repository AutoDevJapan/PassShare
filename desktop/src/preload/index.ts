/**
 * Preload script for PassShare Desktop
 *
 * Exposes a safe API to the renderer process via contextBridge
 */

import { contextBridge, ipcRenderer } from 'electron';

// Expose PassShare API to renderer
contextBridge.exposeInMainWorld('passshare', {
  // Store operations
  init: (recipients: string[], options?: { path?: string; crypto?: string; storage?: string }) =>
    ipcRenderer.invoke('passshare:init', recipients, options),

  list: (prefix?: string) => ipcRenderer.invoke('passshare:list', prefix),

  get: (name: string) => ipcRenderer.invoke('passshare:get', name),

  set: (name: string, data: { password: string; data?: Record<string, string>; notes?: string }) =>
    ipcRenderer.invoke('passshare:set', name, data),

  delete: (name: string) => ipcRenderer.invoke('passshare:delete', name),

  // Password generation
  generate: (
    name: string,
    options?: { length?: number; symbols?: boolean; xkcd?: boolean; force?: boolean }
  ) => ipcRenderer.invoke('passshare:generate', name, options),

  pwgen: (options?: { length?: number; symbols?: boolean; xkcd?: boolean; count?: number }) =>
    ipcRenderer.invoke('passshare:pwgen', options),

  // Search
  find: (pattern: string) => ipcRenderer.invoke('passshare:find', pattern),

  // Sync
  sync: (store?: string) => ipcRenderer.invoke('passshare:sync', store),

  // OTP
  otp: (name: string) => ipcRenderer.invoke('passshare:otp', name),

  // Config
  config: {
    get: () => ipcRenderer.invoke('passshare:config:get'),
    set: (key: string, value: unknown) => ipcRenderer.invoke('passshare:config:set', key, value),
  },

  // Mounts
  mounts: {
    list: () => ipcRenderer.invoke('passshare:mounts:list'),
    add: (alias: string, path: string) => ipcRenderer.invoke('passshare:mounts:add', alias, path),
    remove: (alias: string) => ipcRenderer.invoke('passshare:mounts:remove', alias),
  },

  // Recipients
  recipients: {
    list: (store?: string) => ipcRenderer.invoke('passshare:recipients:list', store),
    add: (keyId: string, store?: string) =>
      ipcRenderer.invoke('passshare:recipients:add', keyId, store),
    remove: (keyId: string, store?: string) =>
      ipcRenderer.invoke('passshare:recipients:remove', keyId, store),
  },

  // Audit
  audit: (folder?: string) => ipcRenderer.invoke('passshare:audit', folder),

  // History
  history: (name: string, count?: number) => ipcRenderer.invoke('passshare:history', name, count),

  // Status
  initialized: () => ipcRenderer.invoke('passshare:initialized'),

  // Seed scanning
  scan: () => ipcRenderer.invoke('passshare:scan'),

  // Project management
  registerProject: (projectPath: string) => ipcRenderer.invoke('passshare:registerProject', projectPath),
  listProjects: () => ipcRenderer.invoke('passshare:listProjects'),
  removeProject: (projectPath: string) => ipcRenderer.invoke('passshare:removeProject', projectPath),
});

// Expose clipboard API
contextBridge.exposeInMainWorld('clipboard', {
  copy: (text: string, timeout?: number) => ipcRenderer.send('clipboard:copy', text, timeout),
});

// Expose app info
contextBridge.exposeInMainWorld('app', {
  version: process.env.npm_package_version || '1.0.0',
  platform: process.platform,
});

// Listen for sync requests from tray
ipcRenderer.on('passshare:sync-requested', () => {
  window.dispatchEvent(new CustomEvent('passshare:sync-requested'));
});

// TypeScript type declarations for window
declare global {
  interface Window {
    passshare: {
      init: (
        recipients: string[],
        options?: { path?: string; crypto?: string; storage?: string }
      ) => Promise<{ success: boolean; error?: string }>;
      list: (prefix?: string) => Promise<{ success: boolean; data?: string[]; error?: string }>;
      get: (name: string) => Promise<{
        success: boolean;
        data?: {
          name: string;
          password: string;
          data: Record<string, string>;
          notes?: string;
          hasOtp: boolean;
        };
        error?: string;
      }>;
      set: (
        name: string,
        data: { password: string; data?: Record<string, string>; notes?: string }
      ) => Promise<{ success: boolean; error?: string }>;
      delete: (name: string) => Promise<{ success: boolean; error?: string }>;
      generate: (
        name: string,
        options?: { length?: number; symbols?: boolean; xkcd?: boolean; force?: boolean }
      ) => Promise<{ success: boolean; data?: string; error?: string }>;
      pwgen: (options?: {
        length?: number;
        symbols?: boolean;
        xkcd?: boolean;
        count?: number;
      }) => Promise<{ success: boolean; data?: string[]; error?: string }>;
      find: (pattern: string) => Promise<{ success: boolean; data?: string[]; error?: string }>;
      sync: (store?: string) => Promise<{ success: boolean; error?: string }>;
      otp: (name: string) => Promise<{ success: boolean; data?: string; error?: string }>;
      config: {
        get: () => Promise<{
          success: boolean;
          data?: {
            path: string;
            autoclip: boolean;
            cliptimeout: number;
            autosync: boolean;
            autopush: boolean;
            mounts: Record<string, string>;
          };
          error?: string;
        }>;
        set: (key: string, value: unknown) => Promise<{ success: boolean; error?: string }>;
      };
      mounts: {
        list: () => Promise<{ success: boolean; data?: Record<string, string>; error?: string }>;
        add: (alias: string, path: string) => Promise<{ success: boolean; error?: string }>;
        remove: (alias: string) => Promise<{ success: boolean; error?: string }>;
      };
      recipients: {
        list: (store?: string) => Promise<{ success: boolean; data?: string[]; error?: string }>;
        add: (keyId: string, store?: string) => Promise<{ success: boolean; error?: string }>;
        remove: (keyId: string, store?: string) => Promise<{ success: boolean; error?: string }>;
      };
      audit: (folder?: string) => Promise<{
        success: boolean;
        data?: {
          totalSecrets: number;
          weakPasswords: Array<{
            name: string;
            strength: string;
            entropy: number;
            issues: string[];
          }>;
          duplicates: string[][];
        };
        error?: string;
      }>;
      history: (
        name: string,
        count?: number
      ) => Promise<{
        success: boolean;
        data?: Array<{ revision: string; date: string; message: string; author?: string }>;
        error?: string;
      }>;
      initialized: () => Promise<{ success: boolean; data?: boolean; error?: string }>;
      scan: () => Promise<{
        success: boolean;
        cancelled?: boolean;
        data?: {
          projectName: string;
          rootDir: string;
          credentials: Array<{
            file: string;
            name: string;
            email?: string;
            password?: string;
            extras: Record<string, string>;
          }>;
          scannedFiles: string[];
          skippedFiles: string[];
          errors: Array<{ file: string; error: string }>;
        };
        error?: string;
      }>;
    };
    clipboard: {
      copy: (text: string, timeout?: number) => void;
    };
    app: {
      version: string;
      platform: string;
    };
  }
}
