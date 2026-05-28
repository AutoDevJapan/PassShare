import type { TokenAuthResponse } from "./auth-api";
import { saveConnectToken, saveRefreshToken } from "./storage";

export async function persistAuthSession(response: TokenAuthResponse): Promise<void> {
  await saveRefreshToken(response.refreshToken);
  await saveConnectToken(response.connectAccessToken, response.connectExpiresAt);
}
