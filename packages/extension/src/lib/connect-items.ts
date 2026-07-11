import type { Item } from "@passshare/connect";
import type { ConnectItem, ItemCategory, ItemFormValues } from "@shared/types/item.js";
import { parseTagsInput } from "@shared/types/item.js";

function fieldValue(item: Item, purpose?: string, label?: string): string {
  const fields = item.fields ?? [];
  const match = fields.find(
    (field) =>
      (purpose && field.purpose?.toUpperCase() === purpose) ||
      (label && field.label?.toLowerCase() === label.toLowerCase()),
  );
  return match?.value ?? "";
}

export function connectItemFromApi(item: Item): ConnectItem {
  const category = (item.category ?? "LOGIN") as ItemCategory;
  const primaryUrl = item.urls?.find((url) => url.primary) ?? item.urls?.[0];

  return {
    id: item.id,
    title: item.title,
    category,
    tags: item.tags ?? [],
    favorite: Boolean(item.favorite),
    url: primaryUrl?.href ?? null,
    username: fieldValue(item, "USERNAME"),
    password: fieldValue(item, "PASSWORD"),
    body: fieldValue(item, undefined, "notes") || fieldValue(item, undefined, "body"),
    notes: fieldValue(item, undefined, "notes"),
    revision: item.version,
    updatedAt: item.updatedAt ?? null,
  };
}

export function connectItemToCreateBody(values: ItemFormValues): Record<string, unknown> {
  const tags = parseTagsInput(values.tags);
  const fields: Array<Record<string, unknown>> = [];

  if (values.category === "LOGIN") {
    fields.push(
      { label: "username", type: "STRING", purpose: "USERNAME", value: values.username },
      { label: "password", type: "CONCEALED", purpose: "PASSWORD", value: values.password },
    );
  } else if (values.category === "PASSWORD") {
    fields.push({
      label: "password",
      type: "CONCEALED",
      purpose: "PASSWORD",
      value: values.password,
    });
  } else {
    fields.push({ label: "notes", type: "STRING", value: values.body });
  }

  if (values.notes && values.category !== "SECURE_NOTE") {
    fields.push({ label: "notes", type: "STRING", value: values.notes });
  }

  const body: Record<string, unknown> = {
    title: values.title,
    category: values.category,
    fields,
    tags,
    favorite: values.favorite,
  };

  if (values.category === "LOGIN" && values.url.trim()) {
    body.urls = [{ href: values.url.trim(), primary: true, label: "" }];
  }

  return body;
}

/** Match login items whose URL hostname equals or is a parent of the page hostname. */
export function hostnameMatchesItem(pageHostname: string, itemUrl: string | null | undefined): boolean {
  if (!itemUrl) {
    return false;
  }
  try {
    const itemHost = new URL(itemUrl).hostname.replace(/^www\./, "");
    const pageHost = pageHostname.replace(/^www\./, "");
    return pageHost === itemHost || pageHost.endsWith(`.${itemHost}`);
  } catch {
    return false;
  }
}

/**
 * Whether autofill/save may run on a page with the given location.
 *
 * Allowed on HTTPS everywhere; on plain HTTP only for loopback development
 * hosts. Credentials must never be filled into or captured from an insecure
 * public page.
 */
export function isAutofillAllowed(protocol: string, hostname: string): boolean {
  if (protocol === "https:") {
    return true;
  }
  if (protocol === "http:") {
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  }
  return false;
}

export function findUsernameInput(form: HTMLFormElement | Document): HTMLInputElement | null {
  const selectors = [
    'input[autocomplete="username"]',
    'input[type="email"]',
    'input[name*="user" i]',
    'input[name*="login" i]',
    'input[name*="email" i]',
    'input[id*="user" i]',
    'input[id*="email" i]',
  ];
  for (const selector of selectors) {
    const input = form.querySelector<HTMLInputElement>(selector);
    if (input && input.type !== "password") {
      return input;
    }
  }
  return null;
}

export function findPasswordInput(form: HTMLFormElement | Document): HTMLInputElement | null {
  return form.querySelector<HTMLInputElement>('input[type="password"]');
}
