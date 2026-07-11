import { ConnectClient } from "@passshare/connect";
import {
  fetchCurrentUser,
  getApiBaseUrl,
  refreshConnectToken,
} from "../lib/auth-api";
import type { BackgroundRequest, BackgroundResponse, CredentialMatch } from "../lib/constants";
import {
  connectItemFromApi,
  connectItemToCreateBody,
  hostnameMatchesItem,
} from "../lib/connect-items";
import { generatePassword } from "../lib/password-generator";
import {
  clearAllAuthStorage,
  loadRefreshToken,
  loadStoredConnectToken,
  saveConnectToken,
} from "../lib/storage";
import { bootstrapConnectSession } from "@shared/lib/connect-session";
import { createCachedLookup } from "../lib/cached-lookup";

/**
 * Credential discovery decrypts every login item across every vault, so it is
 * expensive (O(vaults × items)). Cache the matches per hostname for a short
 * window and de-duplicate concurrent lookups so repeated `focusin` events on a
 * password field do not each trigger a full re-decrypt.
 */
const CREDENTIAL_CACHE_TTL_MS = 30_000;
const listCredentialMatches = createCachedLookup<CredentialMatch[]>({
  fetcher: fetchCredentialMatches,
  ttlMs: CREDENTIAL_CACHE_TTL_MS,
  fallback: [],
});

async function getConnectClient(): Promise<ConnectClient | null> {
  const result = await bootstrapConnectSession(
    {
      async load() {
        const refreshToken = await loadRefreshToken();
        if (!refreshToken) {
          return null;
        }
        const connect = await loadStoredConnectToken();
        return {
          refreshToken,
          connectAccessToken: connect?.token ?? "",
          connectExpiresAt: connect?.expiresAt ?? "",
        };
      },
      save: (session) => saveConnectToken(session.connectAccessToken, session.connectExpiresAt),
      async clear() {
        await clearAllAuthStorage();
        // The stored user is gone; drop any cached credential matches too.
        listCredentialMatches.invalidate();
      },
    },
    { fetchCurrentUser, refreshConnectToken },
  );

  if (!result) {
    return null;
  }

  return new ConnectClient({ host: getApiBaseUrl(), token: result.accessToken });
}

async function fetchCredentialMatches(
  hostname: string,
): Promise<CredentialMatch[] | null> {
  const client = await getConnectClient();
  if (!client) {
    return null;
  }

  const vaults = await client.listVaults();
  const matches: CredentialMatch[] = [];

  for (const vault of vaults) {
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
        username: mapped.username,
        password: mapped.password,
        url: mapped.url,
      });
    }
  }

  return matches;
}

async function saveCredential(payload: {
  title: string;
  username: string;
  password: string;
  url: string;
}): Promise<void> {
  const client = await getConnectClient();
  if (!client) {
    throw new Error("Not authenticated");
  }

  const vaults = await client.listVaults();
  const vault = vaults[0];
  if (!vault) {
    throw new Error("No password box available");
  }

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
  // A newly saved login can match a page the user just visited, so drop the
  // cached matches to force a fresh lookup on the next focus.
  listCredentialMatches.invalidate();
}

chrome.runtime.onMessage.addListener((message: BackgroundRequest, _sender, sendResponse) => {
  void (async () => {
    try {
      let response: BackgroundResponse;

      switch (message.type) {
        case "GET_CREDENTIALS_FOR_HOST": {
          const matches = await listCredentialMatches(message.hostname);
          response = { ok: true, matches };
          break;
        }
        case "GENERATE_PASSWORD": {
          response = { ok: true, password: generatePassword(message.length ?? 20) };
          break;
        }
        case "SAVE_CREDENTIAL": {
          await saveCredential(message);
          response = { ok: true };
          break;
        }
        case "FILL_CREDENTIAL": {
          const client = await getConnectClient();
          if (!client) {
            response = { ok: false, error: "Not authenticated" };
            break;
          }
          const item = await client.getItem(message.vaultId, message.itemId);
          const mapped = connectItemFromApi(item);
          response = {
            ok: true,
            matches: [
              {
                itemId: mapped.id,
                vaultId: message.vaultId,
                title: mapped.title,
                username: mapped.username,
                password: mapped.password,
                url: mapped.url,
              },
            ],
          };
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
