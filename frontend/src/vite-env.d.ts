/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Electron API
interface Window {
  electronAPI?: {
    getAppVersion: () => Promise<string>;
    getPlatform: () => Promise<NodeJS.Platform>;
    isElectron: boolean;
  };
}
