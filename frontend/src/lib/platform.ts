/**
 * Platform detection utilities
 * © 2026 株式会社BM1314. All rights reserved.
 */

export type Platform = 'web' | 'electron' | 'ios' | 'android';

/**
 * Detect current platform
 */
export function getPlatform(): Platform {
  // Electron
  if (typeof window !== 'undefined' && window.electronAPI?.isElectron) {
    return 'electron';
  }

  // Capacitor (iOS/Android)
  if (typeof window !== 'undefined' && 'Capacitor' in window) {
    const capacitor = (window as any).Capacitor;
    if (capacitor?.isNativePlatform?.()) {
      const platform = capacitor.getPlatform?.();
      if (platform === 'ios') return 'ios';
      if (platform === 'android') return 'android';
    }
  }

  // Default to web
  return 'web';
}

/**
 * Check if running in native environment (Electron or Capacitor)
 */
export function isNative(): boolean {
  const platform = getPlatform();
  return platform !== 'web';
}

/**
 * Check if running in mobile environment
 */
export function isMobile(): boolean {
  const platform = getPlatform();
  return platform === 'ios' || platform === 'android';
}

/**
 * Check if running in desktop environment
 */
export function isDesktop(): boolean {
  const platform = getPlatform();
  return platform === 'electron';
}

/**
 * Get API base URL based on platform
 */
export function getApiBaseUrl(): string {
  const platform = getPlatform();

  // In development, use local API
  if (import.meta.env.DEV) {
    return 'http://localhost:8000';
  }

  // In production, use Railway API
  return import.meta.env.VITE_API_URL || 'https://passshare-api.up.railway.app';
}
