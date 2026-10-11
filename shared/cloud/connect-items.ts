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

export function connectItemToCreateBody(values: ItemFormValues, original?: Item): Record<string, unknown> {
  const tags = original && values.tags === (original.tags ?? []).join(", ")
    ? original.tags ?? [] : parseTagsInput(values.tags);
  const fields: Array<Record<string, unknown>> = (original?.fields ?? []).map((field) => ({ ...field }));

  // Update only the fields exposed by the form. Imported fields, sections and
  // metadata must survive a title/password edit, including their original IDs.
  function updateField(label: string, value: string, purpose?: string) {
    const index = fields.findIndex((field) => purpose
      ? typeof field.purpose === "string" && field.purpose.toUpperCase() === purpose
      : typeof field.label === "string" && field.label.toLowerCase() === label);
    if (index >= 0) {
      fields[index] = { ...fields[index], value };
    } else if (value || !original) {
      fields.push({ label, type: purpose === "PASSWORD" ? "CONCEALED" : "STRING", ...(purpose ? { purpose } : {}), value });
    }
  }

  if (values.category === "LOGIN") {
    updateField("username", values.username, "USERNAME");
    updateField("password", values.password, "PASSWORD");
  } else if (values.category === "PASSWORD") {
    updateField("password", values.password, "PASSWORD");
  } else {
    const notesField = original?.fields?.find((field) => field.label.toLowerCase() === "notes");
    const bodyField = original?.fields?.find((field) => field.label.toLowerCase() === "body");
    const bodyLabel = notesField?.value || !bodyField ? "notes" : "body";
    updateField(bodyLabel, values.body);
  }

  if (values.category === "LOGIN" || values.category === "PASSWORD") {
    if (values.notes || original?.fields?.some((field) => field.label.toLowerCase() === "notes")) {
      updateField("notes", values.notes);
    }
  }

  const body: Record<string, unknown> = {
    ...original,
    title: values.title,
    category: values.category,
    fields,
    tags,
    favorite: values.favorite,
  };

  if (values.category === "LOGIN") {
    const urls = (original?.urls ?? []).map((url) => ({ ...url }));
    const primaryIndex = Math.max(0, urls.findIndex((url) => url.primary));
    if (values.url.trim()) {
      if (urls.length) urls[primaryIndex] = { ...urls[primaryIndex], href: values.url.trim() };
      else urls.push({ href: values.url.trim(), primary: true, label: "" });
    } else if (urls.length) {
      urls.splice(primaryIndex, 1);
    }
    body.urls = urls;
  }

  return body;
}
