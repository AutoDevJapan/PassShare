import type { LocaleDocs } from "./types";

export const docsEn: LocaleDocs = {
  hub: {
    title: "Documentation",
    lead: "User guides, extension install steps, legal documents, and FAQ for PassShare.",
    links: [
      {
        path: "/docs/user-guide",
        title: "User guide",
        description: "Setup through daily use",
      },
      {
        path: "/docs/extension",
        title: "Extension install",
        description: "Chrome, Edge, Firefox, and Safari",
      },
      {
        path: "/faq",
        title: "FAQ",
        description: "Common questions and troubleshooting",
      },
      {
        path: "/terms",
        title: "Terms of service",
        description: "PassShare usage terms",
      },
      {
        path: "/privacy",
        title: "Privacy policy",
        description: "How we handle personal data",
      },
    ],
  },
  userGuide: {
    title: "User guide",
    lead: "How to use PassShare password boxes safely.",
    sections: [
      {
        id: "signup",
        title: "1. Create an account",
        paragraphs: [
          "Create a cloud account on the web portal (/app/signup). Desktop .pbox files work without an account. Distribution for general users is still being verified.",
          "Your master password is never sent to PassShare servers. It only unlocks your password box on your device.",
        ],
      },
      {
        id: "unlock",
        title: "2. Open a password box",
        paragraphs: [
          "On Desktop, select a .pbox file and unlock it with your master password.",
          "On Web, sign in to access cloud password boxes. Item contents are handled by the server and database. Your account password is separate from the desktop master password.",
        ],
      },
      {
        id: "crud",
        title: "3. Manage login items",
        paragraphs: ["Add, edit, and delete login items inside your password box."],
        list: [
          "Web: /app/vaults → select a password box → CRUD items",
          "Desktop: add, search, and copy (clipboard auto-clear)",
          "Mobile / Extension: same items via Connect API",
        ],
      },
      {
        id: "sync",
        title: "4. Cloud sync (Desktop)",
        paragraphs: [
          "Use Settings → Cloud sync to push or pull.",
          "On conflicts, choose local-wins or cloud-wins.",
        ],
      },
      {
        id: "migration",
        title: "5. Migration",
        paragraphs: [
          "From 1Password: import 1PUX or 1Password CSV export into PassShare.",
          "See the landing page migration section for more detail.",
          "CSV is plaintext and does not preserve every custom field, attachment, or URL. Verify imported contents before removing the source data. Keep a .pbox backup and your master password safe; the current recovery kit cannot open the box on its own.",
        ],
      },
    ],
  },
  extensionInstall: {
    title: "Extension install guide",
    lead: "Install the MV3 browser extension for autofill and save prompts.",
    sections: [
      {
        id: "chrome",
        title: "Google Chrome",
        paragraphs: ["Until Chrome Web Store release, load the unpacked build."],
        list: [
          "Run pnpm run build in packages/extension",
          "Open chrome://extensions → enable Developer mode",
          "Load unpacked → select dist/",
          "Sign in from the PassShare toolbar icon",
        ],
      },
      {
        id: "edge",
        title: "Microsoft Edge",
        paragraphs: ["Edge is Chromium-based; load dist/ the same way as Chrome."],
        list: ["Open edge://extensions → Developer mode ON", "Load extension → select dist/"],
      },
      {
        id: "firefox",
        title: "Mozilla Firefox",
        paragraphs: ["Firefox loads a temporary add-on from a zip archive."],
        list: [
          "Zip dist/ (manifest.json at archive root)",
          "Open about:debugging → Load Temporary Add-on",
          "Select the zip file",
        ],
      },
      {
        id: "safari",
        title: "Apple Safari",
        paragraphs: [
          "Safari requires converting the Web Extension via Xcode (developer workflow).",
          "Consumer App Store instructions will be added after store release.",
        ],
        list: [
          "See documents/runbooks/extension-store-release.md (Safari section)",
          "Convert packages/extension/dist for Safari Web Extension",
        ],
      },
    ],
  },
  terms: {
    title: "Terms of service",
    lead: "Terms for PassShare (web portal, desktop, mobile, extension, Connect API).",
    sections: [
      {
        id: "acceptance",
        title: "1. Acceptance",
        paragraphs: [
          "By using the service you agree to these terms.",
          "If you do not agree, do not use PassShare.",
        ],
      },
      {
        id: "service",
        title: "2. Service",
        paragraphs: [
          "PassShare provides encrypted password box storage and sync.",
          "Desktop .pbox files are encrypted on the device and the master password is not sent to the server. Web, cloud sync, and the Connect API send item contents to the server and database. The current cloud service is not end-to-end encrypted: the server can read item secrets.",
        ],
      },
      {
        id: "account",
        title: "3. Accounts",
        paragraphs: [
          "You must provide accurate registration data and protect your credentials.",
          "We may restrict access if misuse is suspected.",
        ],
      },
      {
        id: "prohibited",
        title: "4. Prohibited use",
        list: [
          "Illegal or harmful activity",
          "Unauthorized access to other accounts",
          "Abuse that harms availability (excessive API calls, etc.)",
          "Exploiting vulnerabilities",
        ],
        paragraphs: [],
      },
      {
        id: "disclaimer",
        title: "5. Disclaimer",
        paragraphs: [
          "The service is provided as-is. We are not liable for data loss if you lose your master password.",
          "We may suspend service for maintenance or force majeure.",
        ],
      },
      {
        id: "changes",
        title: "6. Changes",
        paragraphs: [
          "We may update these terms. Material changes will be announced on the web site.",
          "Continued use after changes constitutes acceptance.",
        ],
      },
    ],
    legalReview: [
      { label: "Document version", value: "0.2.0-draft" },
      { label: "Last updated", value: "2026-10-04" },
      { label: "Legal review", value: "Not completed (draft)" },
      { label: "Approval", value: "⏳ Legal sign-off required before production" },
    ],
  },
  privacy: {
    title: "Privacy policy",
    lead: "What we collect, why, and your rights.",
    sections: [
      {
        id: "controller",
        title: "1. Controller",
        paragraphs: ["PassShare (AutoDevJapan) is the controller for personal data in this service."],
      },
      {
        id: "collect",
        title: "2. Data we collect",
        list: [
          "Account data (email, display name)",
          "Auth/session metadata (HttpOnly cookies, Connect token identifiers)",
          "Connect API item contents, including titles, categories, usernames, passwords and notes. The current cloud server and database handle these contents.",
          "Access logs (IP, User-Agent, timestamps — no secrets logged)",
        ],
        paragraphs: [],
      },
      {
        id: "purpose",
        title: "3. Purposes",
        list: [
          "Authentication, authorization, account management",
          "Password box sync and backup",
          "Security, incident response, service improvement",
          "Legal compliance",
        ],
        paragraphs: [],
      },
      {
        id: "storage",
        title: "4. Storage and retention",
        paragraphs: [
          "Data is stored on Railway (PostgreSQL) and Vercel (frontend hosting).",
          "After account deletion requests, we delete related data within a reasonable period (except backup retention).",
        ],
      },
      {
        id: "thirdparty",
        title: "5. Third parties",
        paragraphs: [
          "We do not sell personal data. We disclose data only when required by law or with consent.",
          "Infrastructure providers (Railway, Vercel) process data on our behalf.",
        ],
      },
      {
        id: "rights",
        title: "6. Your rights",
        paragraphs: [
          "You may request access, correction, or deletion of your personal data.",
          "Contact: GitHub Issues or support channel (coming soon).",
        ],
      },
    ],
    legalReview: [
      { label: "Document version", value: "0.2.0-draft" },
      { label: "Last updated", value: "2026-10-04" },
      { label: "Legal review", value: "Not completed (draft)" },
      { label: "Approval", value: "⏳ Legal sign-off required before production" },
    ],
  },
  faq: {
    title: "FAQ",
    lead: "Common questions and troubleshooting.",
    sections: [
      {
        id: "forgot-master",
        title: "I forgot my master password",
        paragraphs: [
          "Master passwords are not stored on PassShare servers. Without it, box data cannot be decrypted.",
          "The current recovery kit cannot open a box without the master password. Keep a backup of your .pbox file and store your master password safely.",
        ],
      },
      {
        id: "sync-conflict",
        title: "Cloud sync conflicts",
        paragraphs: [
          "Open Desktop Settings → Cloud sync, review conflicts, and choose local-wins or cloud-wins.",
        ],
      },
      {
        id: "extension-login",
        title: "Extension sign-in fails",
        list: [
          "Verify OP_CONNECT_HOST points to the correct backend URL",
          "Sign in on Web to mint an extension refresh token",
          "Reload the extension and try again",
        ],
        paragraphs: [],
      },
      {
        id: "401",
        title: "API returns 401",
        list: [
          "Connect token expired → sign in again on Web / Mobile / Extension",
          "For CLI, verify OP_CONNECT_TOKEN is current",
        ],
        paragraphs: [],
      },
      {
        id: "clipboard",
        title: "Copied password does not clear",
        paragraphs: [
          "Check clipboard auto-clear seconds in Desktop / Web settings (default 30s).",
          "OS clipboard history is outside PassShare control.",
        ],
      },
    ],
  },
};
