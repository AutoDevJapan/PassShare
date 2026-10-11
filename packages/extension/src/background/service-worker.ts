import { ConnectClient } from "@passshare/connect";
import {
  fetchCurrentUser,
  getApiBaseUrl,
  refreshConnectToken,
} from "../lib/auth-api";
import type {
  BackgroundRequest,
  BackgroundResponse,
  CredentialMatch,
  OffscreenClearClipboardRequest,
  OffscreenClearClipboardResponse,
} from "../lib/constants";
import { OFFSCREEN_CLEAR_CLIPBOARD } from "../lib/constants";
import {
  type ClipboardClearEnv,
  type ClipboardClearState,
  handleClipboardClearAlarm,
  scheduleClipboardClear,
} from "./clipboard-clear";
import {
  connectItemFromApi,
  connectItemToCreateBody,
  hostnameMatchesItem,
} from "../lib/connect-items";
import { generatePassword } from "../lib/password-generator";
import {
  clearAllAuthStorage,
  loadRefreshToken,
  loadStoredAuthSession,
  saveConnectToken,
} from "../lib/storage";
import { bootstrapConnectSession } from "@shared/lib/connect-session";
import { readBoxMode } from "@shared/cloud/box-mode";
import { createCloudSession } from "@shared/cloud/session-transport";

async function getConnectClient() {
  let heldToken: string | null = null;
  const result = await bootstrapConnectSession(
    {
      async load() {
        const session = await loadStoredAuthSession();
        heldToken = session?.refreshToken ?? null;
        return session;
      },
      save: (session) => saveConnectToken(session.connectAccessToken, session.connectExpiresAt, session.refreshToken),
      async clear() {
        await clearAllAuthStorage(heldToken ?? undefined);
        // The stored user is gone; drop any cached credential matches too.

      },
    },
    { fetchCurrentUser, refreshConnectToken },
  );

  if (!result || !heldToken || await loadRefreshToken() !== heldToken) {
    return null;
  }

  return { client: new ConnectClient({ host: getApiBaseUrl(), token: result.accessToken }),
    cloud: createCloudSession(getApiBaseUrl(), result.user.id, heldToken) };
}

async function fetchCredentialMatches(
  hostname: string,
): Promise<CredentialMatch[] | null> {
  const auth = await getConnectClient();
  if (!auth) {
    return null;
  }

  const { client, cloud } = auth;
  try {
  const vaults = await client.listVaults();
  const matches: CredentialMatch[] = [];

  for (const vault of vaults) {
    const mode = await readBoxMode(cloud.api, vault.id, new AbortController().signal, async (id) => { await client.getVault(id); });
    if (mode.mode === "encrypted") continue;
    const items = await client.listItems(vault.id);
    for (const overview of items) {
      if (overview.category !== "LOGIN") {
        continue;
      }
      const item = await client.getItem(vault.id, overview.id);
      const mapped = connectItemFromApi(item);
      if (!mapped.username && !mapped.password) {
        continue;
      }
      if (!hostnameMatchesItem(hostname, mapped.url)) {
        continue;
      }
      matches.push({
        itemId: mapped.id,
        vaultId: vault.id,
        title: mapped.title,
        username: mapped.username ?? "",
        // Discovery returns display metadata only. Selection performs a fresh
        // mode/session check before any plaintext is sent to the page.
        password: "",
        url: mapped.url ?? null,
        accountId: cloud.userId,
      });
    }
  }

  return matches;
  } finally { cloud.dispose(); }
}

async function saveCredential(payload: {
  title: string;
  username: string;
  password: string;
  url: string;
}): Promise<void> {
  const auth = await getConnectClient();
  if (!auth) {
    throw new Error("Not authenticated");
  }

  const { client, cloud } = auth;
  try {
  const vaults = await client.listVaults();
  const vault = vaults[0];
  if (!vault) {
    throw new Error("No password box available");
  }

  const mode = await readBoxMode(cloud.api, vault.id, new AbortController().signal, async (id) => { await client.getVault(id); });
  if (mode.mode !== "compatibility") throw new Error("Encrypted autofill is unavailable");
  const body = connectItemToCreateBody({
    title: payload.title,
    category: "LOGIN",
    username: payload.username,
    password: payload.password,
    url: payload.url,
    notes: "",
    tags: "",
    favorite: false,
    body: "",
  });

  await client.createItem(vault.id, body);
  // No plaintext discovery cache is retained between page requests.
  } finally { cloud.dispose(); }
}

/**
 * Bridge the injectable clipboard-clear logic to the real `chrome.*` APIs.
 * Kept as a factory so the pure logic in `clipboard-clear.ts` stays testable
 * with in-memory fakes.
 */
const clipboardClearEnv: ClipboardClearEnv = {
  now: () => Date.now(),
  alarms: {
    create: (name, alarmInfo) => chrome.alarms.create(name, alarmInfo),
  },
  session: {
    async get(key) {
      const stored = await chrome.storage.session.get(key);
      return (stored[key] as ClipboardClearState | undefined) ?? null;
    },
    async set(key, value) {
      await chrome.storage.session.set({ [key]: value });
    },
    async remove(key) {
      await chrome.storage.session.remove(key);
    },
  },
  offscreen: {
    hasDocument: () => chrome.offscreen.hasDocument(),
    create: (path) =>
      chrome.offscreen.createDocument({
        url: path,
        reasons: [chrome.offscreen.Reason.CLIPBOARD],
        justification: "Clear the copied secret from the clipboard after the auto-clear delay.",
      }),
    close: () => chrome.offscreen.closeDocument(),
  },
  async requestOffscreenClear(hash) {
    const request: OffscreenClearClipboardRequest = { type: OFFSCREEN_CLEAR_CLIPBOARD, hash };
    // The service worker never receives its own broadcast, so only the
    // offscreen document handles this; awaiting its reply keeps the offscreen
    // document alive until the clear completes.
    await (chrome.runtime.sendMessage(request) as Promise<OffscreenClearClipboardResponse>).catch(
      () => undefined,
    );
  },
};

chrome.alarms.onAlarm.addListener((alarm) => {
  void handleClipboardClearAlarm(clipboardClearEnv, alarm.name);
});

chrome.runtime.onMessage.addListener((message: BackgroundRequest, _sender, sendResponse) => {
  void (async () => {
    try {
      let response: BackgroundResponse;

      switch (message.type) {
        case "GET_CREDENTIALS_FOR_HOST": {
          const matches = await fetchCredentialMatches(message.hostname);
          response = { ok: true, matches: matches ?? [] };
          break;
        }
        case "GENERATE_PASSWORD": {
          response = { ok: true, password: generatePassword(message.length ?? 20) };
          break;
        }
        case "SCHEDULE_CLIPBOARD_CLEAR": {
          await scheduleClipboardClear(clipboardClearEnv, message.hash, message.seconds);
          response = { ok: true };
          break;
        }
        case "SAVE_CREDENTIAL": {
          await saveCredential(message);
          response = { ok: true };
          break;
        }
        case "FILL_CREDENTIAL": {
          const auth = await getConnectClient();
          if (!auth) {
            response = { ok: false, error: "Not authenticated" };
            break;
          }
          const { client, cloud } = auth;
          try {
          if (cloud.userId !== message.accountId) throw new Error("Not authenticated");
          const mode = await readBoxMode(cloud.api, message.vaultId, new AbortController().signal, async (id) => { await client.getVault(id); });
          if (mode.mode !== "compatibility") throw new Error("Encrypted autofill is unavailable");
          const item = await client.getItem(message.vaultId, message.itemId);
          const mapped = connectItemFromApi(item);
          response = {
            ok: true,
            matches: [
              {
                itemId: mapped.id,
                vaultId: message.vaultId,
                title: mapped.title,
                username: mapped.username ?? "",
                password: mapped.password ?? "",
                url: mapped.url ?? null,
                accountId: cloud.userId,
              },
            ],
          };
          } finally { cloud.dispose(); }
          break;
        }
        default:
          response = { ok: false, error: "Unknown message type" };
      }

      sendResponse(response);
    } catch (error) {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : "Unexpected error",
      });
    }
  })();

  return true;
});
