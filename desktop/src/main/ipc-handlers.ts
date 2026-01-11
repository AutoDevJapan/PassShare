/**
 * IPC Handlers for PassShare operations
 *
 * Bridges the renderer process with the passshare-node SDK
 */

import { ipcMain } from 'electron';
import { Gopass, Secret } from '@bm1314/passshare-core';

let gopass: Gopass | null = null;

function getGopass(): Gopass {
  if (!gopass) {
    gopass = new Gopass();
  }
  return gopass;
}

export function setupIpcHandlers(): void {
  // Initialize store
  ipcMain.handle('passshare:init', async (_, recipients: string[], options?: {
    path?: string;
    crypto?: string;
    storage?: string;
  }) => {
    try {
      const g = getGopass();
      await g.init(recipients, options);
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // List secrets
  ipcMain.handle('passshare:list', async (_, prefix?: string) => {
    try {
      const g = getGopass();
      const secrets = await g.list(prefix || '');
      return { success: true, data: secrets };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Get secret
  ipcMain.handle('passshare:get', async (_, name: string) => {
    try {
      const g = getGopass();
      const secret = await g.get(name);
      return {
        success: true,
        data: {
          name,
          password: secret.password,
          data: Object.fromEntries(secret.data || new Map()),
          notes: secret.notes,
          hasOtp: !!secret.get('otp'),
        },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Create/Update secret
  ipcMain.handle('passshare:set', async (_, name: string, secretData: {
    password: string;
    data?: Record<string, string>;
    notes?: string;
  }) => {
    try {
      const g = getGopass();
      const secret = new Secret({
        password: secretData.password,
        data: new Map(Object.entries(secretData.data || {})),
        notes: secretData.notes,
      });
      await g.set(name, secret);
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Delete secret
  ipcMain.handle('passshare:delete', async (_, name: string) => {
    try {
      const g = getGopass();
      await g.delete(name);
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Generate password
  ipcMain.handle('passshare:generate', async (_, name: string, options?: {
    length?: number;
    symbols?: boolean;
    xkcd?: boolean;
    force?: boolean;
  }) => {
    try {
      const g = getGopass();
      const password = await g.generate(name, options);
      return { success: true, data: password };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Generate standalone password (without saving)
  ipcMain.handle('passshare:pwgen', async (_, options?: {
    length?: number;
    symbols?: boolean;
    xkcd?: boolean;
    count?: number;
  }) => {
    try {
      const { generatePassword } = await import('@bm1314/passshare-core');
      const count = options?.count || 1;
      const passwords: string[] = [];
      for (let i = 0; i < count; i++) {
        passwords.push(generatePassword({
          length: options?.length,
          symbols: options?.symbols,
          xkcd: options?.xkcd,
        }));
      }
      return { success: true, data: passwords };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Search secrets
  ipcMain.handle('passshare:find', async (_, pattern: string) => {
    try {
      const g = getGopass();
      const matches = await g.find(pattern);
      return { success: true, data: matches };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Sync with remote
  ipcMain.handle('passshare:sync', async (_, store?: string) => {
    try {
      const g = getGopass();
      await g.sync(store);
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Get OTP
  ipcMain.handle('passshare:otp', async (_, name: string) => {
    try {
      const g = getGopass();
      const secret = await g.get(name);
      const otp = secret.otp();
      return { success: true, data: otp };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Get config
  ipcMain.handle('passshare:config:get', async () => {
    try {
      const g = getGopass();
      const config = g.config;
      return {
        success: true,
        data: {
          path: config.storePath,
          autoclip: config.get('autoclip'),
          cliptimeout: config.get('cliptimeout'),
          autosync: config.get('autosync'),
          autopush: config.get('autopush'),
          mounts: g.mounts,
        },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Update config
  ipcMain.handle('passshare:config:set', async (_, key: string, value: unknown) => {
    try {
      const g = getGopass();
      g.config.set(key, value);
      g.config.save();
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Get mounts
  ipcMain.handle('passshare:mounts:list', async () => {
    try {
      const g = getGopass();
      return { success: true, data: g.mounts };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Add mount
  ipcMain.handle('passshare:mounts:add', async (_, alias: string, path: string) => {
    try {
      const g = getGopass();
      await g.mount(alias, path);
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Remove mount
  ipcMain.handle('passshare:mounts:remove', async (_, alias: string) => {
    try {
      const g = getGopass();
      await g.unmount(alias);
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Get recipients
  ipcMain.handle('passshare:recipients:list', async (_, store?: string) => {
    try {
      const g = getGopass();
      const recipients = await g.recipients(store);
      return { success: true, data: recipients };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Add recipient
  ipcMain.handle('passshare:recipients:add', async (_, keyId: string, store?: string) => {
    try {
      const g = getGopass();
      await g.addRecipient(keyId, store);
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Remove recipient
  ipcMain.handle('passshare:recipients:remove', async (_, keyId: string, store?: string) => {
    try {
      const g = getGopass();
      await g.removeRecipient(keyId, store);
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Audit passwords
  ipcMain.handle('passshare:audit', async (_, folder?: string) => {
    try {
      const g = getGopass();
      const { checkPasswordStrength } = await import('@bm1314/passshare-core');

      const secrets = await g.list(folder || '');
      const weakPasswords: Array<{
        name: string;
        strength: string;
        entropy: number;
        issues: string[];
      }> = [];
      const passwordMap = new Map<string, string[]>();

      for (const name of secrets) {
        try {
          const secret = await g.get(name);
          const password = secret.password;

          const strength = checkPasswordStrength(password);
          if (strength.strength === 'weak' || strength.strength === 'fair') {
            weakPasswords.push({
              name,
              strength: strength.strength,
              entropy: strength.entropy,
              issues: strength.issues || [],
            });
          }

          const existing = passwordMap.get(password) || [];
          existing.push(name);
          passwordMap.set(password, existing);
        } catch {
          // Skip secrets that can't be read
        }
      }

      const duplicates = Array.from(passwordMap.values()).filter((names) => names.length > 1);

      return {
        success: true,
        data: {
          totalSecrets: secrets.length,
          weakPasswords,
          duplicates,
        },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Get history
  ipcMain.handle('passshare:history', async (_, name: string, count?: number) => {
    try {
      const g = getGopass();
      const history = await g.history(name, count || 10);
      return { success: true, data: history };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Check if initialized
  ipcMain.handle('passshare:initialized', async () => {
    try {
      const g = getGopass();
      return { success: true, data: g.initialized };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });
}
