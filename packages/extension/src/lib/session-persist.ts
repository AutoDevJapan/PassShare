import type { TokenAuthResponse } from "./auth-api";
import { saveStoredAuthSession } from "./storage";

export async function persistAuthSession(response: TokenAuthResponse, isCurrent = () => true): Promise<boolean> {
  return saveStoredAuthSession(response, isCurrent);
}
