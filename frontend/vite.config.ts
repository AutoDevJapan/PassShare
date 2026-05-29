import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { reactResolveFromApp } from "../shared/vite/react-resolve";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const reactResolve = reactResolveFromApp(rootDir);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@shared": path.resolve(rootDir, "../shared"),
      ...reactResolve.alias,
    },
    dedupe: reactResolve.dedupe,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8080",
        changeOrigin: true,
      },
      "/v1": {
        target: "http://127.0.0.1:8080",
        changeOrigin: true,
      },
    },
  },
});
