import {
  DEFAULT_LOCALE,
  getMessages,
  isLocale,
  resolveBrowserLocale,
  type MessageKey,
} from "@shared/i18n/index";
import type { BackgroundRequest, BackgroundResponse, CredentialMatch } from "../lib/constants";
import { STORAGE_KEYS } from "../lib/constants";
import {
  findPasswordInput,
  findUsernameInput,
  isAutofillAllowed,
} from "../lib/connect-items";
import { debounce } from "../lib/debounce";
import { loadLocale } from "../lib/storage";

const PANEL_ID = "passshare-autofill-panel";
const SAVE_BANNER_ID = "passshare-save-banner";

// Coalesce bursts of `focusin` events (e.g. tabbing through a form) into a
// single credential lookup so the service worker is not queried per keystroke.
const FOCUS_DEBOUNCE_MS = 150;

// The password field the user is currently editing. Autofill is scoped to this
// field's form so we do not clobber an unrelated form at the top of the page.
let activePasswordInput: HTMLInputElement | null = null;

// Content scripts run in the page's world and cannot reach the popup's React
// I18nProvider or its localStorage. We resolve the active locale from
// chrome.storage.local (written by the popup) and fall back to the browser
// locale, then localize the injected UI with the shared message catalog.
let messages = getMessages(
  typeof navigator !== "undefined" ? resolveBrowserLocale() : DEFAULT_LOCALE,
);

function applyLocale(locale: string): void {
  if (isLocale(locale)) {
    messages = getMessages(locale);
  }
}

async function initLocale(): Promise<void> {
  try {
    const stored = await loadLocale();
    if (stored) {
      applyLocale(stored);
    }
  } catch {
    // storage may be unavailable on restricted pages; keep the browser locale.
  }
}

const localeReady = initLocale();

// Keep the injected UI in sync if the user switches language in the popup.
chrome.storage?.onChanged?.addListener((changes, area) => {
  if (area !== "local") {
    return;
  }
  const next = changes[STORAGE_KEYS.locale]?.newValue;
  if (typeof next === "string") {
    applyLocale(next);
  }
});

function t(key: MessageKey): string {
  return messages[key];
}

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

// Cleanup for listeners bound outside the panel element (e.g. on the password
// field), invoked when the panel is torn down so nothing leaks between renders.
let panelCleanup: (() => void) | null = null;
let panelGeneration = 0;

function removePanel(): void {
  ++panelGeneration;
  panelCleanup?.();
  panelCleanup = null;
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
  const generation = panelGeneration;
  if (matches.length === 0) {
    return;
  }

  const panel = document.createElement("div");
  panel.id = PANEL_ID;
  // ARIA listbox: the panel owns a set of `role="option"` children, navigable
  // with the arrow keys and dismissable with Escape.
  panel.setAttribute("role", "listbox");
  panel.setAttribute("aria-label", t("extension.autofill.title"));
  panel.tabIndex = -1;
  panel.style.cssText =
    "position:fixed;z-index:2147483647;top:12px;right:12px;max-width:320px;background:#0b1220;color:#e2e8f0;border:1px solid #334155;border-radius:12px;padding:8px;font:14px/1.4 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.35)";

  const title = document.createElement("div");
  title.textContent = t("extension.autofill.title");
  title.style.cssText = "font-weight:600;margin-bottom:8px";
  panel.appendChild(title);

  const options: HTMLElement[] = [];
  let activeIndex = 0;

  function focusOption(index: number): void {
    if (options.length === 0) {
      return;
    }
    const clamped = (index + options.length) % options.length;
    const previous = options[activeIndex];
    previous.tabIndex = -1;
    previous.setAttribute("aria-selected", "false");
    activeIndex = clamped;
    const current = options[activeIndex];
    current.tabIndex = 0;
    current.setAttribute("aria-selected", "true");
    current.focus();
  }

  matches.slice(0, 5).forEach((match, index) => {
    const option = document.createElement("div");
    option.setAttribute("role", "option");
    option.id = `${PANEL_ID}-option-${index}`;
    option.setAttribute("aria-selected", index === 0 ? "true" : "false");
    // Roving tabindex: only the active option is in the tab order.
    option.tabIndex = index === 0 ? 0 : -1;
    option.style.cssText =
      "display:block;width:100%;text-align:left;background:#111827;border:1px solid #1f2937;color:inherit;border-radius:8px;padding:8px;margin:0 0 6px;cursor:pointer";
    option.innerHTML = `<strong>${escapeHtml(match.title)}</strong><br><span>${escapeHtml(match.username || t("extension.autofill.noUsername"))}</span>`;
    const choose = async (): Promise<void> => {
      const response = await sendBackgroundMessage<{ ok: boolean; matches?: CredentialMatch[] }>({
        type: "FILL_CREDENTIAL", accountId: match.accountId, vaultId: match.vaultId, itemId: match.itemId,
      }).catch(() => ({ ok: false, matches: [] }));
      const fresh = response.matches?.[0];
      try {
        if (response.ok && fresh && fresh.accountId === match.accountId && generation === panelGeneration && !document.hidden) {
          fillInputs(fresh.username, fresh.password);
          removePanel();
        }
      } finally {
        for (const entry of response.matches ?? []) { entry.password = ""; entry.username = ""; }
      }
    };
    option.addEventListener("click", choose);
    options.push(option);
    panel.appendChild(option);
  });

  panel.addEventListener("keydown", (event) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusOption(activeIndex + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        focusOption(activeIndex - 1);
        break;
      case "Home":
        event.preventDefault();
        focusOption(0);
        break;
      case "End":
        event.preventDefault();
        focusOption(options.length - 1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        options[activeIndex]?.click();
        break;
      case "Escape":
        event.preventDefault();
        removePanel();
        activePasswordInput?.focus();
        break;
      default:
        break;
    }
  });

  // Combobox-style entry: pressing ArrowDown from the password field moves into
  // the panel; Escape dismisses it. We intentionally do not steal focus on
  // render so the user can keep typing their password uninterrupted.
  const field = activePasswordInput;
  if (field) {
    const onFieldKeydown = (event: KeyboardEvent): void => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        focusOption(0);
      } else if (event.key === "Escape") {
        removePanel();
      }
    };
    field.addEventListener("keydown", onFieldKeydown);
    panelCleanup = () => field.removeEventListener("keydown", onFieldKeydown);
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
  const generation = panelGeneration;
  const hostname = window.location.hostname;
  if (!hostname) {
    return;
  }

  const response = await sendBackgroundMessage<{ ok: boolean; matches: CredentialMatch[] }>({
    type: "GET_CREDENTIALS_FOR_HOST",
    hostname,
  });

  if (response.ok && generation === panelGeneration && !document.hidden) {
    // Ensure the stored locale has resolved before painting localized UI.
    await localeReady;
    if (generation === panelGeneration && !document.hidden) renderPanel(response.matches);
  }
}

document.addEventListener("visibilitychange", () => { if (document.hidden) removePanel(); });
window.addEventListener("pagehide", removePanel);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && STORAGE_KEYS.refreshToken in changes) removePanel();
});

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

      void showSaveBanner(String(title), username, password, url);
    },
    true,
  );
}

async function showSaveBanner(
  title: string,
  username: string,
  password: string,
  url: string,
): Promise<void> {
  if (document.getElementById(SAVE_BANNER_ID)) {
    return;
  }

  // Ensure the stored locale has resolved before painting localized UI.
  await localeReady;

  const banner = document.createElement("div");
  banner.id = SAVE_BANNER_ID;
  banner.setAttribute("role", "dialog");
  banner.setAttribute("aria-label", t("extension.saveBanner.prompt"));
  banner.tabIndex = -1;
  banner.style.cssText =
    "position:fixed;z-index:2147483646;bottom:16px;right:16px;max-width:320px;background:#0b1220;color:#e2e8f0;border:1px solid #334155;border-radius:12px;padding:12px;font:14px/1.4 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.35)";

  const text = document.createElement("p");
  text.textContent = t("extension.saveBanner.prompt");
  text.style.margin = "0 0 8px";
  banner.appendChild(text);

  const actions = document.createElement("div");
  actions.style.display = "flex";
  actions.style.gap = "8px";

  const saveButton = document.createElement("button");
  saveButton.type = "button";
  saveButton.textContent = t("extension.saveBanner.save");
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
  dismissButton.textContent = t("extension.saveBanner.dismiss");
  dismissButton.style.cssText =
    "flex:1;background:#1f2937;color:#e2e8f0;border:1px solid #334155;border-radius:8px;padding:8px;cursor:pointer";
  dismissButton.addEventListener("click", () => banner.remove());

  // Escape dismisses the banner for keyboard users.
  banner.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      banner.remove();
    }
  });

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
