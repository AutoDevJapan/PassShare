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
  loadConnectToken,
  loadRefreshToken,
  saveConnectToken,
} from "../lib/storage";

async function getConnectClient(): Promise<ConnectClient | null> {
  const refreshToken = await loadRefreshToken();
  if (!refreshToken) {
    return null;
  }

  const user = await fetchCurrentUser(refreshToken);
  if (!user) {
    await clearAllAuthStorage();
    return null;
  }

  let accessToken = await loadConnectToken();
  if (!accessToken) {
    const refreshed = await refreshConnectToken(refreshToken);
    accessToken = refreshed.connectAccessToken;
    await saveConnectToken(refreshed.connectAccessToken, refreshed.connectExpiresAt);
  }

  return new ConnectClient({ host: getApiBaseUrl(), token: accessToken });
}

async function listCredentialMatches(hostname: string): Promise<CredentialMatch[]> {
  const client = await getConnectClient();
  if (!client) {
    return [];
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
