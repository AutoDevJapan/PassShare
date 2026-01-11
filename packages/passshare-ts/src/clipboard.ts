/**
 * Clipboard utilities for PassShare.
 */

import { spawn } from 'child_process';

let clearTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Copy text to clipboard with auto-clear.
 *
 * @param text - The text to copy
 * @param timeout - Seconds before auto-clear (0 to disable)
 */
export async function copyToClipboard(text: string, timeout: number = 45): Promise<void> {
  // Cancel existing timer
  if (clearTimer) {
    clearTimeout(clearTimer);
    clearTimer = null;
  }

  await copyNative(text);

  // Set up auto-clear
  if (timeout > 0) {
    clearTimer = setTimeout(() => {
      clearTimer = null;
      clearClipboard().catch(() => {});
    }, timeout * 1000);
  }
}

/**
 * Clear the clipboard.
 */
export async function clearClipboard(): Promise<void> {
  await copyNative('');
}

async function copyNative(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let cmd: string;
    let args: string[];
    let input: Buffer;

    if (process.platform === 'darwin') {
      // macOS
      cmd = 'pbcopy';
      args = [];
      input = Buffer.from(text, 'utf-8');
    } else if (process.platform === 'win32') {
      // Windows - use PowerShell
      cmd = 'powershell';
      args = ['-command', `Set-Clipboard -Value "${text.replace(/"/g, '`"')}"`];
      input = Buffer.from('', 'utf-8');
    } else {
      // Linux - try xclip
      cmd = 'xclip';
      args = ['-selection', 'clipboard'];
      input = Buffer.from(text, 'utf-8');
    }

    const proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });

    proc.on('error', () => {
      // Try alternate commands for Linux
      if (process.platform === 'linux') {
        tryAlternateLinuxClipboard(text).then(resolve).catch(reject);
      } else {
        resolve(); // Don't fail on clipboard errors
      }
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        resolve(); // Don't fail on clipboard errors
      }
    });

    if (input.length > 0) {
      proc.stdin.write(input);
    }
    proc.stdin.end();
  });
}

async function tryAlternateLinuxClipboard(text: string): Promise<void> {
  const commands = [
    { cmd: 'xsel', args: ['--clipboard', '--input'] },
    { cmd: 'wl-copy', args: [] },
  ];

  for (const { cmd, args } of commands) {
    try {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });

        proc.on('error', reject);
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Exit code ${code}`));
        });

        proc.stdin.write(Buffer.from(text, 'utf-8'));
        proc.stdin.end();
      });
      return;
    } catch {
      continue;
    }
  }
}

/**
 * Get clipboard contents.
 *
 * @returns The clipboard text
 */
export async function getClipboard(): Promise<string> {
  return new Promise((resolve) => {
    let cmd: string;
    let args: string[];

    if (process.platform === 'darwin') {
      cmd = 'pbpaste';
      args = [];
    } else if (process.platform === 'win32') {
      cmd = 'powershell';
      args = ['-command', 'Get-Clipboard'];
    } else {
      cmd = 'xclip';
      args = ['-selection', 'clipboard', '-o'];
    }

    const proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';

    proc.stdout.on('data', (data) => {
      output += data.toString('utf-8');
    });

    proc.on('error', () => {
      resolve('');
    });

    proc.on('close', () => {
      resolve(output.trim());
    });
  });
}
