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
  },
});
