import path from "node:path";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Plugin } from "vite";

// Every renderer packages independent copies of the same CI-tested Rust assets.
// This copies verified bytes; it never regenerates or edits the promoted assets.
export function cloudAssets(repository: string): Plugin {
  const folder = path.join(repository, "frontend/public/cloud-crypto");
  const manifest = JSON.parse(readFileSync(path.join(repository, "frontend/cloud-assets.json"), "utf8")) as {
    buildKind: string; artifact: string; inputs: Record<string, string>; assets: Record<string, string>;
  };
  const assets = new Map<string, Buffer>();
  function verify() {
    if (manifest.buildKind !== "github-actions-tested" || manifest.artifact !== "passshare-cloud-wasm") throw new Error("Unverified cloud WASM provenance");
    for (const [file, expected] of Object.entries(manifest.inputs)) {
      const text = readFileSync(path.join(repository, file), "utf8").replace(/\r\n/g, "\n");
      if (createHash("sha256").update(text).digest("hex") !== expected) throw new Error(`Cloud WASM source changed: ${file}`);
    }
    for (const [file, expected] of Object.entries(manifest.assets)) {
      if (!["boot.mjs", "passshare_cloud_wasm.js", "passshare_cloud_wasm_bg.wasm"].includes(file)) throw new Error("Unexpected cloud asset");
      const bytes = readFileSync(path.join(folder, file));
      if (createHash("sha256").update(bytes).digest("hex") !== expected) throw new Error(`Cloud WASM asset changed: ${file}`);
      assets.set(file, bytes);
    }
    if (assets.size !== 3) throw new Error("Missing cloud WASM assets");
  }
  return {
    name: "tested-cloud-assets",
    buildStart: verify,
    generateBundle() { for (const [file, source] of assets) this.emitFile({ type: "asset", fileName: `cloud-crypto/${file}`, source }); },
    configureServer(server) {
      verify();
      server.middlewares.use((request, response, next) => {
        const file = request.url?.split("?")[0]?.replace(/^\/cloud-crypto\//, "");
        const bytes = file && assets.get(file);
        if (!bytes) { next(); return; }
        response.setHeader("Content-Type", file!.endsWith(".wasm") ? "application/wasm" : "text/javascript");
        response.end(bytes);
      });
    },
  };
}
