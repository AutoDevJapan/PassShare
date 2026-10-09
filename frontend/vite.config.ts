import path from "node:path";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { reactResolveFromApp } from "../shared/vite/react-resolve";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const reactResolve = reactResolveFromApp(rootDir);

// Promote the exact module accepted in CI; reject stale Rust sources or assets.
// Text source fingerprints normalize checkout line endings on Windows.
function verifyCloudAssets() {
  const manifest = JSON.parse(readFileSync(path.join(rootDir, "cloud-assets.json"), "utf8")) as {
    inputs: Record<string, string>; assets: Record<string, string>;
  };
  for (const [file, expected] of Object.entries(manifest.inputs)) {
    const source = readFileSync(path.resolve(rootDir, "..", file), "utf8").replace(/\r\n/g, "\n");
    if (createHash("sha256").update(source).digest("hex") !== expected) {
      throw new Error(`Cloud WASM sources changed; regenerate the tested web assets: ${file}`);
    }
  }
  for (const [file, expected] of Object.entries(manifest.assets)) {
    const asset = readFileSync(path.join(rootDir, "public/cloud-crypto", file));
    if (createHash("sha256").update(asset).digest("hex") !== expected) {
      throw new Error(`Cloud WASM asset differs from the tested module: ${file}`);
    }
  }
}

export default defineConfig({
  plugins: [react(), { name: "tested-cloud-assets", buildStart: verifyCloudAssets }],
  resolve: {
    alias: {
      "@shared": path.resolve(rootDir, "../shared"),
      "@passshare/connect": path.resolve(rootDir, "../packages/connect-js/dist/client.js"),
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
