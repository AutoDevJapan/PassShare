import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { reactResolveFromApp } from "../../shared/vite/react-resolve";
import { cloudAssets } from "../../shared/vite/cloud-assets";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const reactResolve = reactResolveFromApp(rootDir);

export default defineConfig({
  plugins: [react(), cloudAssets(path.resolve(rootDir, "../.."))],
  clearScreen: false,
  resolve: {
    alias: {
      "@passshare/connect": path.resolve(rootDir, "../../packages/connect-js/dist/client.js"),
      "@shared": path.resolve(rootDir, "../../shared"),
      ...reactResolve.alias,
    },
    dedupe: reactResolve.dedupe,
  },
  server: {
    port: 5174,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
