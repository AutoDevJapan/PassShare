/**
 * Auto-updater for PassShare Desktop
 */

import { autoUpdater } from 'electron';
import { app, dialog } from 'electron';

const UPDATE_SERVER_URL = 'https://update.pass-share.bm1314.net';

export function setupAutoUpdater(): void {
  // Skip auto-update in development
  if (!app.isPackaged) {
    return;
  }

  const platform = process.platform === 'darwin' ? 'darwin' : 'win32';
  const feedURL = `${UPDATE_SERVER_URL}/update/${platform}/${app.getVersion()}`;

  try {
    autoUpdater.setFeedURL({ url: feedURL });
  } catch (error) {
    console.error('Failed to set update feed URL:', error);
    return;
  }

  // Check for updates on startup
  setTimeout(() => {
    try {
      autoUpdater.checkForUpdates();
    } catch (error) {
      console.error('Failed to check for updates:', error);
    }
  }, 10000); // Wait 10 seconds after startup

  // Check for updates every 4 hours
  setInterval(() => {
    try {
      autoUpdater.checkForUpdates();
    } catch (error) {
      console.error('Failed to check for updates:', error);
    }
  }, 4 * 60 * 60 * 1000);

  // Event handlers
  autoUpdater.on('error', (error) => {
    console.error('Auto-updater error:', error);
  });

  autoUpdater.on('checking-for-update', () => {
    console.log('Checking for updates...');
  });

  autoUpdater.on('update-available', () => {
    console.log('Update available, downloading...');
  });

  autoUpdater.on('update-not-available', () => {
    console.log('No updates available');
  });

  autoUpdater.on('update-downloaded', (_event, releaseNotes, releaseName) => {
    const dialogOpts = {
      type: 'info' as const,
      buttons: ['Restart', 'Later'],
      title: 'Application Update',
      message: releaseName || 'A new version is available',
      detail: 'A new version has been downloaded. Restart the application to apply the updates.',
    };

    dialog.showMessageBox(dialogOpts).then((returnValue) => {
      if (returnValue.response === 0) {
        autoUpdater.quitAndInstall();
      }
    });
  });
}

export function checkForUpdatesManually(): void {
  try {
    autoUpdater.checkForUpdates();
  } catch (error) {
    console.error('Failed to check for updates:', error);
    dialog.showErrorBox(
      'Update Check Failed',
      'Unable to check for updates. Please try again later.'
    );
  }
}
