import type { BackgroundRequest, BackgroundResponse, CredentialMatch } from "../lib/constants";
import {
  findPasswordInput,
  findUsernameInput,
  isAutofillAllowed,
} from "../lib/connect-items";
import { debounce } from "../lib/debounce";

const PANEL_ID = "passshare-autofill-panel";

// Coalesce bursts of `focusin` events (e.g. tabbing through a form) into a
// single credential lookup so the service worker is not queried per keystroke.
const FOCUS_DEBOUNCE_MS = 150;

// The password field the user is currently editing. Autofill is scoped to this
// field's form so we do not clobber an unrelated form at the top of the page.
let activePasswordInput: HTMLInputElement | null = null;

function sendBackgroundMessage<T extends BackgroundResponse>(
  message: BackgroundRequest,
): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: T) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

function removePanel(): void {
  document.getElementById(PANEL_ID)?.remove();
}

function fillInputs(username: string, password: string): void {
  // Prefer the form of the focused password field; fall back to the document
  // only when the field is not inside a form.
  const scope: HTMLFormElement | Document = activePasswordInput?.form ?? document;
  const passwordInput = activePasswordInput ?? findPasswordInput(scope);
  const usernameInput = findUsernameInput(scope);
  if (usernameInput) {
    usernameInput.value = username;
    usernameInput.dispatchEvent(new Event("input", { bubbles: true }));
  }
  if (passwordInput) {
    passwordInput.value = password;
    passwordInput.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

function renderPanel(matches: CredentialMatch[]): void {
  removePanel();
  if (matches.length === 0) {
    return;
  }

  const panel = document.createElement("div");
  panel.id = PANEL_ID;
  panel.setAttribute("role", "listbox");
  panel.style.cssText =
    "position:fixed;z-index:2147483647;top:12px;right:12px;max-width:320px;background:#0b1220;color:#e2e8f0;border:1px solid #334155;border-radius:12px;padding:8px;font:14px/1.4 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.35)";

  const title = document.createElement("div");
  title.textContent = "PassShare";
  title.style.cssText = "font-weight:600;margin-bottom:8px";
  panel.appendChild(title);

  for (const match of matches.slice(0, 5)) {
    const button = document.createElement("button");
    button.type = "button";
    button.style.cssText =
      "display:block;width:100%;text-align:left;background:#111827;border:1px solid #1f2937;color:inherit;border-radius:8px;padding:8px;margin:0 0 6px;cursor:pointer";
    button.innerHTML = `<strong>${escapeHtml(match.title)}</strong><br><span>${escapeHtml(match.username || "(no username)")}</span>`;
    button.addEventListener("click", () => {
      fillInputs(match.username, match.password);
      removePanel();
    });
    panel.appendChild(button);
  }

  document.documentElement.appendChild(panel);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function showMatchesForCurrentPage(): Promise<void> {
  const hostname = window.location.hostname;
  if (!hostname) {
    return;
  }

  const response = await sendBackgroundMessage<{ ok: boolean; matches: CredentialMatch[] }>({
    type: "GET_CREDENTIALS_FOR_HOST",
    hostname,
  });

  if (response.ok) {
    renderPanel(response.matches);
  }
}

function attachPasswordFocusHandler(): void {
  const requestMatches = debounce(() => {
    void showMatchesForCurrentPage();
  }, FOCUS_DEBOUNCE_MS);

  document.addEventListener(
    "focusin",
    (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement) || target.type !== "password") {
        return;
      }
      // Track the active field synchronously so autofill targets the right form
      // even though the lookup itself is debounced.
      activePasswordInput = target;
      requestMatches();
    },
    true,
  );
}

function attachSavePrompt(): void {
  document.addEventListener(
    "submit",
    (event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement)) {
        return;
      }

      const passwordInput = findPasswordInput(form);
      if (!passwordInput?.value) {
        return;
      }

      const usernameInput = findUsernameInput(form);
      const username = usernameInput?.value ?? "";
      const password = passwordInput.value;
      const url = window.location.href;
      const title = document.title || window.location.hostname;

      showSaveBanner(String(title), username, password, url);
    },
    true,
  );
}

function showSaveBanner(title: string, username: string, password: string, url: string): void {
  if (document.getElementById("passshare-save-banner")) {
    return;
  }

  const banner = document.createElement("div");
  banner.id = "passshare-save-banner";
  banner.style.cssText =
    "position:fixed;z-index:2147483646;bottom:16px;right:16px;max-width:320px;background:#0b1220;color:#e2e8f0;border:1px solid #334155;border-radius:12px;padding:12px;font:14px/1.4 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.35)";

  const text = document.createElement("p");
  text.textContent = "Save this login to PassShare?";
  text.style.margin = "0 0 8px";
  banner.appendChild(text);

  const actions = document.createElement("div");
  actions.style.display = "flex";
  actions.style.gap = "8px";

  const saveButton = document.createElement("button");
  saveButton.type = "button";
  saveButton.textContent = "Save";
  saveButton.style.cssText =
    "flex:1;background:#22c55e;color:#052e16;border:none;border-radius:8px;padding:8px;cursor:pointer";
  saveButton.addEventListener("click", () => {
    void sendBackgroundMessage({
      type: "SAVE_CREDENTIAL",
      title,
      username,
      password,
      url,
    }).finally(() => banner.remove());
  });

  const dismissButton = document.createElement("button");
  dismissButton.type = "button";
  dismissButton.textContent = "Dismiss";
  dismissButton.style.cssText =
    "flex:1;background:#1f2937;color:#e2e8f0;border:1px solid #334155;border-radius:8px;padding:8px;cursor:pointer";
  dismissButton.addEventListener("click", () => banner.remove());

  actions.appendChild(saveButton);
  actions.appendChild(dismissButton);
  banner.appendChild(actions);
  document.documentElement.appendChild(banner);
}

// Do not offer autofill or save on insecure pages (plain HTTP, except local dev).
if (isAutofillAllowed(window.location.protocol, window.location.hostname)) {
  attachPasswordFocusHandler();
  attachSavePrompt();
}
