/**
 * Configuration management for PassShare.
 *
 * Compatible with gopass config file format (~/.config/gopass/config).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';

/**
 * Get the default config file path.
 */
export function getDefaultConfigPath(): string {
  const envPath = process.env['GOPASS_CONFIG'];
  if (envPath) {
    return envPath;
  }

  if (process.platform === 'win32') {
    const appData = process.env['APPDATA'] ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'gopass', 'config');
  }

  const xdgConfig = process.env['XDG_CONFIG_HOME'] ?? path.join(os.homedir(), '.config');
  return path.join(xdgConfig, 'gopass', 'config');
}

/**
 * Get the default store path.
 */
export function getDefaultStorePath(): string {
  const envPath = process.env['PASSWORD_STORE_DIR'];
  if (envPath) {
    return envPath;
  }

  if (process.platform === 'win32') {
    const appData = process.env['APPDATA'] ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'gopass', 'stores', 'root');
  }

  const xdgData = process.env['XDG_DATA_HOME'] ?? path.join(os.homedir(), '.local', 'share');
  return path.join(xdgData, 'gopass', 'stores', 'root');
}

/** Default configuration values */
const DEFAULTS: Record<string, unknown> = {
  autoclip: true,
  autoimport: true,
  autopush: true,
  autosync: true,
  clipctrl: '',
  cliptimeout: 45,
  concurrency: 10,
  exportkeys: true,
  nocolor: false,
  noconfirm: false,
  nopager: false,
  notifications: true,
  parsing: true,
  safecontent: false,
  generate: {
    autoclip: true,
    length: 24,
    symbols: true,
    strict: false,
  },
  audit: {
    hibp: false,
  },
  edit: {
    editor: '',
  },
};

export class Config {
  private _path: string;
  private _data: Record<string, unknown> = {};
  private _mounts: Map<string, string> = new Map();
  private _storePath?: string;

  /**
   * Create a new Config.
   *
   * @param configPath - Path to config file
   */
  constructor(configPath?: string) {
    this._path = configPath ?? getDefaultConfigPath();
  }

  /** Get the config file path. */
  get path(): string {
    return this._path;
  }

  /** Get the root store path. */
  get storePath(): string {
    if (this._storePath) {
      return this._storePath;
    }
    const pathFromData = this._data['path'];
    if (typeof pathFromData === 'string') {
      return pathFromData;
    }
    return getDefaultStorePath();
  }

  /** Set the root store path. */
  set storePath(value: string) {
    this._storePath = value;
    this._data['path'] = value;
  }

  /** Get mount points. */
  get mounts(): Map<string, string> {
    return new Map(this._mounts);
  }

  /**
   * Get a config value.
   *
   * @param key - The config key (supports dot notation)
   * @param defaultValue - Default if not found
   * @returns The config value
   */
  get(key: string, defaultValue?: unknown): unknown {
    const parts = key.split('.');
    let value: unknown = this._data;

    for (const part of parts) {
      if (value && typeof value === 'object' && part in value) {
        value = (value as Record<string, unknown>)[part];
      } else {
        // Try defaults
        let defValue: unknown = DEFAULTS;
        for (const p of parts) {
          if (defValue && typeof defValue === 'object' && p in defValue) {
            defValue = (defValue as Record<string, unknown>)[p];
          } else {
            return defaultValue;
          }
        }
        return defValue;
      }
    }

    return value;
  }

  /**
   * Get a boolean config value.
   *
   * @param key - The config key
   * @returns The boolean value
   */
  getBool(key: string): boolean {
    const value = this.get(key, false);
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      return ['true', 'yes', '1', 'on'].includes(value.toLowerCase());
    }
    return Boolean(value);
  }

  /**
   * Get an integer config value.
   *
   * @param key - The config key
   * @returns The integer value
   */
  getInt(key: string): number {
    const value = this.get(key, 0);
    if (typeof value === 'number') {
      return Math.floor(value);
    }
    const parsed = parseInt(String(value), 10);
    return isNaN(parsed) ? 0 : parsed;
  }

  /**
   * Set a config value.
   *
   * @param key - The config key (supports dot notation)
   * @param value - The value to set
   */
  set(key: string, value: unknown): void {
    const parts = key.split('.');

    if (parts.length === 1) {
      this._data[key] = value;
    } else {
      let current: Record<string, unknown> = this._data;
      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        if (!(part in current)) {
          current[part] = {};
        }
        current = current[part] as Record<string, unknown>;
      }
      current[parts[parts.length - 1]] = value;
    }
  }

  /**
   * Add a mount point.
   *
   * @param alias - The mount alias
   * @param mountPath - The store path
   */
  addMount(alias: string, mountPath: string): void {
    this._mounts.set(alias, mountPath);
  }

  /**
   * Remove a mount point.
   *
   * @param alias - The mount alias
   * @returns True if removed
   */
  removeMount(alias: string): boolean {
    return this._mounts.delete(alias);
  }

  /** Load config from file. */
  load(): void {
    if (!fs.existsSync(this._path)) {
      return;
    }

    try {
      const content = fs.readFileSync(this._path, 'utf-8');
      const data = yaml.load(content) as Record<string, unknown> | null;

      if (!data || typeof data !== 'object') {
        return;
      }

      // Extract mounts
      const mounts = data['mounts'];
      if (mounts && typeof mounts === 'object') {
        this._mounts = new Map(Object.entries(mounts as Record<string, string>));
        delete data['mounts'];
      }

      this._data = data;
    } catch {
      // Ignore parse errors
    }
  }

  /** Save config to file. */
  save(): void {
    // Ensure directory exists
    const dir = path.dirname(this._path);
    fs.mkdirSync(dir, { recursive: true });

    // Combine data and mounts
    const data: Record<string, unknown> = { ...this._data };
    if (this._mounts.size > 0) {
      data['mounts'] = Object.fromEntries(this._mounts);
    }

    const content = yaml.dump(data, { lineWidth: -1 });
    fs.writeFileSync(this._path, content, 'utf-8');
  }
}
