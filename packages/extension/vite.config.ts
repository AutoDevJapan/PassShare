import path from "node:path";
import { fileURLToPath } from "node:url";
import { crx } from "@crxjs/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { reactResolveFromApp } from "../../shared/vite/react-resolve";
import manifest from "./manifest.config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const reactResolve = reactResolveFromApp(rootDir);

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  resolve: {
    alias: {
      "@shared": path.resolve(rootDir, "../../shared"),
      ...reactResolve.alias,
    },
    dedupe: reactResolve.dedupe,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      // The offscreen document is created at runtime via
      // `chrome.offscreen.createDocument("offscreen.html")`, so it is not
      // reachable from the manifest and must be declared as an explicit entry
      // to be emitted into the build.
      input: {
        offscreen: path.resolve(rootDir, "offscreen.html"),
      },
    },
  },
});
