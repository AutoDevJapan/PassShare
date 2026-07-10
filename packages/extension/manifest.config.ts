import { defineManifest } from "@crxjs/vite-plugin";

export default defineManifest({
  manifest_version: 3,
  name: "PassShare",
  description: "PassShare password manager browser extension",
  version: "0.1.0",
  action: {
    default_popup: "popup.html",
    default_title: "PassShare",
  },
  background: {
    service_worker: "src/background/service-worker.ts",
    type: "module",
  },
  content_scripts: [
    {
      // Only inject over HTTPS. Plain HTTP is limited to loopback hosts so
      // autofill/save still works during local development but is never
      // offered on insecure public pages where credentials could be sniffed.
      matches: ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"],
      js: ["src/content/autofill.ts"],
      run_at: "document_idle",
      all_frames: false,
    },
  ],
  permissions: ["storage", "activeTab"],
  host_permissions: [
    "http://127.0.0.1:8080/*",
    "http://127.0.0.1:3000/*",
    "http://localhost:8080/*",
    "http://localhost:3000/*",
    "https://*/*",
  ],
  icons: {
    "16": "public/icons/16.png",
    "48": "public/icons/48.png",
    "128": "public/icons/128.png",
  },
});
