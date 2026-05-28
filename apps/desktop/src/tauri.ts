import type { ConnectItem, ItemCategory, ItemFormValues } from "@shared/types/item";
import { emptyFormValues, formValuesFromItem, parseTagsInput } from "@shared/types/item";
import { invoke } from "@tauri-apps/api/core";

export type { ConnectItem, ItemCategory, ItemFormValues };

export async function getState(): Promise<"unlocked" | "locked"> {
  return invoke("get_state");
}

export async function createPasswordBox(path: string, masterPassword: string): Promise<string | null> {
  return invoke<string | null>("create_password_box", { path, masterPassword });
}

export async function openPasswordBox(path: string, masterPassword: string): Promise<void> {
  return invoke("open_password_box", { path, masterPassword });
}

export async function lockPasswordBox(): Promise<void> {
  return invoke("lock_password_box");
}

export async function listItems(): Promise<ConnectItem[]> {
  return invoke("list_items");
}

export async function searchItems(query: string): Promise<ConnectItem[]> {
  return invoke("search_items", { query });
}

export async function addItem(input: {
  values: ItemFormValues;
  masterPassword: string;
}): Promise<ConnectItem> {
  const { values, masterPassword } = input;
  return invoke("add_item", {
    category: values.category,
    title: values.title.trim(),
    password: values.password || null,
    url: values.url.trim() || null,
    username: values.username.trim() || null,
    notes: values.notes.trim() || null,
    body: values.body.trim() || null,
    tags: parseTagsInput(values.tags),
    favorite: values.favorite,
    masterPassword,
  });
}

export async function updateItem(input: {
  id: string;
  values: ItemFormValues;
  masterPassword: string;
}): Promise<ConnectItem> {
  const { id, values, masterPassword } = input;
  return invoke("update_item", {
    id,
    title: values.title.trim(),
    password: values.password || null,
    url: values.url.trim() || null,
    username: values.username.trim() || null,
    notes: values.notes.trim() || null,
    body: values.body.trim() || null,
    tags: parseTagsInput(values.tags),
    favorite: values.favorite,
    masterPassword,
  });
}

export async function deleteItem(id: string, masterPassword: string): Promise<void> {
  return invoke("delete_item", { id, masterPassword });
}

export async function importOnepasswordCsv(csvData: string, masterPassword: string): Promise<number> {
  return invoke("import_onepassword_csv", { csvData, masterPassword });
}

export async function exportOnepasswordCsv(): Promise<string> {
  return invoke("export_onepassword_csv");
}

export async function upsertSyncItem(input: {
  id: string;
  values: ItemFormValues;
  masterPassword: string;
}): Promise<ConnectItem> {
  const { id, values, masterPassword } = input;
  return invoke("upsert_sync_item", {
    id,
    category: values.category,
    title: values.title,
    password: values.password || null,
    url: values.url || null,
    username: values.username || null,
    notes: values.notes || null,
    body: values.body || null,
    tags: parseTagsInput(values.tags),
    favorite: values.favorite,
    masterPassword,
  });
}

export async function generatePassword(length = 16): Promise<string> {
  return invoke("generate_password", { length });
}

export { emptyFormValues, formValuesFromItem, parseTagsInput };
