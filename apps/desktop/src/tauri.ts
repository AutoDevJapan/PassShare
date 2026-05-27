import { invoke } from "@tauri-apps/api/core";
import type { LoginItem } from "./types";

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

export async function listItems(): Promise<LoginItem[]> {
  return invoke("list_items");
}

export async function searchItems(query: string): Promise<LoginItem[]> {
  return invoke("search_items", { query });
}

export async function addItem(input: {
  title: string;
  password: string;
  url: string | null;
  username: string | null;
  notes: string | null;
  masterPassword: string;
}): Promise<LoginItem> {
  return invoke("add_item", input);
}

export async function deleteItem(id: string, masterPassword: string): Promise<void> {
  return invoke("delete_item", { id, masterPassword });
}

export async function generatePassword(length = 16): Promise<string> {
  return invoke("generate_password", { length });
}
