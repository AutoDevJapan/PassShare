/**
 * IPC Handlers for PassShare operations
 *
 * Placeholder implementation for initial release
 */

import { ipcMain } from 'electron';

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

  // Check if initialized (placeholder)
  ipcMain.handle('passshare:initialized', async () => {
    return { success: true, data: false };
  });
}
